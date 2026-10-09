/**
 * Briefs end to end (M3a, 04-user-flows.md A2'–A4): create (with lines), edit drafts, replace lines,
 * confirm / reopen / discard with the required-field check, status history + outbox, a brief from a
 * won opportunity (completing its "Create brief" task), OWN scope and tenant isolation.
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type AuthSession,
  type BriefDetail,
  type BriefListItem,
  etagOf,
  type OpportunityDetail,
  type OrganisationDetail,
  type Page,
  type TaskItem,
} from '@ooh/contracts';
import {
  appUser,
  createDatabase,
  type DatabaseConnection,
  membership,
  membershipRole,
  outboxEvent,
  provisionTenant,
  role,
  rolePermission,
  statusHistory,
} from '@ooh/db';
import { and, asc, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PasswordService } from '../src/core/auth/password.service';
import { createTestApp, drainOutbox } from './support';

const PASSWORD = 'correct horse battery staple';
const suffix = Date.now().toString(36);
const email = (name: string) => `${name}-${suffix}@example.com`;

type UserName = 'admin' | 'buyer' | 'sales' | 'ownBuyer' | 'adminB';
const members = {} as Record<UserName, string>;
const tokens = {} as Record<UserName, string>;

let app: NestFastifyApplication;
let owner: DatabaseConnection;
let carrefour: OrganisationDetail;
let agencyX: OrganisationDetail;
let foreignCompany: OrganisationDetail;

beforeAll(async () => {
  owner = createDatabase(inject('ownerUrl'), { max: 2 });
  const { tenantId: tenantA } = await provisionTenant(owner.db, {
    name: 'Briefs Alpha',
    slug: `bra-${suffix}`,
  });
  const { tenantId: tenantB } = await provisionTenant(owner.db, {
    name: 'Briefs Beta',
    slug: `brb-${suffix}`,
  });
  // A custom role that sees and edits only its own briefs (OWN scope).
  const [ownRole] = await owner.db
    .insert(role)
    .values({ tenantId: tenantA, key: `custom_own_${suffix}`, name: 'Own briefs' })
    .returning({ id: role.id });
  await owner.db.insert(rolePermission).values(
    ['brief.read', 'brief.update', 'brief.confirm'].map((permissionKey) => ({
      tenantId: tenantA,
      roleId: ownRole!.id,
      permissionKey,
      scope: 'OWN' as const,
    })),
  );
  await owner.db
    .insert(rolePermission)
    .values({ tenantId: tenantA, roleId: ownRole!.id, permissionKey: 'brief.create', scope: 'ALL' });

  const passwordHash = await new PasswordService().hash(PASSWORD);
  const add = async (tenantId: string, name: UserName, roleKey: string) => {
    const [u] = await owner.db
      .insert(appUser)
      .values({ email: email(name), displayName: name, passwordHash })
      .returning({ id: appUser.id });
    const [m] = await owner.db
      .insert(membership)
      .values({ tenantId, userId: u!.id, status: 'ACTIVE' })
      .returning({ id: membership.id });
    const [r] = await owner.db
      .select({ id: role.id })
      .from(role)
      .where(and(eq(role.tenantId, tenantId), eq(role.key, roleKey)));
    await owner.db.insert(membershipRole).values({ tenantId, membershipId: m!.id, roleId: r!.id });
    members[name] = m!.id;
  };
  await add(tenantA, 'admin', 'company_admin');
  await add(tenantA, 'buyer', 'ooh_buyer');
  await add(tenantA, 'sales', 'sales');
  await add(tenantA, 'ownBuyer', `custom_own_${suffix}`);
  await add(tenantB, 'adminB', 'company_admin');

  app = await createTestApp();
  for (const name of ['admin', 'buyer', 'sales', 'ownBuyer', 'adminB'] as const) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: email(name), password: PASSWORD },
    });
    tokens[name] = response.json<AuthSession>().accessToken;
  }
  carrefour = (await send('admin', 'POST', '/organisations', { displayName: `Carrefour ${suffix}` })).json();
  agencyX = (await send('admin', 'POST', '/organisations', { displayName: `Agency X ${suffix}` })).json();
  foreignCompany = (
    await send('adminB', 'POST', '/organisations', { displayName: `Elsewhere ${suffix}` })
  ).json();
});

afterAll(async () => {
  await app?.close();
  await owner?.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────

function send(
  who: UserName,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  path: string,
  payload?: object,
  version?: number,
) {
  return app.inject({
    method,
    url: `/api/v1${path}`,
    headers: {
      authorization: `Bearer ${tokens[who]}`,
      ...(version === undefined ? {} : { 'if-match': etagOf(version) }),
    },
    ...(payload ? { payload } : {}),
  });
}
const code = (response: LightMyRequestResponse) => response.json<{ code: string }>().code;
const act = (who: UserName, b: BriefDetail, action: string, payload?: object) =>
  send(who, 'POST', `/briefs/${b.id}/actions/${action}`, payload ?? {}, b.version);
const sinaia = {
  storeName: 'Carrefour Sinaia',
  address: 'Str. Principală 1',
  city: 'Sinaia',
  requestedUnits: 7,
};

// ── tests ────────────────────────────────────────────────────────────────────

describe('briefs', () => {
  it('Sales create a brief with its lines; it starts as a draft with history and an outbox event', async () => {
    const response = await send('sales', 'POST', '/briefs', {
      title: '  New store openings 2027 ',
      clientOrganisationId: carrefour.id,
      agencyOrganisationId: agencyX.id,
      lines: [sinaia, { storeName: 'Carrefour Brașov', city: 'Brașov' }],
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers.etag).toBe(etagOf(1));
    const created = response.json<BriefDetail>();
    expect(created).toMatchObject({
      title: 'New store openings 2027',
      status: 'DRAFT',
      source: 'MANUAL',
      client: { id: carrefour.id },
      agency: { id: agencyX.id },
      owner: { membershipId: members.sales },
      lineCount: 2,
      currency: 'RON',
      actions: ['confirm', 'discard'],
    });
    expect(created.lines.map((l) => [l.position, l.storeName])).toEqual([
      [1, 'Carrefour Sinaia'],
      [2, 'Carrefour Brașov'],
    ]);
    const history = await owner.db
      .select()
      .from(statusHistory)
      .where(eq(statusHistory.subjectId, created.id));
    expect(history).toEqual([
      expect.objectContaining({ fromStatus: null, toStatus: 'DRAFT', action: 'create' }),
    ]);
    const events = await owner.db
      .select({ type: outboxEvent.eventType, payload: outboxEvent.payload })
      .from(outboxEvent)
      .where(eq(outboxEvent.eventType, 'brief.created'));
    expect(events.some((e) => e.payload.briefId === created.id)).toBe(true);

    // Sales create but don't edit (03-rbac: Briefs = VC for Sales).
    expect((await send('sales', 'PATCH', `/briefs/${created.id}`, { title: 'X' }, 1)).statusCode).toBe(403);
  });

  it('validates companies, owner and dates', async () => {
    const bad = (payload: object) => send('buyer', 'POST', '/briefs', { title: 'X', ...payload });
    expect(code(await bad({ clientOrganisationId: foreignCompany.id }))).toBe('VALIDATION_FAILED');
    expect(code(await bad({ clientOrganisationId: carrefour.id, agencyOrganisationId: carrefour.id }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(code(await bad({ ownerMembershipId: members.adminB }))).toBe('VALIDATION_FAILED');
    expect(code(await bad({ requestedStart: '2027-03-10', requestedEnd: '2027-03-01' }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(code(await bad({ lines: [{ storeName: ' ' }] }))).toBe('VALIDATION_FAILED');
  });

  it('buyers edit drafts and replace lines with If-Match', async () => {
    let b = (await send('buyer', 'POST', '/briefs', { title: `Edit ${suffix}` })).json<BriefDetail>();
    expect((await send('buyer', 'PATCH', `/briefs/${b.id}`, { title: 'Y' })).statusCode).toBe(428);
    const edited = await send(
      'buyer',
      'PATCH',
      `/briefs/${b.id}`,
      {
        clientOrganisationId: carrefour.id,
        budget: '120000',
        requestedStart: '2027-03-01',
        requestedEnd: '2027-05-31',
      },
      b.version,
    );
    expect(edited.statusCode).toBe(200);
    b = edited.json<BriefDetail>();
    expect(b).toMatchObject({ budget: '120000.00', requestedEnd: '2027-05-31', version: 2 });
    // The new end must not precede the stored start.
    expect(
      code(await send('buyer', 'PATCH', `/briefs/${b.id}`, { requestedEnd: '2027-01-01' }, b.version)),
    ).toBe('VALIDATION_FAILED');

    const replaced = await send('buyer', 'PUT', `/briefs/${b.id}/lines`, { lines: [sinaia] }, b.version);
    expect(replaced.statusCode).toBe(200);
    b = replaced.json<BriefDetail>();
    expect(b).toMatchObject({ lineCount: 1, version: 3 });
    expect((await send('buyer', 'PUT', `/briefs/${b.id}/lines`, { lines: [] }, 2)).statusCode).toBe(412);
  });

  it('confirm checks what a campaign needs; confirmed briefs are read-only; reopen and discard', async () => {
    let b = (await send('buyer', 'POST', '/briefs', { title: `Machine ${suffix}` })).json<BriefDetail>();
    const missing = await act('buyer', b, 'confirm');
    expect(missing.statusCode).toBe(422);
    expect(
      missing
        .json<{ errors: { path: string }[] }>()
        .errors.map((e) => e.path)
        .sort(),
    ).toEqual(['clientOrganisationId', 'lines', 'requestedStart'].sort());

    b = (
      await send(
        'buyer',
        'PATCH',
        `/briefs/${b.id}`,
        { clientOrganisationId: carrefour.id, datesTbd: true },
        b.version,
      )
    ).json();
    b = (await send('buyer', 'PUT', `/briefs/${b.id}/lines`, { lines: [sinaia] }, b.version)).json();
    b = (await act('buyer', b, 'confirm')).json<BriefDetail>();
    expect(b).toMatchObject({ status: 'CONFIRMED', actions: ['reopen', 'convert', 'discard'] });
    expect(b.confirmedAt).not.toBeNull();
    expect(code(await send('buyer', 'PATCH', `/briefs/${b.id}`, { title: 'Late' }, b.version))).toBe(
      'INVALID_TRANSITION',
    );

    b = (await act('buyer', b, 'reopen')).json<BriefDetail>();
    expect(b).toMatchObject({ status: 'DRAFT', confirmedAt: null });
    expect((await act('buyer', b, 'discard', { reason: '' })).statusCode).toBe(422);
    b = (await act('buyer', b, 'discard', { reason: 'Client postponed' })).json<BriefDetail>();
    expect(b).toMatchObject({ status: 'DISCARDED', discardReason: 'Client postponed', actions: [] });
    const again = await act('buyer', b, 'confirm');
    expect(again.statusCode).toBe(409);
    expect(again.json<{ meta: { allowedActions: string[] } }>().meta.allowedActions).toEqual([]);

    const history = await owner.db
      .select({ to: statusHistory.toStatus, action: statusHistory.action })
      .from(statusHistory)
      .where(eq(statusHistory.subjectId, b.id))
      .orderBy(asc(statusHistory.occurredAt));
    expect(history.map((h) => `${h.action}:${h.to}`)).toEqual([
      'create:DRAFT',
      'confirm:CONFIRMED',
      'reopen:DRAFT',
      'discard:DISCARDED',
    ]);
    const events = await owner.db
      .select({ type: outboxEvent.eventType, payload: outboxEvent.payload })
      .from(outboxEvent);
    expect(events.filter((e) => e.payload.briefId === b.id).map((e) => e.type)).toEqual([
      'brief.created',
      'brief.confirmed',
      'brief.reopened',
      'brief.discarded',
    ]);
  });

  it('OWN scope: sees and changes only own briefs', async () => {
    const mine = (await send('ownBuyer', 'POST', '/briefs', { title: `Mine ${suffix}` })).json<BriefDetail>();
    const theirs = (
      await send('buyer', 'POST', '/briefs', { title: `Theirs ${suffix}` })
    ).json<BriefDetail>();
    const listed = (await send('ownBuyer', 'GET', '/briefs?limit=100')).json<Page<BriefListItem>>();
    expect(listed.data.map((b) => b.id)).toEqual([mine.id]);
    expect((await send('ownBuyer', 'GET', `/briefs/${theirs.id}`)).statusCode).toBe(404);
    expect(
      (await send('ownBuyer', 'PATCH', `/briefs/${mine.id}`, { title: 'Ok' }, mine.version)).statusCode,
    ).toBe(200);
  });

  it('never reaches another tenant', async () => {
    const b = (await send('buyer', 'POST', '/briefs', { title: `Private ${suffix}` })).json<BriefDetail>();
    expect((await send('adminB', 'GET', `/briefs/${b.id}`)).statusCode).toBe(404);
    expect((await act('adminB', b, 'discard', { reason: 'Not mine' })).statusCode).toBe(404);
    const listed = (await send('adminB', 'GET', '/briefs?limit=100')).json<Page<BriefListItem>>();
    expect(listed.data.some((x) => x.id === b.id)).toBe(false);
  });
});

describe('brief from a won opportunity', () => {
  it('prefills from the deal, completes its "Create brief" task, and happens once', async () => {
    let opp = (
      await send('sales', 'POST', '/opportunities', {
        organisationId: carrefour.id,
        name: `Sinaia flags ${suffix}`,
        estimatedValue: '45000',
        currency: 'EUR',
        expectedCloseDate: '2026-10-15',
      })
    ).json<OpportunityDetail>();
    expect(code(await send('sales', 'POST', `/opportunities/${opp.id}/brief`))).toBe('INVALID_TRANSITION');
    opp = (await send('sales', 'POST', `/opportunities/${opp.id}/actions/win`, {}, opp.version)).json();
    await drainOutbox(app); // the worker creates "Create brief"

    const response = await send('sales', 'POST', `/opportunities/${opp.id}/brief`);
    expect(response.statusCode).toBe(201);
    const b = response.json<BriefDetail>();
    expect(b).toMatchObject({
      title: `Sinaia flags ${suffix}`,
      source: 'OPPORTUNITY',
      status: 'DRAFT',
      client: { id: carrefour.id },
      opportunity: { id: opp.id },
      budget: '45000.00',
      currency: 'EUR',
      owner: { membershipId: members.sales },
    });
    const tasks = (await send('sales', 'GET', `/tasks?opportunityId=${opp.id}&state=all`)).json<
      Page<TaskItem>
    >();
    expect(tasks.data).toEqual([
      expect.objectContaining({ title: `Create brief: Sinaia flags ${suffix}`, status: 'DONE' }),
    ]);

    const twice = await send('sales', 'POST', `/opportunities/${opp.id}/brief`);
    expect(twice.statusCode).toBe(409);
    expect(twice.json<{ meta: { briefId: string } }>().meta.briefId).toBe(b.id);
    const listed = (await send('buyer', 'GET', `/briefs?opportunityId=${opp.id}`)).json<
      Page<BriefListItem>
    >();
    expect(listed.data.map((x) => x.id)).toEqual([b.id]);
  });
});
