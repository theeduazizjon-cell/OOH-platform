import { Injectable } from '@nestjs/common';
import {
  type AcceptInvitationRequest,
  INVITATION_TTL_DAYS,
  type InvitationPreview,
  type InviteMemberRequest,
  type InviteMemberResponse,
  type IssuedInvitation,
  isPermissionKey,
  type PermissionScope,
} from '@ooh/contracts';
import {
  appUser,
  invitation,
  membership,
  membershipRole,
  role,
  rolePermission,
  type Transaction,
} from '@ooh/db';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { AuditService } from '../../core/audit/audit.service';
import { AccessService, SCOPE_RANK } from '../../core/auth/access.service';
import { LoginThrottle } from '../../core/auth/login-throttle';
import { PasswordService } from '../../core/auth/password.service';
import { type Principal } from '../../core/auth/principal';
import { TokenService } from '../../core/auth/token.service';
import { DatabaseService } from '../../core/database/database.service';
import { AppError } from '../../core/http/app-error';
import { type ClientInfo } from '../../core/http/client-info';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

const INVALID_INVITATION = () =>
  new AppError('INVITATION_INVALID', 'This invitation link is invalid, has expired or was already used.');

/** Columns returned by the auth_find_invitation() database function. */
type FoundInvitation = {
  tenant_id: string;
  tenant_name: string;
  tenant_status: 'ACTIVE' | 'SUSPENDED';
  membership_id: string;
  membership_status: 'INVITED' | 'ACTIVE' | 'SUSPENDED';
  user_id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  expires_at: string | Date;
  accepted_at: string | Date | null;
  revoked_at: string | Date | null;
};

/** Who accepted, so the caller can sign them in. */
export interface AcceptedInvitation {
  readonly userId: string;
  readonly tenantId: string;
}

