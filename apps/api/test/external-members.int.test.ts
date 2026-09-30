/**
 * M2b.2 end to end: agency ↔ client relationships, the account owner list, and external members
 * (people representing a client, agency or supplier): invitation, their permissions once signed
 * in, and management by admins, including the narrow external-party exemption to the no-escalation
 * rule (docs/architecture/03-rbac.md §5).
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type AccountOwnerCandidate,
  type AuthSession,
  etagOf,
  type InviteMemberResponse,
  type MeResponse,
  type MembershipListItem,
  type OrganisationDetail,
  type OrganisationRelationshipItem,
  type Page,
} from '@ooh/contracts';
import {
  appUser,
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
const NEW_PASSWORD = 'a brand new passphrase';
const suffix = Date.now().toString(36);
const email = (name: string) => `${name}-${suffix}@example.com`;

const USERS = ['admin', 'sales', 'viewer', 'inviter', 'adminB'] as const;
type UserName = (typeof USERS)[number];
const users = {} as Record<UserName, string>;
const members = {} as Record<UserName, string>;
const tokens = {} as Record<UserName, string>;
const roleIds: Record<string, string> = {};

let app: NestFastifyApplication;
let owner: DatabaseConnection;
let tenantA: string;
let tenantB: string;
let carrefour: OrganisationDetail;
let agencyX: OrganisationDetail;

async function roleIdOf(tenantId: string, key: string) {
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
  members[name] = m!.id;
}

async function customRole(tenantId: string, key: string, grants: [string, 'ALL' | 'ORGANISATION'][]) {
  const [r] = await owner.db.insert(role).values({ tenantId, key, name: key }).returning({ id: role.id });
  await owner.db
    .insert(rolePermission)
    .values(grants.map(([permissionKey, scope]) => ({ tenantId, roleId: r!.id, permissionKey, scope })));
  return r!.id;
}

beforeAll(async () => {
  owner = createDatabase(inject('ownerUrl'), { max: 2 });
  ({ tenantId: tenantA } = await provisionTenant(owner.db, { name: 'Ext Alpha', slug: `exa-${suffix}` }));
  ({ tenantId: tenantB } = await provisionTenant(owner.db, { name: 'Ext Beta', slug: `exb-${suffix}` }));
  const passwordHash = await new PasswordService().hash(PASSWORD);
  for (const name of USERS) {
    const [u] = await owner.db
      .insert(appUser)
      .values({ email: email(name), displayName: name, passwordHash })
      .returning({ id: appUser.id });
    users[name] = u!.id;
  }
  // A limited user administrator: may invite, but holds no CRM/campaign permissions.
  await customRole(tenantA, 'inviter', [
    ['users.read', 'ALL'],
    ['users.invite', 'ALL'],
    ['roles.read', 'ALL'],
  ]);
  // An INTERNAL role carrying an external-party permission: the exemption must not apply to it.
  roleIds.internal_decider = await customRole(tenantA, 'internal_decider', [
    ['study.decide', 'ORGANISATION'],
  ]);

  await addMember(tenantA, 'admin', 'company_admin');
  await addMember(tenantA, 'sales', 'sales');
  await addMember(tenantA, 'viewer', 'viewer');
  await addMember(tenantA, 'inviter', 'inviter');
  await addMember(tenantB, 'adminB', 'company_admin');
  for (const key of ['end_client', 'agency_user', 'production_supplier', 'viewer', 'ooh_buyer'])
    roleIds[key] = await roleIdOf(tenantA, key);

  app = await createTestApp();
  for (const name of USERS) tokens[name] = await login(email(name), PASSWORD);
  carrefour = await createCompany('admin', `Carrefour Ext ${suffix}`);
  agencyX = await createCompany('admin', `Agency X Ext ${suffix}`);
});

afterAll(async () => {
  await app?.close();
  await owner?.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────

const bearer = (who: UserName | string) => ({
  authorization: `Bearer ${who in tokens ? tokens[who as UserName] : who}`,
});
const code = (response: LightMyRequestResponse) => response.json<{ code: string }>().code;

async function login(address: string, password: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: address, password },
  });
  expect(response.statusCode).toBe(200);
  return response.json<AuthSession>().accessToken;
}

async function createCompany(who: UserName, displayName: string): Promise<OrganisationDetail> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/organisations',
    headers: bearer(who),
    payload: { displayName },
  });
  expect(response.statusCode).toBe(201);
  return response.json<OrganisationDetail>();
}

const relationships = (who: UserName, orgId: string) =>
  app.inject({ method: 'GET', url: `/api/v1/organisations/${orgId}/relationships`, headers: bearer(who) });
const link = (who: UserName, fromId: string, toOrganisationId: string, kind = 'AGENCY_OF') =>
  app.inject({
    method: 'POST',
    url: `/api/v1/organisations/${fromId}/relationships`,
    headers: bearer(who),
    payload: { kind, toOrganisationId },
  });
const invite = (who: UserName, payload: object) =>
  app.inject({ method: 'POST', url: '/api/v1/memberships', headers: bearer(who), payload });

async function memberEtag(id: string) {
  const [row] = await owner.db
    .select({ version: membership.version })
    .from(membership)
    .where(eq(membership.id, id));
  return etagOf(row!.version);
}

// ── relationships ────────────────────────────────────────────────────────────

describe('relationships between companies', () => {
  it('links Agency X as agency of Carrefour, seen from both sides', async () => {
    const created = await link('admin', agencyX.id, carrefour.id);
    expect(created.statusCode).toBe(201);
    expect(created.json<OrganisationRelationshipItem[]>()).toMatchObject([
      { kind: 'AGENCY_OF', direction: 'OUTGOING', other: { id: carrefour.id } },
    ]);
    const fromClient = (await relationships('sales', carrefour.id)).json<OrganisationRelationshipItem[]>();
    expect(fromClient).toMatchObject([
      { kind: 'AGENCY_OF', direction: 'INCOMING', other: { id: agencyX.id } },
    ]);
  });

  it('refuses duplicates, self-links, and unknown or foreign companies', async () => {
    expect(code(await link('admin', agencyX.id, carrefour.id))).toBe('CONFLICT');
    expect((await link('admin', agencyX.id, agencyX.id)).statusCode).toBe(422);
    expect((await link('admin', agencyX.id, crypto.randomUUID())).statusCode).toBe(422);
    const foreign = await app
      .inject({
        method: 'POST',
        url: '/api/v1/organisations',
        headers: bearer('adminB'),
        payload: { displayName: `B ${suffix}` },
      })
      .then((r) => r.json<OrganisationDetail>());
    expect((await link('admin', agencyX.id, foreign.id)).statusCode).toBe(422);
    expect((await link('adminB', agencyX.id, foreign.id)).statusCode).toBe(404);
  });

  it('needs organisation.update on the "from" company (OWN: its account owner); links can be removed', async () => {
    // Sales holds organisation.update@OWN and doesn't own Agency X.
    const denied = await link('sales', agencyX.id, carrefour.id, 'PARENT_OF');
    expect(denied.statusCode).toBe(403);
    expect((await relationships('viewer', carrefour.id)).statusCode).toBe(403);

    const parent = (await link('admin', agencyX.id, carrefour.id, 'PARENT_OF')).json<
      OrganisationRelationshipItem[]
    >();
    const toRemove = parent.find((r) => r.kind === 'PARENT_OF')!;
    // Only from its "from" company.
    const wrongSide = await app.inject({
      method: 'DELETE',
      url: `/api/v1/organisations/${carrefour.id}/relationships/${toRemove.id}`,
      headers: bearer('admin'),
    });
    expect(wrongSide.statusCode).toBe(404);
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/organisations/${agencyX.id}/relationships/${toRemove.id}`,
      headers: bearer('admin'),
    });
    expect(removed.statusCode).toBe(204);
    expect((await relationships('admin', agencyX.id)).json<OrganisationRelationshipItem[]>()).toHaveLength(1);
  });
});

describe('account owners', () => {
  it('lists active internal members for the owner picker', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/organisations/account-owners',
      headers: bearer('sales'),
    });
    expect(response.statusCode).toBe(200);
    const ids = response.json<AccountOwnerCandidate[]>().map((c) => c.membershipId);
    expect(ids).toEqual(expect.arrayContaining([members.admin, members.sales, members.viewer]));
    expect(ids).not.toContain(members.adminB);
    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/organisations/account-owners',
      headers: bearer('viewer'),
    });
    expect(denied.statusCode).toBe(403);
  });
});

// ── external members ─────────────────────────────────────────────────────────

describe('external members', () => {
  let clientMember: MembershipListItem;
  let clientToken: string;

  it('an admin invites a person representing Carrefour with an external role', async () => {
    const response = await invite('admin', {
      email: email('client'),
      displayName: 'Carrefour Marketing',
      roleIds: [roleIds.end_client],
      organisationId: carrefour.id,
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<InviteMemberResponse>();
    clientMember = body.membership;
    expect(clientMember).toMatchObject({
      kind: 'EXTERNAL',
      status: 'INVITED',
      organisation: { id: carrefour.id, displayName: carrefour.displayName },
      roles: [{ key: 'end_client' }],
    });

    const accepted = await app.inject({
      method: 'POST',
      url: `/api/v1/auth/invitations/${body.invitation.token}/accept`,
      payload: { password: NEW_PASSWORD },
    });
    expect(accepted.statusCode).toBe(200);
    clientToken = accepted.json<AuthSession>().accessToken;
  });

  it('once signed in, holds external permissions for their own organisation and nothing internal', async () => {
    const me = (
      await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(clientToken) })
    ).json<MeResponse>();
    expect(me.membership.kind).toBe('EXTERNAL');
    expect(me.permissions['study.decide']).toBe('ORGANISATION');
    expect(me.permissions['organisation.read']).toBeUndefined();
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/organisations', headers: bearer(clientToken) }))
        .statusCode,
    ).toBe(403);

    const list = (
      await app.inject({ method: 'GET', url: '/api/v1/memberships', headers: bearer('admin') })
    ).json<Page<MembershipListItem>>();
    expect(list.data.find((m) => m.id === clientMember.id)).toMatchObject({
      kind: 'EXTERNAL',
      status: 'ACTIVE',
      organisation: { id: carrefour.id },
    });
  });

  it('admins manage external members: suspend, reactivate and switch between external roles', async () => {
    const act = async (name: string) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/memberships/${clientMember.id}/actions/${name}`,
        headers: { ...bearer('admin'), 'if-match': await memberEtag(clientMember.id) },
      });
    expect((await act('suspend')).statusCode).toBe(200);
    expect((await act('reactivate')).statusCode).toBe(200);

    const setRoles = async (ids: string[]) =>
      app.inject({
        method: 'PUT',
        url: `/api/v1/memberships/${clientMember.id}/roles`,
        headers: { ...bearer('admin'), 'if-match': await memberEtag(clientMember.id) },
        payload: { roleIds: ids },
      });
    expect((await setRoles([roleIds.agency_user!])).statusCode).toBe(200);
    const internal = await setRoles([roleIds.viewer!]);
    expect(internal.statusCode).toBe(422);
    expect(internal.json<{ detail: string }>().detail).toMatch(/only get external roles/);
  });

  it('external roles need a company; internal roles refuse one; roles are never mixed', async () => {
    const cases: [object, string][] = [
      [{ roleIds: [roleIds.end_client] }, 'external role without a company'],
      [{ roleIds: [roleIds.viewer], organisationId: carrefour.id }, 'internal role with a company'],
      [{ roleIds: [roleIds.end_client, roleIds.viewer], organisationId: carrefour.id }, 'mixed'],
      [{ roleIds: [roleIds.end_client], organisationId: crypto.randomUUID() }, 'unknown company'],
    ];
    for (const [payload, label] of cases) {
      const response = await invite('admin', {
        email: email(`bad-${label.length}`),
        displayName: 'X',
        ...payload,
      });
      expect(response.statusCode, label).toBe(422);
    }
  });

  it('the external-party exemption is narrow: not for internal roles, not for other permissions', async () => {
    // An internal role carrying study.decide is still escalation for an admin who doesn't hold it.
    const internal = await invite('admin', {
      email: email('internal-decider'),
      displayName: 'X',
      roleIds: [roleIds.internal_decider],
    });
    expect(internal.statusCode).toBe(403);
    expect(internal.json<{ meta: { permissions: string[] } }>().meta.permissions).toEqual(['study.decide']);

    // A limited user admin lacks End Client's other permissions (campaign.read…), so it's refused.
    const limited = await invite('inviter', {
      email: email('limited'),
      displayName: 'X',
      roleIds: [roleIds.end_client],
      organisationId: carrefour.id,
    });
    expect(limited.statusCode).toBe(403);
    expect(limited.json<{ meta: { permissions: string[] } }>().meta.permissions).not.toContain(
      'study.decide',
    );

    // Supplier and agency roles work for an admin too.
    for (const key of ['production_supplier', 'agency_user']) {
      const ok = await invite('admin', {
        email: email(key),
        displayName: key,
        roleIds: [roleIds[key]],
        organisationId: agencyX.id,
      });
      expect(ok.statusCode, key).toBe(201);
    }
  });
});
