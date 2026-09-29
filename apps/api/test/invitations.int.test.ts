/**
 * Invitations end to end: invite → preview → accept (new and existing accounts), resend, cancel,
 * and the authorization rules around them. Real HTTP pipeline, real PostgreSQL with RLS.
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type AuthSession,
  type InvitationPreview,
  type InviteMemberResponse,
  type IssuedInvitation,
  REFRESH_COOKIE_NAME,
} from '@ooh/contracts';
import {
  appUser,
  auditEvent,
  createDatabase,
  type DatabaseConnection,
  invitation,
  membership,
  membershipRole,
  provisionTenant,
  role,
  rolePermission,
} from '@ooh/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PasswordService } from '../src/core/auth/password.service';
import { createTestApp } from './support';

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a brand new passphrase';
const suffix = Date.now().toString(36);
const email = (name: string) => `${name}-${suffix}@example.com`;

let app: NestFastifyApplication;
let owner: DatabaseConnection;
let tenantA: string;
let tenantB: string;
const users = { admin: '', viewer: '', recruiter: '', existing: '', adminB: '' };
const roleIds: Record<string, string> = {};

async function roleId(tenantId: string, key: string): Promise<string> {
  const [r] = await owner.db
    .select({ id: role.id })
    .from(role)
    .where(and(eq(role.tenantId, tenantId), eq(role.key, key)));
  return r!.id;
}

async function addMember(tenantId: string, userId: string, roleKey: string) {
  const [m] = await owner.db
    .insert(membership)
    .values({ tenantId, userId, status: 'ACTIVE' })
    .returning({ id: membership.id });
  await owner.db
    .insert(membershipRole)
    .values({ tenantId, membershipId: m!.id, roleId: await roleId(tenantId, roleKey) });
}

/** A custom tenant role granting exactly `permissions` at scope ALL. */
async function customRole(tenantId: string, key: string, permissions: string[]) {
  const [r] = await owner.db.insert(role).values({ tenantId, key, name: key }).returning({ id: role.id });
  await owner.db
    .insert(rolePermission)
    .values(permissions.map((permissionKey) => ({ tenantId, roleId: r!.id, permissionKey })));
  return r!.id;
}

beforeAll(async () => {
  owner = createDatabase(inject('ownerUrl'), { max: 2 });
  ({ tenantId: tenantA } = await provisionTenant(owner.db, { name: 'Invite Alpha', slug: `ia-${suffix}` }));
  ({ tenantId: tenantB } = await provisionTenant(owner.db, { name: 'Invite Beta', slug: `ib-${suffix}` }));

  const passwordHash = await new PasswordService().hash(PASSWORD);
  for (const name of Object.keys(users) as (keyof typeof users)[]) {
    const [u] = await owner.db
      .insert(appUser)
      .values({ email: email(name), displayName: name, passwordHash })
      .returning({ id: appUser.id });
    users[name] = u!.id;
  }
  roleIds.reader = await customRole(tenantA, 'reader', ['users.read']);
  await customRole(tenantA, 'recruiter', ['users.read', 'users.invite']);

  await addMember(tenantA, users.admin, 'company_admin');
  await addMember(tenantA, users.viewer, 'viewer');
  await addMember(tenantA, users.recruiter, 'recruiter');
  await addMember(tenantB, users.existing, 'viewer');
  await addMember(tenantB, users.adminB, 'company_admin');
  for (const key of ['ooh_buyer', 'viewer', 'company_admin', 'end_client'])
    roleIds[key] = await roleId(tenantA, key);

  app = await createTestApp();
});

afterAll(async () => {
  await app?.close();
  await owner?.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function tokenFor(who: keyof typeof users, tenantId?: string, password = PASSWORD) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: email(who), password, tenantId },
  });
  expect(response.statusCode).toBe(200);
  return response.json<AuthSession>().accessToken;
}

