import { Injectable } from '@nestjs/common';
import type { MembershipListItem, Page, PageQuery, SetMemberRolesRequest } from '@ooh/contracts';
import { appUser, invitation, membership, membershipRole, role, type Transaction } from '@ooh/db';
import { and, asc, eq, gt, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { AuditService } from '../../core/audit/audit.service';
import { AccessService } from '../../core/auth/access.service';
import { type Principal } from '../../core/auth/principal';
import { DatabaseService } from '../../core/database/database.service';
import { AppError } from '../../core/http/app-error';
import { type ClientInfo } from '../../core/http/client-info';
import { decodeIdCursor, encodeIdCursor } from '../../core/http/cursor';
import { assertCanManageMember, loadAssignableRoles } from './role-assignment';

type MembershipStatus = MembershipListItem['status'];

@Injectable()
export class MembershipsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  /** No tenant filter in the query: RLS scopes it to the principal's tenant. */
  list(principal: Principal, query: PageQuery): Promise<Page<MembershipListItem>> {
    const after = query.cursor ? decodeIdCursor(query.cursor) : undefined;
    return this.inTenant(principal, async (tx) => {
      const rows = await this.loadItems(
        tx,
        and(isNull(membership.archivedAt), after ? gt(membership.id, after) : undefined),
        query.limit + 1,
      );
      const hasMore = rows.length > query.limit;
      const data = rows.slice(0, query.limit);
      return { data, page: { nextCursor: hasMore ? encodeIdCursor(data.at(-1)!.id) : null, hasMore } };
    });
  }

  suspend(principal: Principal, membershipId: string, client: ClientInfo): Promise<MembershipListItem> {
    return this.transition(principal, membershipId, client, {
      from: 'ACTIVE',
      to: 'SUSPENDED',
      action: 'membership.suspended',
      refusal: 'Only active members can be suspended.',
    });
  }

  reactivate(principal: Principal, membershipId: string, client: ClientInfo): Promise<MembershipListItem> {
    return this.transition(principal, membershipId, client, {
      from: 'SUSPENDED',
      to: 'ACTIVE',
      action: 'membership.reactivated',
      refusal: 'Only suspended members can be reactivated.',
    });
  }

  /**
   * Replaces the member's roles. Bumps perms_version, so the member's access tokens stop working and
   * their app refreshes into the new permissions (see AuthGuard).
   */
  async setRoles(
    principal: Principal,
    membershipId: string,
    input: SetMemberRolesRequest,
    client: ClientInfo,
  ): Promise<MembershipListItem> {
    let affectedUserId: string | undefined;
    const item = await this.inTenant(principal, async (tx) => {
      const target = await this.lockManageable(tx, principal, membershipId, 'change your own roles');
      affectedUserId = target.userId;
      const roles = await loadAssignableRoles(tx, principal, input.roleIds);

      const before = await this.loadItem(tx, membershipId);
      const fromKeys = before.roles.map((r) => r.key).sort();
      const toKeys = roles.map((r) => r.key).sort();
      if (fromKeys.join() === toKeys.join()) return before; // no change: keep sessions untouched

      await tx.delete(membershipRole).where(eq(membershipRole.membershipId, membershipId));
      await tx
        .insert(membershipRole)
        .values(roles.map((r) => ({ tenantId: principal.tenantId, membershipId, roleId: r.id })));
      await tx
        .update(membership)
        .set({ permsVersion: sql`${membership.permsVersion} + 1` })
        .where(eq(membership.id, membershipId));
      await this.audit.record(tx, {
        tenantId: principal.tenantId,
        actorType: 'USER',
        actorUserId: principal.userId,
        actorMembershipId: principal.membershipId,
        action: 'membership.roles_changed',
        subjectType: 'membership',
        subjectId: membershipId,
        changes: { roles: { from: fromKeys, to: toKeys } },
        client,
      });
      return this.loadItem(tx, membershipId);
    });
    if (affectedUserId) this.access.invalidate(principal.tenantId, affectedUserId);
    return item;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async transition(
    principal: Principal,
    membershipId: string,
    client: ClientInfo,
    rule: { from: MembershipStatus; to: MembershipStatus; action: string; refusal: string },
  ): Promise<MembershipListItem> {
    let affectedUserId: string | undefined;
    const item = await this.inTenant(principal, async (tx) => {
      const target = await this.lockManageable(tx, principal, membershipId, 'suspend or reactivate yourself');
      affectedUserId = target.userId;
      if (target.status !== rule.from) {
        throw new AppError('INVALID_TRANSITION', rule.refusal, { meta: { status: target.status } });
      }
      // The version bump also retires access tokens issued before a suspension, so reactivating
      // never revives an old token.
      await tx
        .update(membership)
        .set({ status: rule.to, permsVersion: sql`${membership.permsVersion} + 1` })
        .where(eq(membership.id, membershipId));
      await this.audit.record(tx, {
        tenantId: principal.tenantId,
        actorType: 'USER',
        actorUserId: principal.userId,
        actorMembershipId: principal.membershipId,
        action: rule.action,
        subjectType: 'membership',
        subjectId: membershipId,
        changes: { status: { from: rule.from, to: rule.to } },
        client,
      });
      return this.loadItem(tx, membershipId);
    });
    // Immediate in this process; other API processes follow within AccessService's cache TTL.
    if (affectedUserId) this.access.invalidate(principal.tenantId, affectedUserId);
    return item;
  }

  /**
   * Locks the target membership and applies the guardrails shared by every management action:
   * it exists in this tenant, it isn't the actor (no self-lockout or self-escalation), and the
   * actor holds every permission the member currently has.
   */
  private async lockManageable(
    tx: Transaction,
    principal: Principal,
    membershipId: string,
    selfAction: string,
  ): Promise<{ userId: string; status: MembershipStatus }> {
    const [target] = await tx
      .select({ id: membership.id, userId: membership.userId, status: membership.status })
      .from(membership)
      .where(and(eq(membership.id, membershipId), isNull(membership.archivedAt)))
      .for('update');
    if (!target) throw new AppError('NOT_FOUND', 'Member not found.');
    if (target.id === principal.membershipId) {
      throw new AppError('FORBIDDEN', `You cannot ${selfAction}. Ask another administrator.`);
    }
    await assertCanManageMember(tx, principal, membershipId);
    return target;
  }

  private inTenant<T>(principal: Principal, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.database.withTenant({ tenantId: principal.tenantId, actorUserId: principal.userId }, fn);
  }

  private async loadItem(tx: Transaction, membershipId: string): Promise<MembershipListItem> {
    const [item] = await this.loadItems(tx, eq(membership.id, membershipId), 1);
    if (!item) throw new AppError('NOT_FOUND', 'Member not found.');
    return item;
  }

  /** Members with their roles and pending invitation, ordered by id (cursor order). */
  private async loadItems(
    tx: Transaction,
    where: SQL | undefined,
    limit: number,
  ): Promise<MembershipListItem[]> {
    const rows = await tx
      .select({
        id: membership.id,
        userId: membership.userId,
        displayName: appUser.displayName,
        email: appUser.email,
        kind: membership.kind,
        status: membership.status,
        invitationExpiresAt: invitation.expiresAt,
      })
      .from(membership)
      .innerJoin(appUser, eq(appUser.id, membership.userId))
      // At most one pending invitation per membership (partial unique index), so no duplicates.
      .leftJoin(
        invitation,
        and(
          eq(invitation.tenantId, membership.tenantId),
          eq(invitation.membershipId, membership.id),
          isNull(invitation.acceptedAt),
          isNull(invitation.revokedAt),
        ),
      )
      .where(where)
      .orderBy(asc(membership.id))
      .limit(limit);

    const roleRows = rows.length
      ? await tx
          .select({ membershipId: membershipRole.membershipId, id: role.id, key: role.key, name: role.name })
          .from(membershipRole)
          .innerJoin(
            role,
            and(eq(role.tenantId, membershipRole.tenantId), eq(role.id, membershipRole.roleId)),
          )
          .where(
            inArray(
              membershipRole.membershipId,
              rows.map((r) => r.id),
            ),
          )
          .orderBy(asc(role.name))
      : [];

    return rows.map(({ invitationExpiresAt, ...row }) => ({
      ...row,
      invitation: invitationExpiresAt ? { expiresAt: invitationExpiresAt.toISOString() } : null,
      roles: roleRows
        .filter((r) => r.membershipId === row.id)
        .map(({ id, key, name }) => ({ id, key, name })),
    }));
  }
}