/**
 * Invitations: an admin invites an email with roles, which creates an INVITED membership plus a
 * one-time link `<invitationId>.<secret>`. Accepting activates the membership. Only SHA-256(secret)
 * is stored. Delivery of the link is the caller's concern (for now the admin shares it).
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly throttle: LoginThrottle,
    private readonly audit: AuditService,
  ) {}

  async invite(
    principal: Principal,
    input: InviteMemberRequest,
    client: ClientInfo,
  ): Promise<InviteMemberResponse> {
    return this.database.withTenant(
      { tenantId: principal.tenantId, actorUserId: principal.userId },
      async (tx) => {
        const roles = await this.loadAssignableRoles(tx, principal, input.roleIds);

        const [ensured] = await tx.execute<{ id: string | null }>(
          sql`SELECT invitation_ensure_user(${input.email}, ${input.displayName}) AS id`,
        );
        const userId = ensured?.id;
        if (!userId) throw new AppError('CONFLICT', 'This email belongs to a deactivated account.');

        const [created] = await tx
          .insert(membership)
          .values({ tenantId: principal.tenantId, userId, kind: 'INTERNAL', status: 'INVITED' })
          .onConflictDoNothing({ target: [membership.tenantId, membership.userId] })
          .returning({ id: membership.id });
        if (!created) {
          const [existing] = await tx
            .select({ id: membership.id, status: membership.status })
            .from(membership)
            .where(eq(membership.userId, userId));
          throw new AppError(
            'CONFLICT',
            existing?.status === 'INVITED'
              ? 'This person has already been invited. Resend the invitation instead.'
              : 'This person is already a member of the company.',
            { meta: { membershipId: existing?.id, status: existing?.status } },
          );
        }

        await tx
          .insert(membershipRole)
          .values(
            roles.map((r) => ({ tenantId: principal.tenantId, membershipId: created.id, roleId: r.id })),
          );
        const issued = await this.issue(tx, principal, created.id, input.email);

        const [user] = await tx
          .select({ displayName: appUser.displayName, email: appUser.email })
          .from(appUser)
          .where(eq(appUser.id, userId));
        await this.audit.record(tx, {
          tenantId: principal.tenantId,
          actorType: 'USER',
          actorUserId: principal.userId,
          actorMembershipId: principal.membershipId,
          action: 'membership.invited',
          subjectType: 'membership',
          subjectId: created.id,
          metadata: { email: input.email.toLowerCase(), roles: roles.map((r) => r.key) },
          client,
        });

        return {
          membership: {
            id: created.id,
            userId,
            displayName: user?.displayName ?? input.displayName,
            email: user?.email ?? input.email,
            kind: 'INTERNAL',
            status: 'INVITED',
            roles: roles.map(({ key, name }) => ({ key, name })),
            invitation: { expiresAt: issued.expiresAt },
          },
          invitation: issued,
        };
      },
    );
  }

  /** Revokes the pending link (if any) and issues a new one with a fresh expiry. */
  async resend(principal: Principal, membershipId: string, client: ClientInfo): Promise<IssuedInvitation> {
    return this.database.withTenant(
      { tenantId: principal.tenantId, actorUserId: principal.userId },
      async (tx) => {
        const member = await this.lockInvitedMembership(tx, membershipId);
        await this.revokePending(tx, membershipId);
        const issued = await this.issue(tx, principal, membershipId, member.email);
        await this.audit.record(tx, {
          tenantId: principal.tenantId,
          actorType: 'USER',
          actorUserId: principal.userId,
          actorMembershipId: principal.membershipId,
          action: 'membership.invitation_resent',
          subjectType: 'membership',
          subjectId: membershipId,
          client,
        });
        return issued;
      },
    );
  }

  /** Withdraws an invitation that was never accepted: the INVITED membership is removed entirely. */
  async cancel(principal: Principal, membershipId: string, client: ClientInfo): Promise<void> {
    await this.database.withTenant(
      { tenantId: principal.tenantId, actorUserId: principal.userId },
      async (tx) => {
        const member = await this.lockInvitedMembership(tx, membershipId);
        // Cascades to membership_role and invitation rows.
        await tx.delete(membership).where(eq(membership.id, membershipId));
        await this.audit.record(tx, {
          tenantId: principal.tenantId,
          actorType: 'USER',
          actorUserId: principal.userId,
          actorMembershipId: principal.membershipId,
          action: 'membership.invitation_cancelled',
          subjectType: 'membership',
          subjectId: membershipId,
          metadata: { email: member.email.toLowerCase() },
          client,
        });
      },
    );
  }

  async preview(token: string): Promise<InvitationPreview> {
    const found = await this.findValid(token);
    return {
      email: found.email,
      displayName: found.display_name,
      tenantName: found.tenant_name,
      hasAccount: found.password_hash !== null,
      expiresAt: new Date(found.expires_at).toISOString(),
    };
  }

  /**
   * New account: sets the password. Existing account: requires its current password, so a leaked
   * link alone can never take over an account (which may reach other tenants).
   */
  async accept(
    token: string,
    input: AcceptInvitationRequest,
    client: ClientInfo,
  ): Promise<AcceptedInvitation> {
    const found = await this.findValid(token);
    const hasAccount = found.password_hash !== null;

    let newPasswordHash: string | null = null;
    if (hasAccount) {
      await this.throttle.assertAllowed(found.email, client.ip);
      if (!(await this.passwords.verify(found.password_hash, input.password))) {
        await this.throttle.recordFailure(found.email, client.ip);
        throw new AppError('INVALID_CREDENTIALS', 'Incorrect password for this account.');
      }
      await this.throttle.recordSuccess(found.email);
    } else {
      newPasswordHash = await this.passwords.hash(input.password);
    }

    const tenantId = found.tenant_id;
    const userId = found.user_id;
    await this.database.withTenant({ tenantId, actorUserId: userId }, async (tx) => {
      // Claim atomically: a concurrent second accept (or a revoke) makes this match nothing.
      const [claimed] = await tx
        .update(invitation)
        .set({ acceptedAt: new Date() })
        .where(
          and(
            eq(invitation.id, parseInvitationToken(token)!.invitationId),
            isNull(invitation.acceptedAt),
            isNull(invitation.revokedAt),
            gt(invitation.expiresAt, new Date()),
          ),
        )
        .returning({ id: invitation.id });
      if (!claimed) throw INVALID_INVITATION();

      const [activated] = await tx
        .update(membership)
        .set({ status: 'ACTIVE' })
        .where(and(eq(membership.id, found.membership_id), eq(membership.status, 'INVITED')))
        .returning({ id: membership.id });
      if (!activated) throw INVALID_INVITATION();

      if (newPasswordHash) {
        // Allowed by the app_user_update_self policy (the acting user is the invitee).
        const [updated] = await tx
          .update(appUser)
          .set({
            passwordHash: newPasswordHash,
            ...(input.displayName ? { displayName: input.displayName } : {}),
          })
          .where(and(eq(appUser.id, userId), isNull(appUser.passwordHash)))
          .returning({ id: appUser.id });
        // Someone set a password in between (e.g. accepted another company's invitation): retry.
        if (!updated) throw new AppError('CONFLICT', 'This account was just activated. Please try again.');
      }

      await this.audit.record(tx, {
        tenantId,
        actorType: 'USER',
        actorUserId: userId,
        actorMembershipId: found.membership_id,
        action: 'membership.invitation_accepted',
        subjectType: 'membership',
        subjectId: found.membership_id,
        metadata: { newAccount: !hasAccount },
        client,
      });
    });
    this.access.invalidate(tenantId, userId);
    return { userId, tenantId };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Roles must exist in this tenant, be active and internal (external members need an organisation,
   * which arrives with the CRM), and grant nothing beyond what the inviter holds (no escalation).
   */
  private async loadAssignableRoles(tx: Transaction, principal: Principal, roleIds: readonly string[]) {
    const roles = await tx
      .select({
        id: role.id,
        key: role.key,
        name: role.name,
        active: role.active,
        isExternal: role.isExternal,
      })
      .from(role)
      .where(inArray(role.id, [...roleIds]));
    if (roles.length !== roleIds.length || roles.some((r) => !r.active)) {
      throw new AppError('VALIDATION_FAILED', 'Unknown or disabled role.', {
        errors: [{ path: 'roleIds', message: 'Unknown or disabled role' }],
      });
    }
    if (roles.some((r) => r.isExternal)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'External roles can be assigned once organisations are available.',
        {
          errors: [{ path: 'roleIds', message: 'External roles are not supported yet' }],
        },
      );
    }

    const grants = await tx
      .select({ permission: rolePermission.permissionKey, scope: rolePermission.scope })
      .from(rolePermission)
      .where(inArray(rolePermission.roleId, [...roleIds]));
    const exceeding = grants.filter((grant) => !holds(principal, grant.permission, grant.scope));
    if (exceeding.length > 0) {
      throw new AppError('FORBIDDEN', 'You cannot grant permissions you do not have yourself.', {
        meta: { permissions: [...new Set(exceeding.map((g) => g.permission))].sort() },
      });
    }
    return roles.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async lockInvitedMembership(tx: Transaction, membershipId: string): Promise<{ email: string }> {
    const [member] = await tx
      .select({ status: membership.status, email: appUser.email })
      .from(membership)
      .innerJoin(appUser, eq(appUser.id, membership.userId))
      .where(eq(membership.id, membershipId))
      .for('update', { of: membership });
    if (!member) throw new AppError('NOT_FOUND', 'Member not found.');
    if (member.status !== 'INVITED') {
      throw new AppError('INVALID_TRANSITION', 'This member has already accepted the invitation.', {
        meta: { status: member.status },
      });
    }
    return member;
  }

  private revokePending(tx: Transaction, membershipId: string) {
    return tx
      .update(invitation)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(invitation.membershipId, membershipId),
          isNull(invitation.acceptedAt),
          isNull(invitation.revokedAt),
        ),
      );
  }

  private async issue(
    tx: Transaction,
    principal: Principal,
    membershipId: string,
    email: string,
  ): Promise<IssuedInvitation> {
    const { secret, hash } = this.tokens.newRefreshSecret();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 3600 * 1000);
    const [row] = await tx
      .insert(invitation)
      .values({
        tenantId: principal.tenantId,
        membershipId,
        email,
        tokenHash: hash,
        invitedByMembershipId: principal.membershipId,
        expiresAt,
      })
      .returning({ id: invitation.id });
    if (!row) throw new Error('Invitation was not stored');
    return { id: row.id, expiresAt: expiresAt.toISOString(), token: `${row.id}.${secret}` };
  }

  /** Anonymous lookup; every failure looks the same to the caller. */
  private async findValid(token: string): Promise<FoundInvitation> {
    const parsed = parseInvitationToken(token);
    if (!parsed) throw INVALID_INVITATION();
    const rows = await this.database.withoutContext((tx) =>
      tx.execute<FoundInvitation>(
        sql`SELECT * FROM auth_find_invitation(${parsed.invitationId}, ${this.tokens.hashRefreshSecret(parsed.secret)})`,
      ),
    );
    const found = rows[0];
    if (
      !found ||
      found.accepted_at !== null ||
      found.revoked_at !== null ||
      new Date(found.expires_at).getTime() <= Date.now() ||
      found.tenant_status !== 'ACTIVE' ||
      found.membership_status !== 'INVITED'
    ) {
      throw INVALID_INVITATION();
    }
    return found;
  }
}

function holds(principal: Principal, permission: string, scope: PermissionScope): boolean {
  if (!isPermissionKey(permission)) return false;
  const held = principal.permissions.get(permission);
  return held !== undefined && SCOPE_RANK[held] >= SCOPE_RANK[scope];
}

export function parseInvitationToken(token: string): { invitationId: string; secret: string } | null {
  if (token.length > 100) return null;
  const [invitationId, secret, ...rest] = token.split('.');
  if (rest.length > 0 || !invitationId || !secret) return null;
  if (!UUID_RE.test(invitationId) || !SECRET_RE.test(secret)) return null;
  return { invitationId, secret };
}
