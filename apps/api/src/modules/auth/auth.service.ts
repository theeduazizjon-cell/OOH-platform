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

/**
 * How long the token rotated immediately before the family's current one stays acceptable (it is
 * then rotated again, not treated as reuse). Covers refresh responses lost after server-side
 * rotation; see ADR-0006.
 */
export const REFRESH_REUSE_GRACE_MS = 30_000;

type RefreshTokenRow = typeof refreshToken.$inferSelect;

interface StoredRefreshToken {
  readonly id: string;
  readonly secret: string;
  readonly expiresAt: Date;
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
   *
   * Exception (grace window): the token rotated *immediately* before the family's current one may
   * be presented again within {@link REFRESH_REUSE_GRACE_MS} of its rotation. That happens when a
   * refresh response is lost (page reload, closed tab, network drop) after the server rotated but
   * before the browser stored the new cookie. The family is rotated again instead of revoked, and
   * the successor the browser never received is revoked, so only one live token remains.
   */
  async refresh(cookie: RefreshCookie | null, client: ClientInfo): Promise<IssuedSession> {
    if (!cookie) throw INVALID_REFRESH();

    const outcome = await this.database.withUser(cookie.userId, async (tx) => {
      const [row] = await tx
        .select()
        .from(refreshToken)
        .where(eq(refreshToken.id, cookie.tokenId))
        .for('update');
      if (!row || !this.tokens.refreshSecretMatches(cookie.secret, row.tokenHash))
        return { kind: 'invalid' as const };
      if (row.revokedAt) return this.reuseDetected(tx, row);
      if (row.expiresAt.getTime() <= Date.now()) return { kind: 'invalid' as const };
      if (row.rotatedAt) {
        const supersededId = await this.claimGrace(tx, row);
        if (!supersededId) return this.reuseDetected(tx, row);
        // The previous token keeps its original rotated_at, so the window can't be extended.
        const next = await this.rotate(tx, row, client, {});
        return { kind: 'grace' as const, row, next, supersededId };
      }
      // Rotation (claim + successor) is one transaction, so a concurrent refresh with the same token
      // blocks on the row lock and then sees a complete chain.
      const next = await this.rotate(tx, row, client, { rotatedAt: new Date() });
      return { kind: 'ok' as const, row, next };
    });

    if (outcome.kind === 'reuse') {
      this.logger.warn(`Refresh token reuse detected for user ${cookie.userId}; family revoked`);
      await this.auditInTenant(
        outcome.row.activeTenantId,
        cookie.userId,
        'auth.refresh_reuse_detected',
        client,
        {
          familyId: outcome.row.familyId,
        },
      );
      throw INVALID_REFRESH();
    }
    if (outcome.kind === 'invalid') throw INVALID_REFRESH();

    const { row, next } = outcome;
    const issued = await this.sessionFor(cookie.userId, row.activeTenantId, next).catch(
      async (error: unknown) => {
        // Membership gone or suspended: end the whole session family.
        await this.database.withUser(cookie.userId, (tx) =>
          this.revokeFamily(tx, row.familyId, 'access_revoked'),
        );
        throw error;
      },
    );
    if (outcome.kind === 'grace') {
      this.logger.log(`Refresh grace used for user ${cookie.userId}; lost rotation re-issued`);
      await this.auditInTenant(row.activeTenantId, cookie.userId, 'auth.refresh_grace_used', client, {
        familyId: row.familyId,
        supersededTokenId: outcome.supersededId,
      });
    }
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

  /** Starts a new session for a user who just proved who they are another way (accepted invitation). */
  async startSession(userId: string, tenantId: string, client: ClientInfo): Promise<IssuedSession> {
    const issued = await this.issueSession(userId, tenantId, crypto.randomUUID(), client);
    await this.database.withUser(userId, (tx) =>
      tx.update(appUser).set({ lastLoginAt: new Date() }).where(eq(appUser.id, userId)),
    );
    return issued;
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
    const stored = await this.database.withUser(userId, (tx) =>
      this.insertRefreshToken(tx, { userId, familyId, activeTenantId: tenantId }, client),
    );
    return this.sessionFor(userId, tenantId, stored, access);
  }

  /** Signs the access token for a stored refresh token (resolving access unless already known). */
  private async sessionFor(
    userId: string,
    tenantId: string,
    stored: StoredRefreshToken,
    known?: MembershipAccess,
  ): Promise<IssuedSession> {
    const access = known ?? (await this.access.resolve(tenantId, userId, { fresh: true }));
    if (!access) throw new AppError('NO_ACTIVE_MEMBERSHIP', 'You do not have access to this company.');

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
      refresh: {
        value: TokenService.formatRefreshCookie({ userId, tokenId: stored.id, secret: stored.secret }),
        expiresAt: stored.expiresAt,
      },
    };
  }

  private async insertRefreshToken(
    tx: Transaction,
    values: { userId: string; familyId: string; activeTenantId: string },
    client: ClientInfo,
  ): Promise<StoredRefreshToken> {
    const { secret, hash } = this.tokens.newRefreshSecret();
    const expiresAt = this.tokens.refreshTokenExpiry();
    const [stored] = await tx
      .insert(refreshToken)
      .values({ ...values, tokenHash: hash, expiresAt, ip: client.ip, userAgent: client.userAgent })
      .returning({ id: refreshToken.id });
    if (!stored) throw new Error('Refresh token was not stored');
    return { id: stored.id, secret, expiresAt };
  }

  /** Issues the family's next token and links `row` to it (marking it rotated when asked). */
  private async rotate(
    tx: Transaction,
    row: RefreshTokenRow,
    client: ClientInfo,
    mark: { rotatedAt?: Date },
  ): Promise<StoredRefreshToken> {
    const next = await this.insertRefreshToken(
      tx,
      { userId: row.userId, familyId: row.familyId, activeTenantId: row.activeTenantId },
      client,
    );
    await tx
      .update(refreshToken)
      .set({ ...mark, replacedById: next.id })
      .where(eq(refreshToken.id, row.id));
    return next;
  }

  /**
   * Grace check for an already-rotated `row`: allowed only within the window and only while its
   * successor is the family's live token (not itself rotated or revoked). On success the successor
   * is revoked and its id returned; otherwise null (treat as reuse).
   */
  private async claimGrace(tx: Transaction, row: RefreshTokenRow): Promise<string | null> {
    if (!row.rotatedAt || !row.replacedById) return null;
    if (Date.now() - row.rotatedAt.getTime() > REFRESH_REUSE_GRACE_MS) return null;
    const [successor] = await tx
      .select()
      .from(refreshToken)
      .where(eq(refreshToken.id, row.replacedById))
      .for('update');
    if (!successor || successor.familyId !== row.familyId || successor.rotatedAt || successor.revokedAt)
      return null;
    await tx
      .update(refreshToken)
      .set({ revokedAt: new Date(), revokedReason: 'superseded_by_grace' })
      .where(eq(refreshToken.id, successor.id));
    return successor.id;
  }

  private async reuseDetected(tx: Transaction, row: RefreshTokenRow) {
    await this.revokeFamily(tx, row.familyId, 'reuse_detected');
    return { kind: 'reuse' as const, row };
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
