/**
 * Authentication & authorization end to end: real HTTP pipeline, real PostgreSQL with RLS.
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { CSRF_HEADER, REFRESH_COOKIE_NAME } from '@ooh/contracts';
import {
  appUser,
  auditEvent,
  createDatabase,
  type DatabaseConnection,
  membership,
  membershipRole,
  provisionTenant,
  role,
} from '@ooh/db';
import { and, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp, createFastifyAdapter } from '../src/bootstrap';
import { loadEnv } from '../src/config/env';
import { AccessService } from '../src/core/auth/access.service';
import { THROTTLE_STORE } from '../src/core/auth/login-throttle';
import { PasswordService } from '../src/core/auth/password.service';
import { RedisService } from '../src/core/redis/redis.service';
import { MemoryThrottleStore } from './support';

const PASSWORD = 'correct horse battery staple';
const suffix = Date.now().toString(36);
const email = (name: string) => `${name}-${suffix}@example.com`;

let app: NestFastifyApplication;
let owner: DatabaseConnection;
const throttleStore = new MemoryThrottleStore();
let tenantA: string;
let tenantB: string;
const users: Record<'admin' | 'viewer' | 'outsider' | 'suspended', string> = {
  admin: '',
  viewer: '',
  outsider: '',
  suspended: '',
};

async function addMember(
  tenantId: string,
  userId: string,
  roleKey: string,
  status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE',
) {
  const [m] = await owner.db
    .insert(membership)
    .values({ tenantId, userId, status })
    .returning({ id: membership.id });
  const [r] = await owner.db
    .select({ id: role.id })
    .from(role)
    .where(and(eq(role.tenantId, tenantId), eq(role.key, roleKey)));
  await owner.db.insert(membershipRole).values({ tenantId, membershipId: m!.id, roleId: r!.id });
  return m!.id;
}

beforeAll(async () => {
  owner = createDatabase(inject('ownerUrl'), { max: 2 });
  ({ tenantId: tenantA } = await provisionTenant(owner.db, { name: 'Alpha OOH', slug: `alpha-${suffix}` }));
  ({ tenantId: tenantB } = await provisionTenant(owner.db, { name: 'Beta OOH', slug: `beta-${suffix}` }));

  const passwordHash = await new PasswordService().hash(PASSWORD);
  for (const name of Object.keys(users) as (keyof typeof users)[]) {
    const [u] = await owner.db
      .insert(appUser)
      .values({ email: email(name), displayName: name, passwordHash })
      .returning({ id: appUser.id });
    users[name] = u!.id;
  }
  await addMember(tenantA, users.admin, 'company_admin');
  await addMember(tenantB, users.admin, 'viewer');
  await addMember(tenantA, users.viewer, 'viewer');
  await addMember(tenantB, users.outsider, 'company_admin');
  await addMember(tenantA, users.suspended, 'company_admin', 'SUSPENDED');

  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: inject('appUrl'),
    REDIS_URL: 'redis://localhost:1',
    JWT_SECRET: 'integration-secret-integration-secret-1',
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] })
    .overrideProvider(THROTTLE_STORE)
    .useValue(throttleStore)
    .overrideProvider(RedisService)
    .useValue({ onApplicationShutdown: () => Promise.resolve() })
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(env));
  await configureApp(app, env);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
  await owner?.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────

const login = (who: string, password = PASSWORD, tenantId?: string) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: email(who), password, tenantId },
  });

function refreshCookie(response: LightMyRequestResponse): string {
  const cookie = response.cookies.find((c) => c.name === REFRESH_COOKIE_NAME);
  if (!cookie) throw new Error('no refresh cookie in response');
  return cookie.value;
}

const withCookie = (value: string) => ({ cookie: `${REFRESH_COOKIE_NAME}=${value}`, [CSRF_HEADER]: '1' });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const tokenOf = (response: LightMyRequestResponse) => response.json<{ accessToken: string }>().accessToken;

async function session(who: string, tenantId?: string) {
  const response = await login(who, PASSWORD, tenantId);
  expect(response.statusCode).toBe(200);
  return { token: tokenOf(response), cookie: refreshCookie(response) };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('login', () => {
  it('issues an access token and a hardened refresh cookie', async () => {
    const response = await login('admin');
    expect(response.statusCode).toBe(200);
    const body = response.json<{ tenantId: string; accessToken: string }>();
    expect(body.tenantId).toBe(tenantA);
    expect(body.accessToken.split('.')).toHaveLength(3);
    expect(response.headers['cache-control']).toBe('no-store');
    const cookie = response.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api/v1/auth' });
  });

  it('gives the same answer for a wrong password and an unknown email, and audits it', async () => {
    const wrong = await login('viewer', 'not the password!');
    const unknown = await login('nobody');
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json<{ code: string; detail: string }>()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(unknown.json<{ detail: string }>().detail).toBe(wrong.json<{ detail: string }>().detail);

    const failures = await owner.db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, 'auth.login_failed'));
    expect(failures.length).toBeGreaterThanOrEqual(2);
    expect(failures.every((f) => f.tenantId === null)).toBe(true);
  });

  it('locks an account after repeated failures, even for the right password', async () => {
    throttleStore.counts.clear();
    for (let i = 0; i < 5; i++) expect((await login('outsider', 'wrong password !!')).statusCode).toBe(401);
    const blocked = await login('outsider');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json<{ code: string }>().code).toBe('RATE_LIMITED');
    throttleStore.counts.clear();
  });

  it('refuses users without an active membership', async () => {
    const response = await login('suspended');
    expect(response.statusCode).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('NO_ACTIVE_MEMBERSHIP');
  });

  it('validates the body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nope' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ errors: { path: string }[] }>().errors.map((e) => e.path)).toEqual(
      expect.arrayContaining(['email', 'password']),
    );
  });

  it('records a tenant-scoped audit event for successful logins', async () => {
    await login('viewer');
    const events = await owner.db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, 'auth.login'), eq(auditEvent.actorUserId, users.viewer)));
    expect(events[0]).toMatchObject({ tenantId: tenantA, actorType: 'USER' });
  });
});

describe('authenticated requests', () => {
  it('reject missing and forged tokens', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/me' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer('abc.def.ghi') })).statusCode,
    ).toBe(401);
  });

  it('GET /me returns identity, tenant, roles, permissions and switchable tenants', async () => {
    const { token } = await session('admin');
    const response = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(token) });
    expect(response.statusCode).toBe(200);
    const me = response.json<{
      tenant: { id: string };
      membership: { roles: { key: string }[] };
      permissions: Record<string, string>;
      memberships: { tenantId: string }[];
    }>();
    expect(me.tenant.id).toBe(tenantA);
    expect(me.membership.roles.map((r) => r.key)).toEqual(['company_admin']);
    expect(me.permissions['users.read']).toBe('ALL');
    expect(me.memberships.map((m) => m.tenantId).sort()).toEqual([tenantA, tenantB].sort());
  });

  it('enforces permissions: admin lists members, viewer is forbidden', async () => {
    const admin = await session('admin');
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/memberships',
      headers: bearer(admin.token),
    });
    expect(list.statusCode).toBe(200);
    const body = list.json<{ data: { userId: string }[] }>();
    const ids = body.data.map((m) => m.userId);
    expect(ids).toEqual(expect.arrayContaining([users.admin, users.viewer, users.suspended]));
    expect(ids).not.toContain(users.outsider); // member of tenant B only

    const viewer = await session('viewer');
    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/memberships',
      headers: bearer(viewer.token),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ code: string }>().code).toBe('FORBIDDEN');
  });

  it('paginates with an opaque cursor', async () => {
    const { token } = await session('admin');
    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/memberships?limit=1',
      headers: bearer(token),
    });
    const page1 = first.json<{ data: { id: string }[]; page: { nextCursor: string; hasMore: boolean } }>();
    expect(page1.data).toHaveLength(1);
    expect(page1.page.hasMore).toBe(true);
    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/memberships?limit=1&cursor=${page1.page.nextCursor}`,
      headers: bearer(token),
    });
    const page2 = second.json<{ data: { id: string }[] }>();
    expect(page2.data[0]!.id > page1.data[0]!.id).toBe(true);

    const bad = await app.inject({
      method: 'GET',
      url: '/api/v1/memberships?cursor=garbage',
      headers: bearer(token),
    });
    expect(bad.statusCode).toBe(422);
  });
});

describe('refresh token rotation', () => {
  it('requires the CSRF header', async () => {
    const { cookie } = await session('viewer');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${cookie}` },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rotates, and revokes the whole family when a rotated token is replayed', async () => {
    const { cookie: original } = await session('viewer');
    const rotated = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: withCookie(original),
    });
    expect(rotated.statusCode).toBe(200);
    const next = refreshCookie(rotated);
    expect(next).not.toBe(original);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(tokenOf(rotated)) })).statusCode,
    ).toBe(200);

    // An attacker replays the stolen original …
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: withCookie(original),
    });
    expect(replay.statusCode).toBe(401);
    // … which also kills the legitimate successor.
    const successor = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: withCookie(next),
    });
    expect(successor.statusCode).toBe(401);

    const reuse = await owner.db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, 'auth.refresh_reuse_detected'));
    expect(reuse.length).toBeGreaterThanOrEqual(1);
  });

  it('logout revokes the session and clears the cookie', async () => {
    const { cookie } = await session('viewer');
    const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: withCookie(cookie) });
    expect(out.statusCode).toBe(204);
    expect(out.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)?.value).toBe('');
    const after = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: withCookie(cookie),
    });
    expect(after.statusCode).toBe(401);
  });
});

describe('tenant switching', () => {
  it('moves the session to another tenant with that tenant’s permissions', async () => {
    const { token, cookie } = await session('admin');
    const switched = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/switch-tenant',
      headers: { ...bearer(token), ...withCookie(cookie) },
      payload: { tenantId: tenantB },
    });
    expect(switched.statusCode).toBe(200);
    const tokenB = tokenOf(switched);

    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(tokenB) });
    expect(me.json<{ tenant: { id: string } }>().tenant.id).toBe(tenantB);
    // Admin in A, only viewer in B.
    const members = await app.inject({ method: 'GET', url: '/api/v1/memberships', headers: bearer(tokenB) });
    expect(members.statusCode).toBe(403);
    // The pre-switch refresh token family is ended.
    const old = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: withCookie(cookie),
    });
    expect(old.statusCode).toBe(401);
  });

  it('refuses tenants the user is not a member of', async () => {
    const { token, cookie } = await session('viewer');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/switch-tenant',
      headers: { ...bearer(token), ...withCookie(cookie) },
      payload: { tenantId: tenantB },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('NO_ACTIVE_MEMBERSHIP');
  });
});

describe('revocation', () => {
  it('a permission change (perms_version bump) forces a refresh; suspension ends the session', async () => {
    const { token, cookie } = await session('viewer');
    const access = app.get(AccessService);

    await owner.db
      .update(membership)
      .set({ permsVersion: 2 })
      .where(and(eq(membership.tenantId, tenantA), eq(membership.userId, users.viewer)));
    access.invalidate(tenantA, users.viewer); // otherwise takes effect within the 30 s cache TTL

    const stale = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(token) });
    expect(stale.statusCode).toBe(401);
    expect(stale.json<{ code: string }>().code).toBe('TOKEN_EXPIRED');
    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: withCookie(cookie),
    });
    expect(refreshed.statusCode).toBe(200);
    const fresh = tokenOf(refreshed);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(fresh) })).statusCode).toBe(
      200,
    );

    await owner.db
      .update(membership)
      .set({ status: 'SUSPENDED' })
      .where(and(eq(membership.tenantId, tenantA), eq(membership.userId, users.viewer)));
    access.invalidate(tenantA, users.viewer);
    const suspended = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(fresh) });
    expect(suspended.statusCode).toBe(401);
    const noRefresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: withCookie(refreshCookie(refreshed)),
    });
    expect(noRefresh.statusCode).toBe(403);
  });
});
