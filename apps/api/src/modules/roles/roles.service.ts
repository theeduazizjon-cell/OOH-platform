import { Injectable } from '@nestjs/common';
import {
  type CreateRoleRequest,
  isPermissionKey,
  type Page,
  type RoleDetail,
  type RoleGrant,
  type RoleListItem,
  type UpdateRoleRequest,
  validateGrants,
} from '@ooh/contracts';
import { membership, membershipRole, role, rolePermission, type Transaction } from '@ooh/db';
import { asc, eq, inArray, like, type SQL, sql } from 'drizzle-orm';
import { AuditService } from '../../core/audit/audit.service';
import { AccessService } from '../../core/auth/access.service';
import { type Principal } from '../../core/auth/principal';
import { DatabaseService } from '../../core/database/database.service';
import { AppError } from '../../core/http/app-error';
import { type ClientInfo } from '../../core/http/client-info';
import { assertIfMatch, type IfMatch } from '../../core/http/concurrency';
import { assertHoldsGrants } from '../memberships/role-assignment';

/**
 * A tenant must always keep at least one active member who can manage roles and users, otherwise
 * nobody could repair its access configuration (and there is no self-service recovery).
 */
const ADMIN_CAPABILITY = ['roles.manage', 'users.update'] as const;

/** Custom role keys never collide with system template keys (which provisioning upserts by key). */
const CUSTOM_KEY_PREFIX = 'custom_';

const MORE_THAN_YOU_HOLD = 'This role has permissions you do not have, so you cannot change it.';
const GRANTING_MORE = 'You cannot grant permissions you do not have yourself.';

