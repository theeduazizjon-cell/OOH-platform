import { Injectable, Logger } from '@nestjs/common';
import type { AuthSession, LoginRequest, MeResponse, MembershipSummary } from '@ooh/contracts';
import { appUser, membership, refreshToken, tenant, type Transaction } from '@ooh/db';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { AuditService } from '../../core/audit/audit.service';
import { AccessService, type MembershipAccess } from '../../core/auth/access.service';
import { LoginThrottle } from '../../core/auth/login-throttle';
import { PasswordService } from '../../core/auth/password.service';
import { type Principal } from '../../core/auth/principal';
import { type RefreshCookie, TokenService } from '../../core/auth/token.service';
import { DatabaseService } from '../../core/database/database.service';
import { AppError } from '../../core/http/app-error';
import { type ClientInfo } from '../../core/http/client-info';

/** Result of any operation that (re)issues credentials. The controller turns `refresh` into a cookie. */
export interface IssuedSession {
  readonly session: AuthSession;
  readonly refresh: { readonly value: string; readonly expiresAt: Date };
}

const INVALID_REFRESH = () => new AppError('UNAUTHENTICATED', 'Session expired. Please sign in again.');

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly access: AccessService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly throttle: LoginThrottle,
    private readonly audit: AuditService,
  ) {}

  async login(input: LoginRequest, client: ClientInfo): Promise<IssuedSession> {
    await this.throttle.assertAllowed(input.email, client.ip);

    const rows = await this.database.withoutContext((tx) =>
      tx.execute<{ user_id: string; password_hash: string | null }>(
        sql`SELECT user_id, password_hash FROM auth_find_login_user(${input.email})`,
      ),
    );
    const candidate = rows[0];
    // Always verify (against a dummy hash when unknown) so timing doesn't reveal registered emails.
    const valid = await this.passwords.verify(candidate?.password_hash, input.password);
    if (!candidate || !valid) {
      await this.throttle.recordFailure(input.email, client.ip);
      await this.audit.recordWithoutTenant({
        actorType: 'USER',
        actorUserId: candidate?.user_id ?? null,
        action: 'auth.login_failed',
        metadata: { email: input.email.toLowerCase() },
        client,
      });
      throw new AppError('INVALID_CREDENTIALS', 'Incorrect email or password.');
    }
    await this.throttle.recordSuccess(input.email);

    const userId = candidate.user_id;
    const memberships = await this.listMemberships(userId);
    const target = input.tenantId ? memberships.find((m) => m.tenantId === input.tenantId) : memberships[0];
    if (!target) throw new AppError('NO_ACTIVE_MEMBERSHIP', 'You do not have access to this company.');

    const issued = await this.issueSession(userId, target.tenantId, crypto.randomUUID(), client);
    await this.database.withUser(userId, (tx) =>
      tx.update(appUser).set({ lastLoginAt: new Date() }).where(eq(appUser.id, userId)),
    );
    await this.database.withTenant({ tenantId: target.tenantId, actorUserId: userId }, (tx) =>
      this.audit.record(tx, {
        tenantId: target.tenantId,
        actorType: 'USER',
        actorUserId: userId,
        actorMembershipId: issued.session.membershipId,
        action: 'auth.login',
        client,
      }),
    );
    return issued;
  }

  /**
   * Rotates the refresh token. Presenting an already-rotated or revoked token means it was
   * stolen or replayed: the whole token family is revoked and the user must sign in again.
   */
  async refresh(cookie: RefreshCookie | null, client: ClientInfo): Promise<IssuedSession> {
    if (!cookie) throw INVALID_REFRESH();

    const current = await this.database.withUser(cookie.userId, async (tx) => {
      const [row] = await tx
        .select()
        .from(refreshToken)
        .where(eq(refreshToken.id, cookie.tokenId))
        .for('update');
      if (!row || !this.tokens.refreshSecretMatches(cookie.secret, row.tokenHash))
        return { kind: 'invalid' as const };
      if (row.revokedAt || row.rotatedAt) {
        await this.revokeFamily(tx, row.familyId, 'reuse_detected');
        return { kind: 'reuse' as const, row };
      }
      if (row.expiresAt.getTime() <= Date.now()) return { kind: 'invalid' as const };
      // Claim the token inside this transaction so a concurrent refresh can't use it twice.
      await tx.update(refreshToken).set({ rotatedAt: new Date() }).where(eq(refreshToken.id, row.id));
      return { kind: 'ok' as const, row };
    });

    if (current.kind === 'reuse') {
      this.logger.warn(`Refresh token reuse detected for user ${cookie.userId}; family revoked`);
      await this.auditInTenant(
        current.row.activeTenantId,
        cookie.userId,
        'auth.refresh_reuse_detected',
        client,
        {
          familyId: current.row.familyId,
        },
      );
      throw INVALID_REFRESH();
    }
    if (current.kind === 'invalid') throw INVALID_REFRESH();

    const { row } = current;
    const issued = await this.issueSession(cookie.userId, row.activeTenantId, row.familyId, client).catch(
      async (error: unknown) => {
        // Membership gone or suspended: end the whole session family.
        await this.database.withUser(cookie.userId, (tx) =>
          this.revokeFamily(tx, row.familyId, 'access_revoked'),
        );
        throw error;
      },
    );
    await this.database.withUser(cookie.userId, (tx) =>
      tx
        .update(refreshToken)
        .set({ replacedById: this.tokenIdOf(issued) })
        .where(eq(refreshToken.id, row.id)),
    );
    return issued;
  }

  async logout(cookie: RefreshCookie | null, client: ClientInfo): Promise<void> {
    if (!cookie) return;
    const tenantId = await this.database.withUser(cookie.userId, async (tx) => {
      const [row] = await tx.select().from(refreshToken).where(eq(refreshToken.id, cookie.tokenId));
      if (!row || !this.tokens.refreshSecretMatches(cookie.secret, row.tokenHash)) return null;
      await this.revokeFamily(tx, row.familyId, 'logout');
      return row.activeTenantId;
    });
    if (tenantId) {
      this.access.invalidate(tenantId, cookie.userId);
      await this.auditInTenant(tenantId, cookie.userId, 'auth.logout', client);
    }
  }

  /** Moves the session to another tenant: the old token family ends, a new one starts. */
  async switchTenant(
    principal: Principal,
    tenantId: string,
    cookie: RefreshCookie | null,
    client: ClientInfo,
  ): Promise<IssuedSession> {
    const memberships = await this.listMemberships(principal.userId);
    if (!memberships.some((m) => m.tenantId === tenantId)) {
      throw new AppError('NO_ACTIVE_MEMBERSHIP', 'You do not have access to this company.');
    }
    if (cookie && cookie.userId === principal.userId) {
      await this.database.withUser(principal.userId, async (tx) => {
        const [row] = await tx.select().from(refreshToken).where(eq(refreshToken.id, cookie.tokenId));
        if (row && this.tokens.refreshSecretMatches(cookie.secret, row.tokenHash)) {
          await this.revokeFamily(tx, row.familyId, 'tenant_switched');
        }
      });
    }
    const issued = await this.issueSession(principal.userId, tenantId, crypto.randomUUID(), client);
    await this.auditInTenant(tenantId, principal.userId, 'auth.tenant_switched', client, {
      fromTenantId: principal.tenantId,
    });
    return issued;
  }

  async me(principal: Principal): Promise<MeResponse> {
    const { user, currentTenant, access } = await this.database.withTenant(
      { tenantId: principal.tenantId, actorUserId: principal.userId },
      async (tx) => {
        const [userRow] = await tx
          .select({
            id: appUser.id,
            email: appUser.email,
            displayName: appUser.displayName,
            locale: appUser.locale,
          })
          .from(appUser)
          .where(eq(appUser.id, principal.userId));
        const [tenantRow] = await tx
          .select({
            id: tenant.id,
            name: tenant.name,
            slug: tenant.slug,
            locale: tenant.locale,
            timezone: tenant.timezone,
            defaultCurrency: tenant.defaultCurrency,
          })
          .from(tenant)
          .where(eq(tenant.id, principal.tenantId));
        return {
          user: userRow,
          currentTenant: tenantRow,
          access: await this.access.load(tx, principal.userId),
        };
      },
    );
    if (!user || !currentTenant || !access)
      throw new AppError('UNAUTHENTICATED', 'This session is no longer valid.');

    return {
      user,
      tenant: currentTenant,
      membership: { id: access.membershipId, kind: access.kind, roles: [...access.roles] },
      permissions: Object.fromEntries(access.permissions),
      memberships: await this.listMemberships(principal.userId),
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Active memberships in active tenants, read in user mode (the user's own rows only). */
  private listMemberships(userId: string): Promise<MembershipSummary[]> {
    return this.database.withUser(userId, (tx) =>
      tx
        .select({
          membershipId: membership.id,
          tenantId: tenant.id,
          tenantName: tenant.name,
          tenantSlug: tenant.slug,
          kind: membership.kind,
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
        )
        .orderBy(asc(tenant.name)),
    );
  }

  private async issueSession(
    userId: string,
    tenantId: string,
    familyId: string,
    client: ClientInfo,
  ): Promise<IssuedSession> {
    const access: MembershipAccess | null = await this.access.resolve(tenantId, userId, { fresh: true });
    if (!access) throw new AppError('NO_ACTIVE_MEMBERSHIP', 'You do not have access to this company.');

    const { secret, hash } = this.tokens.newRefreshSecret();
    const expiresAt = this.tokens.refreshTokenExpiry();
    const [stored] = await this.database.withUser(userId, (tx) =>
      tx
        .insert(refreshToken)
        .values({
          userId,
          familyId,
          tokenHash: hash,
          activeTenantId: tenantId,
          expiresAt,
          ip: client.ip,
          userAgent: client.userAgent,
        })
        .returning({ id: refreshToken.id }),
    );
    if (!stored) throw new Error('Refresh token was not stored');

    const accessToken = await this.tokens.signAccessToken({
      userId,
      tenantId,
      membershipId: access.membershipId,
      permsVersion: access.permsVersion,
    });
    return {
      session: {
        accessToken: accessToken.token,
        accessTokenExpiresAt: accessToken.expiresAt.toISOString(),
        tenantId,
        membershipId: access.membershipId,
      },
      refresh: { value: TokenService.formatRefreshCookie({ userId, tokenId: stored.id, secret }), expiresAt },
    };
  }

  private tokenIdOf(issued: IssuedSession): string {
    return TokenService.parseRefreshCookie(issued.refresh.value)!.tokenId;
  }

  private async revokeFamily(tx: Transaction, familyId: string, reason: string): Promise<void> {
    await tx
      .update(refreshToken)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(refreshToken.familyId, familyId), isNull(refreshToken.revokedAt)));
  }

  private auditInTenant(
    tenantId: string,
    userId: string,
    action: string,
    client: ClientInfo,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    return this.database.withTenant({ tenantId, actorUserId: userId }, (tx) =>
      this.audit.record(tx, {
        tenantId,
        actorType: 'USER',
        actorUserId: userId,
        action,
        client,
        ...(metadata ? { metadata } : {}),
      }),
    );
  }
}
