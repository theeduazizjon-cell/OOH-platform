import { Injectable, Logger } from '@nestjs/common';
import {
  isPermissionKey,
  PERMISSIONS,
  type PermissionDefinition,
  type PermissionKey,
  type PermissionScope,
} from '@ooh/contracts';
import { membership, membershipRole, role, rolePermission, tenant, type Transaction } from '@ooh/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';

export interface MembershipAccess {
  readonly membershipId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly kind: 'INTERNAL' | 'EXTERNAL';
  readonly permsVersion: number;
  readonly roles: readonly { key: string; name: string }[];
  readonly permissions: ReadonlyMap<PermissionKey, PermissionScope>;
}

/** Broader scope wins when several roles grant the same permission. */
const SCOPE_RANK: Record<PermissionScope, number> = { ALL: 4, ORGANISATION: 3, ASSIGNED: 2, OWN: 1 };

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 10_000;

/**
 * Resolves what a user may do in a tenant: active membership + roles → effective permissions.
 * Cached briefly per process, so a suspension or role change takes effect within CACHE_TTL_MS;
 * a perms_version bump invalidates issued access tokens at the next cache refresh.
 */
@Injectable()
export class AccessService {
  private readonly logger = new Logger(AccessService.name);
  private readonly cache = new Map<string, { value: MembershipAccess | null; expiresAt: number }>();

  constructor(private readonly database: DatabaseService) {}

  /** Returns null when the user has no ACTIVE membership in an ACTIVE tenant. */
  async resolve(
    tenantId: string,
    userId: string,
    options: { fresh?: boolean } = {},
  ): Promise<MembershipAccess | null> {
    const key = `${tenantId}:${userId}`;
    const cached = this.cache.get(key);
    if (!options.fresh && cached && cached.expiresAt > Date.now()) return cached.value;

    const value = await this.database.withTenant({ tenantId, actorUserId: userId }, (tx) =>
      this.load(tx, userId),
    );
    if (this.cache.size >= CACHE_MAX_ENTRIES) this.cache.clear();
    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }

  invalidate(tenantId: string, userId: string): void {
    this.cache.delete(`${tenantId}:${userId}`);
  }

  /** Loads inside an existing tenant transaction (RLS already scopes every query to the tenant). */
  async load(tx: Transaction, userId: string): Promise<MembershipAccess | null> {
    const [member] = await tx
      .select({
        id: membership.id,
        tenantId: membership.tenantId,
        kind: membership.kind,
        permsVersion: membership.permsVersion,
      })
      .from(membership)
      .innerJoin(tenant, eq(tenant.id, membership.tenantId))
      .where(
        and(
          eq(membership.userId, userId),
          eq(membership.status, 'ACTIVE'),
          isNull(membership.archivedAt),
          eq(tenant.status, 'ACTIVE'),
        ),
      );
    if (!member) return null;

    const roles = await tx
      .select({ id: role.id, key: role.key, name: role.name })
      .from(membershipRole)
      .innerJoin(role, and(eq(role.tenantId, membershipRole.tenantId), eq(role.id, membershipRole.roleId)))
      .where(and(eq(membershipRole.membershipId, member.id), eq(role.active, true)));

    const grants = roles.length
      ? await tx
          .select({ permission: rolePermission.permissionKey, scope: rolePermission.scope })
          .from(rolePermission)
          .where(
            inArray(
              rolePermission.roleId,
              roles.map((r) => r.id),
            ),
          )
      : [];

    const permissions = new Map<PermissionKey, PermissionScope>();
    for (const grant of grants) {
      if (!isPermissionKey(grant.permission)) {
        this.logger.warn(`Ignoring unknown permission "${grant.permission}" (not in catalog)`);
        continue;
      }
      // Defence in depth: external members never get internal-only permissions, whatever the role says.
      if (member.kind === 'EXTERNAL' && (PERMISSIONS[grant.permission] as PermissionDefinition).internalOnly)
        continue;
      const current = permissions.get(grant.permission);
      if (!current || SCOPE_RANK[grant.scope] > SCOPE_RANK[current])
        permissions.set(grant.permission, grant.scope);
    }

    return {
      membershipId: member.id,
      tenantId: member.tenantId,
      userId,
      kind: member.kind,
      permsVersion: member.permsVersion,
      roles: roles.map(({ key, name }) => ({ key, name })),
      permissions,
    };
  }
}
