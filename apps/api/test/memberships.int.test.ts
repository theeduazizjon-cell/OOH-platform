/**
 * User management end to end: suspend, reactivate and change roles, including the effect on the
 * member's live session and the guardrails (self-management, managing more-privileged members,
 * escalation, tenant isolation). Real HTTP pipeline, real PostgreSQL with RLS.
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type AuthSession,
  CSRF_HEADER,
  type MembershipListItem,
  type MeResponse,
  REFRESH_COOKIE_NAME,
} from '@ooh/contracts';
import {
  appUser,
  auditEvent,
  createDatabase,
  type DatabaseConnection,
  membership,
  membershipRole,
  provisionTenant,
  role,
  rolePermission,
} from '@ooh/db';
import { and, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PasswordService } from '../src/core/auth/password.service';
import { createTestApp } from './support';

const PASSWORD = 'correct horse battery staple';
const suffix = Date.now().toString(36);
const email = (name: string) => `${name}-${suffix}@example.com`;

let app: NestFastifyApplication;
let owner: DatabaseConnection;
let tenantA: string;
let tenantB: string;
const USERS = ['admin', 'admin2', 'manager', 'reader', 'viewer', 'target', 'roleTarget', 'adminB'] as const;
type UserName = (typeof USERS)[number];
const users = {} as Record<UserName, string>;
const members = {} as Record<UserName, string>;
const roleIds: Record<string, string> = {};

async function roleId(tenantId: string, key: string): Promise<string> {
  const [r] = await owner.db
    .select({ id: role.id })
    .from(role)
    .where(and(eq(role.tenantId, tenantId), eq(role.key, key)));
  return r!.id;
}

async function addMember(tenantId: string, name: UserName, roleKey: string) {
  const [m] = await owner.db
    .insert(membership)
    .values({ tenantId, userId: users[name], status: 'ACTIVE' })
    .returning({ id: membership.id });
  await owner.db
    .insert(membershipRole)
    .values({ tenantId, membershipId: m!.id, roleId: await roleId(tenantId, roleKey) });
  members[name] = m!.id;
}

async function customRole(tenantId: string, key: string, permissions: string[]) {
  const [r] = await owner.db.insert(role).values({ tenantId, key, name: key }).returning({ id: role.id });
  await owner.db
    .insert(rolePermission)
    .values(permissions.map((permissionKey) => ({ tenantId, roleId: r!.id, permissionKey })));
}

beforeAll(async () => {
  owner = createDatabase(inject('ownerUrl'), { max: 2 });
  ({ tenantId: tenantA } = await provisionTenant(owner.db, { name: 'Manage Alpha', slug: `ma-${suffix}` }));
  ({ tenantId: tenantB } = await provisionTenant(owner.db, { name: 'Manage Beta', slug: `mb-${suffix}` }));
  const passwordHash = await new PasswordService().hash(PASSWORD);
  for (const name of USERS) {
    const [u] = await owner.db
      .insert(appUser)
      .values({ email: email(name), displayName: name, passwordHash })
      .returning({ id: appUser.id });
    users[name] = u!.id;
  }
  // A limited user administrator: may manage users but holds far fewer permissions than an admin.
  await customRole(tenantA, 'user_manager', ['users.read', 'users.update', 'users.suspend', 'roles.read']);
  await customRole(tenantA, 'reader', ['users.read']);

  await addMember(tenantA, 'admin', 'company_admin');
  await addMember(tenantA, 'admin2', 'company_admin');
  await addMember(tenantA, 'manager', 'user_manager');
  await addMember(tenantA, 'reader', 'reader');
  await addMember(tenantA, 'viewer', 'viewer');
  await addMember(tenantA, 'target', 'ooh_buyer');
  await addMember(tenantA, 'roleTarget', 'ooh_buyer');
  await addMember(tenantB, 'adminB', 'company_admin');
  for (const key of ['viewer', 'ooh_buyer', 'company_admin', 'end_client', 'reader'])
    roleIds[key] = await roleId(tenantA, key);

  app = await createTestApp();
});

afterAll(async () => {
  await app?.close();
  await owner?.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const login = (who: UserName) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: email(who), password: PASSWORD },
  });

async function sessionOf(who: UserName) {
  const response = await login(who);
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)!.value;
  return { token: response.json<AuthSession>().accessToken, cookie };
}
const tokenFor = async (who: UserName) => (await sessionOf(who)).token;

const action = (token: string, who: UserName, name: 'suspend' | 'reactivate') =>
  app.inject({
    method: 'POST',
    url: `/api/v1/memberships/${members[who]}/actions/${name}`,
    headers: bearer(token),
  });

const setRoles = (token: string, membershipId: string, ids: (string | undefined)[]) =>
  app.inject({
    method: 'PUT',
    url: `/api/v1/memberships/${membershipId}/roles`,
    headers: bearer(token),
    payload: { roleIds: ids },
  });

const me = (token: string) => app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(token) });
const code = (response: LightMyRequestResponse) => response.json<{ code: string }>().code;

const auditOf = (action: string, subjectId: string) =>
  owner.db
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.action, action), eq(auditEvent.subjectId, subjectId)));

// ── tests ────────────────────────────────────────────────────────────────────

describe('suspending and reactivating', () => {
  it('suspension ends the member’s access at once; reactivation restores sign-in but not old tokens', async () => {
    const admin = await tokenFor('admin');
    const targetBefore = await tokenFor('target');

    const suspended = await action(admin, 'target', 'suspend');
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json<MembershipListItem>()).toMatchObject({ id: members.target, status: 'SUSPENDED' });

    expect((await me(targetBefore)).statusCode).toBe(401);
    const blocked = await login('target');
    expect(blocked.statusCode).toBe(403);
    expect(code(blocked)).toBe('NO_ACTIVE_MEMBERSHIP');

    const again = await action(admin, 'target', 'suspend');
    expect(again.statusCode).toBe(409);
    expect(code(again)).toBe('INVALID_TRANSITION');

    const reactivated = await action(admin, 'target', 'reactivate');
    expect(reactivated.json<MembershipListItem>().status).toBe('ACTIVE');
    // A token issued before the suspension stays dead; a new sign-in works.
    const stale = await me(targetBefore);
    expect(stale.statusCode).toBe(401);
    expect(code(stale)).toBe('TOKEN_EXPIRED');
    expect((await login('target')).statusCode).toBe(200);

    const [event] = await auditOf('membership.suspended', members.target);
    expect(event).toMatchObject({
      tenantId: tenantA,
      actorUserId: users.admin,
      changes: { status: { from: 'ACTIVE', to: 'SUSPENDED' } },
    });
    expect(await auditOf('membership.reactivated', members.target)).toHaveLength(1);
  });

  it('only reactivates suspended members', async () => {
    const response = await action(await tokenFor('admin'), 'viewer', 'reactivate');
    expect(response.statusCode).toBe(409);
  });
});

describe('changing roles', () => {
  it('replaces the roles, forces a token refresh into the new permissions, and audits the change', async () => {
    const admin = await tokenFor('admin');
    const member = await sessionOf('roleTarget');
    expect((await me(member.token)).json<MeResponse>().permissions['campaign.update']).toBeDefined();

    const changed = await setRoles(admin, members.roleTarget, [roleIds.viewer]);
    expect(changed.statusCode).toBe(200);
    expect(changed.json<MembershipListItem>().roles).toEqual([
      { id: roleIds.viewer, key: 'viewer', name: expect.any(String) as string },
    ]);

    const stale = await me(member.token);
    expect(code(stale)).toBe('TOKEN_EXPIRED');
    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${member.cookie}`, [CSRF_HEADER]: '1' },
    });
    expect(refreshed.statusCode).toBe(200);
    const after = (await me(refreshed.json<AuthSession>().accessToken)).json<MeResponse>();
    expect(after.membership.roles.map((r) => r.key)).toEqual(['viewer']);
    expect(after.permissions['campaign.update']).toBeUndefined();

    const [event] = await auditOf('membership.roles_changed', members.roleTarget);
    expect(event?.changes).toEqual({ roles: { from: ['ooh_buyer'], to: ['viewer'] } });
  });

  it('setting the same roles again changes nothing (sessions stay valid)', async () => {
    const admin = await tokenFor('admin');
    const member = await tokenFor('roleTarget');
    const same = await setRoles(admin, members.roleTarget, [roleIds.viewer]);
    expect(same.statusCode).toBe(200);
    expect((await me(member)).statusCode).toBe(200);
    expect(await auditOf('membership.roles_changed', members.roleTarget)).toHaveLength(1);
  });

  it('validates the role list', async () => {
    const admin = await tokenFor('admin');
    for (const ids of [[], [crypto.randomUUID()], [roleIds.end_client], [await roleId(tenantB, 'viewer')]]) {
      expect((await setRoles(admin, members.roleTarget, ids)).statusCode).toBe(422);
    }
  });
});

describe('guardrails', () => {
  it('nobody can suspend themselves or change their own roles', async () => {
    const admin = await tokenFor('admin');
    const self = await action(admin, 'admin', 'suspend');
    expect(self.statusCode).toBe(403);
    expect(self.json<{ detail: string }>().detail).toMatch(/Ask another administrator/);
    expect((await setRoles(admin, members.admin, [roleIds.viewer])).statusCode).toBe(403);
  });

  it('a limited user manager cannot manage members who hold permissions they lack', async () => {
    const manager = await tokenFor('manager');
    const onAdmin = await action(manager, 'admin2', 'suspend');
    expect(onAdmin.statusCode).toBe(403);
    expect(onAdmin.json<{ meta: { permissions: string[] } }>().meta.permissions).toContain('roles.manage');
    expect((await setRoles(manager, members.admin2, [roleIds.reader])).statusCode).toBe(403);

    // …but can manage members within their own permissions, and can't escalate them.
    expect((await action(manager, 'reader', 'suspend')).statusCode).toBe(200);
    expect((await action(manager, 'reader', 'reactivate')).statusCode).toBe(200);
    const escalate = await setRoles(manager, members.reader, [roleIds.company_admin]);
    expect(escalate.statusCode).toBe(403);
    expect(escalate.json<{ detail: string }>().detail).toMatch(/cannot grant/);
  });

  it('requires users.suspend / users.update', async () => {
    const viewer = await tokenFor('viewer');
    expect((await action(viewer, 'target', 'suspend')).statusCode).toBe(403);
    expect((await setRoles(viewer, members.target, [roleIds.viewer])).statusCode).toBe(403);
  });

  it('cannot reach members of another tenant', async () => {
    const adminB = await tokenFor('adminB');
    expect((await action(adminB, 'target', 'suspend')).statusCode).toBe(404);
    expect((await setRoles(adminB, members.target, [await roleId(tenantB, 'viewer')])).statusCode).toBe(404);
  });

  it('invited members are cancelled, not suspended', async () => {
    const admin = await tokenFor('admin');
    const invited = await app.inject({
      method: 'POST',
      url: '/api/v1/memberships',
      headers: bearer(admin),
      payload: { email: email('pending'), displayName: 'Pending', roleIds: [roleIds.viewer] },
    });
    const id = invited.json<{ membership: { id: string } }>().membership.id;
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/memberships/${id}/actions/suspend`,
      headers: bearer(admin),
    });
    expect(response.statusCode).toBe(409);
    // Roles of a pending invitation can still be corrected before it is accepted.
    expect((await setRoles(admin, id, [roleIds.ooh_buyer])).statusCode).toBe(200);
  });
});
