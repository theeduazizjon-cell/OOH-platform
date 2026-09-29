/**
 * Roles admin end to end: the permission catalog, custom role CRUD, the system-role rules, the
 * effect of role changes on members' live sessions, escalation guards, the "keep an administrator"
 * guard and If-Match. Real HTTP pipeline, real PostgreSQL with RLS.
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type AuthSession,
  CSRF_HEADER,
  etagOf,
  type MeResponse,
  type Page,
  type PermissionCatalogItem,
  PERMISSION_KEYS,
  REFRESH_COOKIE_NAME,
  type RoleDetail,
  type RoleListItem,
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

const USERS = ['admin', 'admin2', 'editor', 'viewer', 'worker', 'adminB'] as const;
type UserName = (typeof USERS)[number];
const users = {} as Record<UserName, string>;

let app: NestFastifyApplication;
let owner: DatabaseConnection;
let tenantA: string;
let tenantB: string;
const roleIds: Record<string, string> = {};

async function roleIdOf(tenantId: string, key: string): Promise<string> {
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
    .values({ tenantId, membershipId: m!.id, roleId: await roleIdOf(tenantId, roleKey) });
}

async function seedRole(tenantId: string, key: string, permissions: string[]) {
  const [r] = await owner.db.insert(role).values({ tenantId, key, name: key }).returning({ id: role.id });
  await owner.db
    .insert(rolePermission)
    .values(permissions.map((permissionKey) => ({ tenantId, roleId: r!.id, permissionKey })));
}

beforeAll(async () => {
  owner = createDatabase(inject('ownerUrl'), { max: 2 });
  ({ tenantId: tenantA } = await provisionTenant(owner.db, { name: 'Roles Alpha', slug: `ra-${suffix}` }));
  ({ tenantId: tenantB } = await provisionTenant(owner.db, { name: 'Roles Beta', slug: `rb-${suffix}` }));
  const passwordHash = await new PasswordService().hash(PASSWORD);
  for (const name of USERS) {
    const [u] = await owner.db
      .insert(appUser)
      .values({ email: email(name), displayName: name, passwordHash })
      .returning({ id: appUser.id });
    users[name] = u!.id;
  }
  // May manage roles but holds far less than a Company Admin (and no users.update).
  await seedRole(tenantA, 'role_editor', ['roles.read', 'roles.manage', 'campaign.read', 'asset.read']);
  // A custom role in use, to observe the effect of editing it on its member.
  await seedRole(tenantA, 'field_worker', ['campaign.read']);

  await addMember(tenantA, 'admin', 'company_admin');
  await addMember(tenantA, 'admin2', 'company_admin');
  await addMember(tenantA, 'editor', 'role_editor');
  await addMember(tenantA, 'viewer', 'viewer');
  await addMember(tenantA, 'worker', 'field_worker');
  await addMember(tenantB, 'adminB', 'company_admin');
  for (const key of ['company_admin', 'viewer', 'field_worker', 'role_editor'])
    roleIds[key] = await roleIdOf(tenantA, key);

  app = await createTestApp();
});

afterAll(async () => {
  await app?.close();
  await owner?.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const code = (response: LightMyRequestResponse) => response.json<{ code: string }>().code;

async function sessionOf(who: UserName) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: email(who), password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  return {
    token: response.json<AuthSession>().accessToken,
    cookie: response.cookies.find((c) => c.name === REFRESH_COOKIE_NAME)!.value,
  };
}
const tokenFor = async (who: UserName) => (await sessionOf(who)).token;

async function currentEtag(roleId: string): Promise<string> {
  const [row] = await owner.db.select({ version: role.version }).from(role).where(eq(role.id, roleId));
  return row ? etagOf(row.version) : '*';
}

const getRole = (token: string, id: string) =>
  app.inject({ method: 'GET', url: `/api/v1/roles/${id}`, headers: bearer(token) });
const createRole = (token: string, payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/v1/roles', headers: bearer(token), payload: payload as object });
const patchRole = async (token: string, id: string, payload: object, ifMatch?: string | null) =>
  app.inject({
    method: 'PATCH',
    url: `/api/v1/roles/${id}`,
    headers: {
      ...bearer(token),
      ...(ifMatch === null ? {} : { 'if-match': ifMatch ?? (await currentEtag(id)) }),
    },
    payload,
  });
const deleteRole = async (token: string, id: string, ifMatch?: string) =>
  app.inject({
    method: 'DELETE',
    url: `/api/v1/roles/${id}`,
    headers: { ...bearer(token), 'if-match': ifMatch ?? (await currentEtag(id)) },
  });
const me = (token: string) => app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(token) });
async function refreshedMe(cookie: string): Promise<MeResponse> {
  const refreshed = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    headers: { cookie: `${REFRESH_COOKIE_NAME}=${cookie}`, [CSRF_HEADER]: '1' },
  });
  expect(refreshed.statusCode).toBe(200);
  return (await me(refreshed.json<AuthSession>().accessToken)).json<MeResponse>();
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('reading', () => {
  it('GET /permissions serves the catalog to roles.read holders only', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/permissions',
      headers: bearer(await tokenFor('admin')),
    });
    const catalog = response.json<{ data: PermissionCatalogItem[] }>().data;
    expect(catalog.map((p) => p.key)).toEqual(PERMISSION_KEYS);
    expect(catalog.find((p) => p.key === 'roles.manage')).toMatchObject({
      internalOnly: true,
      scopes: ['ALL'],
    });
    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/permissions',
      headers: bearer(await tokenFor('viewer')),
    });
    expect(denied.statusCode).toBe(403);
  });

  it('lists roles with member counts and versions, and shows a role’s grants', async () => {
    const admin = await tokenFor('admin');
    const list = await app.inject({ method: 'GET', url: '/api/v1/roles', headers: bearer(admin) });
    const roles = list.json<Page<RoleListItem>>().data;
    expect(roles.find((r) => r.key === 'company_admin')).toMatchObject({ memberCount: 2, isSystem: true });
    expect(roles.find((r) => r.key === 'field_worker')).toMatchObject({ memberCount: 1, version: 1 });

    const detail = await getRole(admin, roleIds.field_worker!);
    expect(detail.headers.etag).toBe(etagOf(1));
    expect(detail.json<RoleDetail>().grants).toEqual([{ permission: 'campaign.read', scope: 'ALL' }]);

    expect((await getRole(await tokenFor('adminB'), roleIds.field_worker!)).statusCode).toBe(404);
  });
});

describe('creating custom roles', () => {
  it('creates a role with a collision-proof key and audits it', async () => {
    const admin = await tokenFor('admin');
    const grants = [
      { permission: 'campaign.read', scope: 'ALL' },
      { permission: 'asset.read', scope: 'ALL' },
    ];
    const created = await createRole(admin, { name: 'Field Coördinator', description: 'Ops', grants });
    expect(created.statusCode).toBe(201);
    const role = created.json<RoleDetail>();
    expect(role).toMatchObject({
      key: 'custom_field_coordinator',
      isSystem: false,
      isExternal: false,
      active: true,
      memberCount: 0,
      version: 1,
    });
    expect(role.grants).toHaveLength(2);

    const again = await createRole(admin, { name: 'Field coordinator', grants });
    expect(again.json<RoleDetail>().key).toBe('custom_field_coordinator_2');
    // A custom role named like a system one never takes a system key.
    expect((await createRole(admin, { name: 'Viewer', grants })).json<RoleDetail>().key).toBe(
      'custom_viewer',
    );

    const [event] = await owner.db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, 'role.created'), eq(auditEvent.subjectId, role.id)));
    expect(event?.actorUserId).toBe(users.admin);
  });

  it('validates grants against the catalog', async () => {
    const admin = await tokenFor('admin');
    for (const grants of [
      [{ permission: 'no.such_permission', scope: 'ALL' }],
      [{ permission: 'roles.manage', scope: 'OWN' }], // scope not allowed for this permission
      [
        { permission: 'campaign.read', scope: 'ALL' },
        { permission: 'campaign.read', scope: 'ALL' },
      ],
      [],
    ]) {
      const response = await createRole(admin, { name: 'Invalid', grants });
      expect(response.statusCode, JSON.stringify(grants)).toBe(422);
    }
  });

  it('needs roles.manage, and never grants more than the creator holds', async () => {
    const grants = [{ permission: 'campaign.read', scope: 'ALL' }];
    expect((await createRole(await tokenFor('viewer'), { name: 'Nope', grants })).statusCode).toBe(403);

    const editor = await tokenFor('editor');
    const escalate = await createRole(editor, {
      name: 'Escalate',
      grants: [...grants, { permission: 'users.invite', scope: 'ALL' }],
    });
    expect(escalate.statusCode).toBe(403);
    expect(escalate.json<{ meta: { permissions: string[] } }>().meta.permissions).toEqual(['users.invite']);
    expect((await createRole(editor, { name: 'Within reach', grants })).statusCode).toBe(201);
  });
});

describe('editing roles', () => {
  it('changing a custom role’s grants moves its members onto the new permissions', async () => {
    const admin = await tokenFor('admin');
    const worker = await sessionOf('worker');
    expect((await me(worker.token)).json<MeResponse>().permissions['asset.read']).toBeUndefined();

    const updated = await patchRole(admin, roleIds.field_worker!, {
      name: 'Field worker',
      grants: [
        { permission: 'campaign.read', scope: 'ALL' },
        { permission: 'asset.read', scope: 'ALL' },
      ],
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<RoleDetail>()).toMatchObject({ name: 'Field worker', version: 2 });
    expect(updated.headers.etag).toBe(etagOf(2));

    expect(code(await me(worker.token))).toBe('TOKEN_EXPIRED');
    expect((await refreshedMe(worker.cookie)).permissions['asset.read']).toBe('ALL');
  });

  it('requires If-Match, and refuses a stale one', async () => {
    const admin = await tokenFor('admin');
    expect((await patchRole(admin, roleIds.field_worker!, { name: 'X' }, null)).statusCode).toBe(428);
    const stale = await patchRole(admin, roleIds.field_worker!, { name: 'X' }, etagOf(1));
    expect(stale.statusCode).toBe(412);
    expect(stale.json<{ meta: { etag: string } }>().meta.etag).toBe(etagOf(2));
  });

  it('system roles can only be enabled or disabled; disabling takes their permissions away', async () => {
    const admin = await tokenFor('admin');
    const renamed = await patchRole(admin, roleIds.viewer!, { name: 'Renamed' });
    expect(renamed.statusCode).toBe(409);
    expect(renamed.json<{ detail: string }>().detail).toMatch(/Duplicate it/);

    const viewer = await sessionOf('viewer');
    expect((await patchRole(admin, roleIds.viewer!, { active: false })).json<RoleDetail>().active).toBe(
      false,
    );
    expect((await refreshedMe(viewer.cookie)).permissions['campaign.read']).toBeUndefined();
    expect((await patchRole(admin, roleIds.viewer!, { active: true })).statusCode).toBe(200);
  });

  it('nobody can edit a role that holds more than they do', async () => {
    const editor = await tokenFor('editor');
    const response = await patchRole(editor, roleIds.company_admin!, { active: false });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ detail: string }>().detail).toMatch(/permissions you do not have/);
  });

  it('refuses changes that would leave no active administrator', async () => {
    const admin = await tokenFor('admin');
    // Both admins hold roles.manage + users.update only through company_admin.
    const response = await patchRole(admin, roleIds.company_admin!, { active: false });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ meta: { requiredPermissions: string[] } }>().meta.requiredPermissions).toEqual([
      'roles.manage',
      'users.update',
    ]);
    // Rolled back: the role is still active and admins keep their access.
    const [stillActive] = await owner.db
      .select({ active: role.active })
      .from(role)
      .where(eq(role.id, roleIds.company_admin!));
    expect(stillActive?.active).toBe(true);
    expect((await me(admin)).statusCode).toBe(200);
  });
});

describe('deleting roles', () => {
  it('deletes unused custom roles only', async () => {
    const admin = await tokenFor('admin');
    const inUse = await deleteRole(admin, roleIds.field_worker!);
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json<{ meta: { memberCount: number } }>().meta.memberCount).toBe(1);

    expect((await deleteRole(admin, roleIds.viewer!)).statusCode).toBe(409);

    const created = await createRole(admin, {
      name: 'Short-lived',
      grants: [{ permission: 'campaign.read', scope: 'ALL' }],
    });
    const id = created.json<RoleDetail>().id;
    expect((await deleteRole(admin, id, etagOf(0))).statusCode).toBe(412);
    expect((await deleteRole(admin, id)).statusCode).toBe(204);
    expect((await getRole(admin, id)).statusCode).toBe(404);
    expect(await owner.db.select().from(rolePermission).where(eq(rolePermission.roleId, id))).toHaveLength(0);
  });

  it('cannot reach roles of another tenant', async () => {
    const adminB = await tokenFor('adminB');
    expect((await patchRole(adminB, roleIds.field_worker!, { name: 'Hijack' }, '*')).statusCode).toBe(404);
    expect((await deleteRole(adminB, roleIds.field_worker!, '*')).statusCode).toBe(404);
  });
});