@Injectable()
export class RolesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * All roles of the current tenant (RLS scopes the query). A tenant has a bounded number of roles
   * (the system templates plus its own), so they are returned in a single page.
   */
  list(principal: Principal): Promise<Page<RoleListItem>> {
    return this.inTenant(principal, async (tx) => ({
      data: await this.loadItems(tx),
      page: { nextCursor: null, hasMore: false },
    }));
  }

  get(principal: Principal, roleId: string): Promise<RoleDetail> {
    return this.inTenant(principal, (tx) => this.loadDetail(tx, roleId));
  }

  async create(principal: Principal, input: CreateRoleRequest, client: ClientInfo): Promise<RoleDetail> {
    assertValidGrants(input.grants, false);
    assertHoldsGrants(principal, input.grants, GRANTING_MORE);
    return this.inTenant(principal, async (tx) => {
      const key = await this.freeKey(tx, input.name);
      const [created] = await tx
        .insert(role)
        .values({
          tenantId: principal.tenantId,
          key,
          name: input.name,
          description: input.description ?? null,
          isSystem: false,
          isExternal: false,
        })
        .onConflictDoNothing({ target: [role.tenantId, role.key] })
        .returning({ id: role.id });
      // Only possible when two admins create a same-named role at the same instant.
      if (!created)
        throw new AppError('CONFLICT', 'A role with this name was just created. Please try again.');
      await this.insertGrants(tx, principal.tenantId, created.id, input.grants);
      await this.audit.record(tx, {
        ...this.actor(principal, client),
        action: 'role.created',
        subjectType: 'role',
        subjectId: created.id,
        metadata: { key, name: input.name, grants: sortedGrantKeys(input.grants) },
      });
      return this.loadDetail(tx, created.id);
    });
  }

  /**
   * System roles accept `active` only: their definition comes from the code templates and is
   * refreshed by provisioning, so edits would be lost (OPD-27). Duplicate one to customise it.
   */
  async update(
    principal: Principal,
    roleId: string,
    input: UpdateRoleRequest,
    ifMatch: IfMatch,
    client: ClientInfo,
  ): Promise<RoleDetail> {
    let accessChanged = false;
    const detail = await this.inTenant(principal, async (tx) => {
      const current = await this.lockDetail(tx, roleId);
      const editsDefinition =
        input.name !== undefined || input.description !== undefined || input.grants !== undefined;
      if (current.isSystem && editsDefinition) {
        throw new AppError(
          'CONFLICT',
          'System roles can’t be edited, only enabled or disabled. Duplicate it to create a custom role you can change.',
        );
      }
      assertHoldsGrants(principal, current.grants, MORE_THAN_YOU_HOLD);
      if (input.grants) {
        assertValidGrants(input.grants, current.isExternal);
        assertHoldsGrants(principal, input.grants, GRANTING_MORE);
      }
      assertIfMatch(ifMatch, current.version);

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (input.name !== undefined && input.name !== current.name)
        changes.name = { from: current.name, to: input.name };
      if (input.description !== undefined && input.description !== current.description)
        changes.description = { from: current.description, to: input.description };
      if (input.active !== undefined && input.active !== current.active)
        changes.active = { from: current.active, to: input.active };
      const grantsFrom = sortedGrantKeys(current.grants);
      const grantsTo = input.grants ? sortedGrantKeys(input.grants) : grantsFrom;
      if (grantsFrom.join() !== grantsTo.join()) changes.grants = { from: grantsFrom, to: grantsTo };
      if (Object.keys(changes).length === 0) return current;

      await tx
        .update(role)
        .set({
          ...(changes.name ? { name: input.name } : {}),
          ...(changes.description ? { description: input.description } : {}),
          ...(changes.active ? { active: input.active } : {}),
          version: sql`${role.version} + 1`,
        })
        .where(eq(role.id, roleId));
      if (changes.grants) {
        await tx.delete(rolePermission).where(eq(rolePermission.roleId, roleId));
        await this.insertGrants(tx, principal.tenantId, roleId, input.grants!);
      }
      if (changes.grants || changes.active) {
        accessChanged = true;
        await this.retireMemberTokens(tx, roleId);
        await this.assertAdminRemains(tx);
      }
      await this.audit.record(tx, {
        ...this.actor(principal, client),
        action: 'role.updated',
        subjectType: 'role',
        subjectId: roleId,
        changes,
      });
      return this.loadDetail(tx, roleId);
    });
    // Immediate in this process; other API processes follow within AccessService's cache TTL.
    if (accessChanged) this.access.invalidateTenant(principal.tenantId);
    return detail;
  }

  /** Only unused custom roles can be deleted (system roles are disabled instead). */
  async remove(principal: Principal, roleId: string, ifMatch: IfMatch, client: ClientInfo): Promise<void> {
    await this.inTenant(principal, async (tx) => {
      const current = await this.lockDetail(tx, roleId);
      if (current.isSystem) {
        throw new AppError('CONFLICT', 'System roles can’t be deleted. Disable it instead.');
      }
      assertHoldsGrants(principal, current.grants, MORE_THAN_YOU_HOLD);
      if (current.memberCount > 0) {
        throw new AppError(
          'CONFLICT',
          `This role is assigned to ${current.memberCount} member(s). Give them other roles first.`,
          { meta: { memberCount: current.memberCount } },
        );
      }
      assertIfMatch(ifMatch, current.version);
      await tx.delete(role).where(eq(role.id, roleId)); // role_permission rows cascade
      await this.audit.record(tx, {
        ...this.actor(principal, client),
        action: 'role.deleted',
        subjectType: 'role',
        subjectId: roleId,
        metadata: { key: current.key, name: current.name },
      });
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private inTenant<T>(principal: Principal, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.database.withTenant({ tenantId: principal.tenantId, actorUserId: principal.userId }, fn);
  }

  private actor(principal: Principal, client: ClientInfo) {
    return {
      tenantId: principal.tenantId,
      actorType: 'USER' as const,
      actorUserId: principal.userId,
      actorMembershipId: principal.membershipId,
      client,
    };
  }

  private async lockDetail(tx: Transaction, roleId: string): Promise<RoleDetail> {
    const [locked] = await tx.select({ id: role.id }).from(role).where(eq(role.id, roleId)).for('update');
    if (!locked) throw new AppError('NOT_FOUND', 'Role not found.');
    return this.loadDetail(tx, roleId);
  }

  private async loadDetail(tx: Transaction, roleId: string): Promise<RoleDetail> {
    const [item] = await this.loadItems(tx, eq(role.id, roleId));
    if (!item) throw new AppError('NOT_FOUND', 'Role not found.');
    const grants = await tx
      .select({ permission: rolePermission.permissionKey, scope: rolePermission.scope })
      .from(rolePermission)
      .where(eq(rolePermission.roleId, roleId))
      .orderBy(asc(rolePermission.permissionKey));
    return {
      ...item,
      // Keys no longer in the catalog grant nothing (AccessService ignores them); don't surface them.
      grants: grants.filter((g): g is RoleGrant => isPermissionKey(g.permission)),
    };
  }

  private loadItems(tx: Transaction, where?: SQL): Promise<RoleListItem[]> {
    return tx
      .select({
        id: role.id,
        key: role.key,
        name: role.name,
        description: role.description,
        isSystem: role.isSystem,
        isExternal: role.isExternal,
        active: role.active,
        // Written out in full: inside a select, drizzle renders ${role.id} unqualified ("id"), which
        // the subquery would resolve to m.id instead of the outer role.
        memberCount: sql<number>`(
          SELECT count(*)::int FROM membership_role mr
          JOIN membership m ON m.tenant_id = mr.tenant_id AND m.id = mr.membership_id
          WHERE mr.role_id = "role"."id" AND m.archived_at IS NULL)`,
        version: role.version,
      })
      .from(role)
      .where(where)
      .orderBy(asc(role.isExternal), asc(role.name));
  }

  private insertGrants(
    tx: Transaction,
    tenantId: string,
    roleId: string,
    grants: CreateRoleRequest['grants'],
  ) {
    return tx
      .insert(rolePermission)
      .values(grants.map((g) => ({ tenantId, roleId, permissionKey: g.permission, scope: g.scope })));
  }

  /** `custom_<slug of name>`, suffixed `_2`, `_3`… when taken. */
  private async freeKey(tx: Transaction, name: string): Promise<string> {
    const slug = name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40);
    const base = `${CUSTOM_KEY_PREFIX}${slug || 'role'}`;
    const taken = new Set(
      (
        await tx
          .select({ key: role.key })
          .from(role)
          .where(like(role.key, `${base}%`))
      ).map((r) => r.key),
    );
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
  }

  /** The role's members must refresh their tokens: their effective permissions just changed. */
  private async retireMemberTokens(tx: Transaction, roleId: string): Promise<void> {
    const holders = tx
      .select({ id: membershipRole.membershipId })
      .from(membershipRole)
      .where(eq(membershipRole.roleId, roleId));
    await tx
      .update(membership)
      .set({ permsVersion: sql`${membership.permsVersion} + 1` })
      .where(inArray(membership.id, holders));
  }

  private async assertAdminRemains(tx: Transaction): Promise<void> {
    const [row] = await tx.execute<{ admins: number }>(sql`
      SELECT count(*)::int AS admins
      FROM membership m
      WHERE m.status = 'ACTIVE' AND m.archived_at IS NULL
        AND (SELECT count(DISTINCT rp.permission_key)
             FROM membership_role mr
             JOIN role r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id AND r.active
             JOIN role_permission rp ON rp.role_id = r.id
             WHERE mr.membership_id = m.id
               AND rp.permission_key IN (${sql.join(
                 ADMIN_CAPABILITY.map((key) => sql`${key}`),
                 sql`, `,
               )})) = ${ADMIN_CAPABILITY.length}`);
    if (!row || row.admins === 0) {
      throw new AppError(
        'CONFLICT',
        'This change would leave nobody able to manage roles and users. Keep at least one active administrator.',
        { meta: { requiredPermissions: ADMIN_CAPABILITY } },
      );
    }
  }
}

function assertValidGrants(grants: CreateRoleRequest['grants'], external: boolean): void {
  const violations = validateGrants(grants, { external });
  if (violations.length > 0) {
    throw new AppError('VALIDATION_FAILED', 'Some permissions can’t be granted like this.', {
      errors: violations.map((v) => ({ path: 'grants', message: `${v.permission}: ${v.reason}` })),
    });
  }
}

function sortedGrantKeys(grants: readonly { permission: string; scope: string }[]): string[] {
  return grants.map((g) => `${g.permission}@${g.scope}`).sort();
}