const invite = (token: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/v1/memberships', headers: bearer(token), payload });

const membershipAction = (token: string, id: string, action: string) =>
  app.inject({ method: 'POST', url: `/api/v1/memberships/${id}/actions/${action}`, headers: bearer(token) });

const preview = (token: string) => app.inject({ method: 'GET', url: `/api/v1/auth/invitations/${token}` });

const accept = (token: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/v1/auth/invitations/${token}/accept`, payload });

async function invited(adminToken: string, name: string, roles = [roleIds.ooh_buyer!]) {
  const response = await invite(adminToken, {
    email: email(name),
    displayName: `Invited ${name}`,
    roleIds: roles,
  });
  expect(response.statusCode).toBe(201);
  return response.json<InviteMemberResponse>();
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('inviting', () => {
  it('creates an INVITED membership with its roles and returns a one-time link token', async () => {
    const admin = await tokenFor('admin');
    const body = await invited(admin, 'newbie');

    expect(body.membership).toMatchObject({
      email: email('newbie'),
      displayName: 'Invited newbie',
      kind: 'INTERNAL',
      status: 'INVITED',
    });
    expect(body.membership.roles.map((r) => r.key)).toEqual(['ooh_buyer']);
    expect(body.invitation.token).toMatch(new RegExp(`^${body.invitation.id}\\.[A-Za-z0-9_-]{43}$`));
    expect(new Date(body.invitation.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);

    const [stored] = await owner.db.select().from(invitation).where(eq(invitation.id, body.invitation.id));
    expect(stored?.tokenHash).not.toContain(body.invitation.token.split('.')[1]);

    const list = await app.inject({ method: 'GET', url: '/api/v1/memberships', headers: bearer(admin) });
    expect(list.json<{ data: { email: string; status: string }[] }>().data).toContainEqual(
      expect.objectContaining({ email: email('newbie'), status: 'INVITED' }),
    );

    const events = await owner.db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, 'membership.invited'), eq(auditEvent.subjectId, body.membership.id)));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tenantId: tenantA, actorUserId: users.admin });
  });

  it('rejects inviting someone who is already invited or already a member', async () => {
    const admin = await tokenFor('admin');
    await invited(admin, 'twice');
    const again = await invite(admin, {
      email: email('twice'),
      displayName: 'Twice',
      roleIds: [roleIds.ooh_buyer],
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ detail: string }>().detail).toMatch(/already been invited/);

    const member = await invite(admin, {
      email: email('viewer').toUpperCase(),
      displayName: 'Viewer',
      roleIds: [roleIds.ooh_buyer],
    });
    expect(member.statusCode).toBe(409);
    expect(member.json<{ detail: string }>().detail).toMatch(/already a member/);
  });

  it('requires users.invite', async () => {
    const response = await invite(await tokenFor('viewer'), {
      email: email('nope'),
      displayName: 'Nope',
      roleIds: [roleIds.viewer],
    });
    expect(response.statusCode).toBe(403);
  });

  it('never lets an inviter grant permissions they do not hold', async () => {
    const recruiter = await tokenFor('recruiter');
    const escalate = await invite(recruiter, {
      email: email('escalate'),
      displayName: 'Escalate',
      roleIds: [roleIds.company_admin],
    });
    expect(escalate.statusCode).toBe(403);
    expect(escalate.json<{ meta: { permissions: string[] } }>().meta.permissions).toContain('roles.manage');

    const allowed = await invite(recruiter, {
      email: email('reader'),
      displayName: 'Reader',
      roleIds: [roleIds.reader],
    });
    expect(allowed.statusCode).toBe(201);
  });

  it('rejects unknown, foreign-tenant and external roles', async () => {
    const admin = await tokenFor('admin');
    const foreignRole = await roleId(tenantB, 'viewer');
    for (const ids of [[crypto.randomUUID()], [foreignRole], [roleIds.end_client]]) {
      const response = await invite(admin, { email: email('badrole'), displayName: 'Bad', roleIds: ids });
      expect(response.statusCode).toBe(422);
    }
    const noRoles = await invite(admin, { email: email('badrole'), displayName: 'Bad', roleIds: [] });
    expect(noRoles.statusCode).toBe(422);
  });
});

describe('accepting as a new user', () => {
  it('previews, sets a password, activates the membership and signs the user in', async () => {
    const { invitation: issued, membership: member } = await invited(await tokenFor('admin'), 'fresh');

    const shown = await preview(issued.token);
    expect(shown.statusCode).toBe(200);
    expect(shown.json<InvitationPreview>()).toMatchObject({
      email: email('fresh'),
      displayName: 'Invited fresh',
      tenantName: 'Invite Alpha',
      hasAccount: false,
    });

    const weak = await accept(issued.token, { password: 'short' });
    expect(weak.statusCode).toBe(422);

    const accepted = await accept(issued.token, { password: NEW_PASSWORD, displayName: 'Fresh Person' });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<AuthSession>()).toMatchObject({ tenantId: tenantA, membershipId: member.id });
    expect(accepted.cookies.some((c) => c.name === REFRESH_COOKIE_NAME && c.httpOnly)).toBe(true);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(accepted.json<AuthSession>().accessToken),
    });
    expect(
      me.json<{ user: { displayName: string }; membership: { roles: { key: string }[] } }>(),
    ).toMatchObject({
      user: { displayName: 'Fresh Person' },
      membership: { roles: [{ key: 'ooh_buyer' }] },
    });

    // The link is single-use, and the new password works for normal sign-in.
    const reused = await accept(issued.token, { password: NEW_PASSWORD });
    expect(reused.statusCode).toBe(404);
    expect(reused.json<{ code: string }>().code).toBe('INVITATION_INVALID');
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: email('fresh'), password: NEW_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
  });
});

describe('accepting with an existing account', () => {
  it('requires the account’s current password, so the link alone cannot take it over', async () => {
    const { invitation: issued } = await invited(await tokenFor('admin'), 'existing');
    expect((await preview(issued.token)).json<InvitationPreview>().hasAccount).toBe(true);

    const wrong = await accept(issued.token, { password: 'attacker chosen password' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json<{ code: string }>().code).toBe('INVALID_CREDENTIALS');

    const accepted = await accept(issued.token, { password: PASSWORD });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<AuthSession>().tenantId).toBe(tenantA);

    // Now a member of both tenants, with the password unchanged.
    await tokenFor('existing', tenantA);
    await tokenFor('existing', tenantB);
  });
});

describe('invalid links', () => {
  it('rejects malformed, unknown, expired and wrong-secret tokens the same way', async () => {
    const { invitation: issued } = await invited(await tokenFor('admin'), 'expiring');
    const [id] = issued.token.split('.');
    const tampered = `${id}.${'A'.repeat(43)}`;
    await owner.db
      .update(invitation)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitation.id, issued.id));

    for (const token of ['garbage', `${crypto.randomUUID()}.${'B'.repeat(43)}`, tampered, issued.token]) {
      const response = await preview(token);
      expect(response.statusCode).toBe(404);
      expect(response.json<{ code: string }>().code).toBe('INVITATION_INVALID');
    }
    expect((await accept(issued.token, { password: NEW_PASSWORD })).statusCode).toBe(404);
  });
});

describe('resending and cancelling', () => {
  it('resend replaces the link: the old one stops working, the new one works', async () => {
    const admin = await tokenFor('admin');
    const first = await invited(admin, 'resent');
    const resent = await membershipAction(admin, first.membership.id, 'resend-invitation');
    expect(resent.statusCode).toBe(200);
    const second = resent.json<IssuedInvitation>();

    expect((await preview(first.invitation.token)).statusCode).toBe(404);
    expect((await preview(second.token)).statusCode).toBe(200);
  });

  it('cancel removes the invited membership and invalidates the link', async () => {
    const admin = await tokenFor('admin');
    const { invitation: issued, membership: member } = await invited(admin, 'cancelled');
    const cancelled = await membershipAction(admin, member.id, 'cancel-invitation');
    expect(cancelled.statusCode).toBe(204);

    expect((await preview(issued.token)).statusCode).toBe(404);
    expect(await owner.db.select().from(membership).where(eq(membership.id, member.id))).toHaveLength(0);
    // The person can be invited again afterwards.
    await invited(admin, 'cancelled');
  });

  it('refuses to resend or cancel for a member who already accepted', async () => {
    const admin = await tokenFor('admin');
    const { invitation: issued, membership: member } = await invited(admin, 'accepted');
    expect((await accept(issued.token, { password: NEW_PASSWORD })).statusCode).toBe(200);

    for (const action of ['resend-invitation', 'cancel-invitation']) {
      const response = await membershipAction(admin, member.id, action);
      expect(response.statusCode).toBe(409);
      expect(response.json<{ code: string }>().code).toBe('INVALID_TRANSITION');
    }
  });

  it('cannot touch invitations of another tenant', async () => {
    const { membership: member } = await invited(await tokenFor('admin'), 'foreign');
    const otherAdmin = await tokenFor('adminB');
    for (const action of ['resend-invitation', 'cancel-invitation']) {
      expect((await membershipAction(otherAdmin, member.id, action)).statusCode).toBe(404);
    }
  });
});
