/**
 * Sales pipeline end to end (M2c): the default pipeline, opportunities through their state machine
 * (06-state-machines.md §2), the company timeline, OWN scopes, If-Match and tenant isolation.
 * Roadmap acceptance (12-roadmap.md, M2): "opportunity WON".
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type ActivityItem,
  type ActivityTypeItem,
  type AuthSession,
  type ContactDetail,
  etagOf,
  type OpportunityDetail,
  type OpportunityListItem,
  type OrganisationDetail,
  type Page,
  type PipelineItem,
} from '@ooh/contracts';
import {
  activity,
  appUser,
  auditEvent,
  createDatabase,
  type DatabaseConnection,
  membership,
  membershipRole,
  opportunity,
  provisionTenant,
  role,
} from '@ooh/db';
import { and, eq, sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PasswordService } from '../src/core/auth/password.service';
import { createTestApp } from './support';

const PASSWORD = 'correct horse battery staple';
const suffix = Date.now().toString(36);
const email = (name: string) => `${name}-${suffix}@example.com`;

const USERS = ['admin', 'sales1', 'sales2', 'management', 'buyer', 'adminB'] as const;
type UserName = (typeof USERS)[number];
const users = {} as Record<UserName, string>;
const members = {} as Record<UserName, string>;
const tokens = {} as Record<UserName, string>;

let app: NestFastifyApplication;
let owner: DatabaseConnection;
let tenantA: string;
let tenantB: string;
let carrefour: OrganisationDetail;
let otherCompany: OrganisationDetail;
let buyerContact: ContactDetail;
let pipelineA: PipelineItem;
const stage = (name: string) => pipelineA.stages.find((s) => s.name === name)!;
const types: Record<string, string> = {};

async function addMember(tenantId: string, name: UserName, roleKey: string) {
  const [m] = await owner.db
    .insert(membership)
    .values({ tenantId, userId: users[name], status: 'ACTIVE' })
    .returning({ id: membership.id });
  const [r] = await owner.db
    .select({ id: role.id })
    .from(role)
    .where(and(eq(role.tenantId, tenantId), eq(role.key, roleKey)));
  await owner.db.insert(membershipRole).values({ tenantId, membershipId: m!.id, roleId: r!.id });
  members[name] = m!.id;
}

beforeAll(async () => {
  owner = createDatabase(inject('ownerUrl'), { max: 2 });
  ({ tenantId: tenantA } = await provisionTenant(owner.db, { name: 'Sales Alpha', slug: `sla-${suffix}` }));
  ({ tenantId: tenantB } = await provisionTenant(owner.db, { name: 'Sales Beta', slug: `slb-${suffix}` }));
  const passwordHash = await new PasswordService().hash(PASSWORD);
  for (const name of USERS) {
    const [u] = await owner.db
      .insert(appUser)
      .values({ email: email(name), displayName: name, passwordHash })
      .returning({ id: appUser.id });
    users[name] = u!.id;
  }
  await addMember(tenantA, 'admin', 'company_admin');
  await addMember(tenantA, 'sales1', 'sales');
  await addMember(tenantA, 'sales2', 'sales');
  await addMember(tenantA, 'management', 'management');
  await addMember(tenantA, 'buyer', 'ooh_buyer');
  await addMember(tenantB, 'adminB', 'company_admin');

  app = await createTestApp();
  for (const name of USERS) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: email(name), password: PASSWORD },
    });
    tokens[name] = response.json<AuthSession>().accessToken;
  }
  const post = <T>(who: UserName, url: string, payload: object) =>
    app
      .inject({ method: 'POST', url: `/api/v1${url}`, headers: bearer(who), payload })
      .then((r) => r.json<T>());
  carrefour = await post<OrganisationDetail>('admin', '/organisations', {
    displayName: `Carrefour Sales ${suffix}`,
  });
  otherCompany = await post<OrganisationDetail>('admin', '/organisations', {
    displayName: `Other Sales ${suffix}`,
  });
  buyerContact = await post<ContactDetail>('admin', '/contacts', {
    organisationId: carrefour.id,
    firstName: 'Ioana',
  });
  pipelineA = (await get('sales1', '/config/pipelines')).json<PipelineItem[]>()[0]!;
  for (const t of (await get('sales1', '/config/activity-types')).json<ActivityTypeItem[]>())
    types[t.key] = t.id;
});

afterAll(async () => {
  await app?.close();
  await owner?.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────

const bearer = (who: UserName) => ({ authorization: `Bearer ${tokens[who]}` });
const code = (response: LightMyRequestResponse) => response.json<{ code: string }>().code;
const get = (who: UserName, path: string) =>
  app.inject({ method: 'GET', url: `/api/v1${path}`, headers: bearer(who) });
const createOpp = (who: UserName, payload: object) =>
  app.inject({ method: 'POST', url: '/api/v1/opportunities', headers: bearer(who), payload });
async function etag(id: string) {
  const [row] = await owner.db
    .select({ version: opportunity.version })
    .from(opportunity)
    .where(eq(opportunity.id, id));
  return etagOf(row!.version);
}
const act = async (
  who: UserName,
  id: string,
  action: string,
  payload: object = {},
  ifMatch?: string | null,
) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/opportunities/${id}/actions/${action}`,
    headers: { ...bearer(who), ...(ifMatch === null ? {} : { 'if-match': ifMatch ?? (await etag(id)) }) },
    payload,
  });
const patchOpp = async (who: UserName, id: string, payload: object) =>
  app.inject({
    method: 'PATCH',
    url: `/api/v1/opportunities/${id}`,
    headers: { ...bearer(who), 'if-match': await etag(id) },
    payload,
  });
const timeline = (who: UserName, query: string) =>
  get(who, `/activities${query}`).then((r) => r.json<Page<ActivityItem>>());

async function newOpp(who: UserName, name: string, extra: object = {}): Promise<OpportunityDetail> {
  const response = await createOpp(who, { organisationId: carrefour.id, name, ...extra });
  expect(response.statusCode).toBe(201);
  return response.json<OpportunityDetail>();
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('pipeline configuration', () => {
  it('every tenant starts with the default pipeline (lead stages first) and activity types', () => {
    expect(pipelineA).toMatchObject({ name: 'Sales pipeline', isDefault: true });
    expect(pipelineA.stages.map((s) => `${s.name}:${s.kind}`)).toEqual([
      'Lead:OPEN',
      'Contacted:OPEN',
      'Qualified:OPEN',
      'Proposal:OPEN',
      'Negotiation:OPEN',
      'Won:WON',
      'Lost:LOST',
    ]);
    expect(Object.keys(types)).toEqual(
      expect.arrayContaining(['call', 'meeting', 'email', 'note', 'stage_change']),
    );
  });
});

describe('the sales flow', () => {
  let deal: OpportunityDetail;

  it('creates an opportunity in the first open stage, owned by its creator', async () => {
    deal = await newOpp('sales1', 'Carrefour Sinaia wayfinding', {
      contactId: buyerContact.id,
      source: 'Referral',
    });
    expect(deal).toMatchObject({
      stage: { name: 'Lead', kind: 'OPEN' },
      probability: 10,
      currency: 'RON',
      owner: { membershipId: members.sales1 },
      contact: { id: buyerContact.id, name: 'Ioana' },
      closedAt: null,
      version: 1,
    });
  });

  it('moves through open stages, each move logged on the company timeline', async () => {
    const moved = await act('sales1', deal.id, 'move-stage', { stageId: stage('Proposal').id });
    expect(moved.statusCode).toBe(200);
    expect(moved.json<OpportunityDetail>()).toMatchObject({ stage: { name: 'Proposal' }, probability: 50 });
    expect(moved.headers.etag).toBe(etagOf(2));

    const entries = await timeline('sales1', `?opportunityId=${deal.id}`);
    expect(entries.data[0]).toMatchObject({
      subject: 'Moved from Lead to Proposal',
      type: { key: 'stage_change', isSystem: true },
      author: null,
    });
    // Closing goes through win/lose, not move-stage.
    expect((await act('sales1', deal.id, 'move-stage', { stageId: stage('Won').id })).statusCode).toBe(422);
  });

  it('acceptance: the opportunity is WON, which needs a value and a close date', async () => {
    const missing = await act('sales1', deal.id, 'win');
    expect(missing.statusCode).toBe(422);
    expect(missing.json<{ errors: { path: string }[] }>().errors.map((e) => e.path)).toEqual([
      'estimatedValue',
      'expectedCloseDate',
    ]);

    const won = await act('sales1', deal.id, 'win', {
      estimatedValue: '48500.00',
      expectedCloseDate: '2026-11-15',
    });
    expect(won.statusCode).toBe(200);
    expect(won.json<OpportunityDetail>()).toMatchObject({
      stage: { name: 'Won', kind: 'WON' },
      estimatedValue: '48500.00',
      expectedCloseDate: '2026-11-15',
      probability: 100,
    });
    expect(won.json<OpportunityDetail>().closedAt).not.toBeNull();

    const [event] = await owner.db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, 'opportunity.won'), eq(auditEvent.subjectId, deal.id)));
    expect(event?.changes).toEqual({ stage: { from: 'Proposal', to: 'Won' } });
    expect((await timeline('sales1', `?opportunityId=${deal.id}`)).data[0]?.subject).toBe(
      'Won (48500.00 RON)',
    );
  });

  it('a won opportunity is closed: no stage moves, no losing, value and date stay', async () => {
    expect(code(await act('sales1', deal.id, 'move-stage', { stageId: stage('Lead').id }))).toBe(
      'INVALID_TRANSITION',
    );
    expect(code(await act('sales1', deal.id, 'lose', { lostReason: 'Changed mind' }))).toBe(
      'INVALID_TRANSITION',
    );
    expect((await patchOpp('sales1', deal.id, { estimatedValue: null })).statusCode).toBe(422);
    expect((await patchOpp('sales1', deal.id, { nextAction: 'Create the brief' })).statusCode).toBe(200);
  });

  it('only Management reopens, with a reason, into the first open stage', async () => {
    expect((await act('sales1', deal.id, 'reopen', { reason: 'Client asked again' })).statusCode).toBe(403);
    const reopened = await act('management', deal.id, 'reopen', { reason: 'Client extended the scope' });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json<OpportunityDetail>()).toMatchObject({
      stage: { name: 'Lead', kind: 'OPEN' },
      closedAt: null,
    });
    expect((await timeline('sales1', `?opportunityId=${deal.id}`)).data[0]).toMatchObject({
      subject: 'Reopened into Lead',
      body: 'Client extended the scope',
    });
  });

  it('losing needs a reason', async () => {
    const other = await newOpp('sales1', 'Lidl pylons');
    expect((await act('sales1', other.id, 'lose', { lostReason: 'x' })).statusCode).toBe(422);
    const lost = await act('sales1', other.id, 'lose', { lostReason: 'Budget cut' });
    expect(lost.json<OpportunityDetail>()).toMatchObject({
      stage: { kind: 'LOST' },
      lostReason: 'Budget cut',
      probability: 0,
    });
  });
});

describe('rules and scopes', () => {
  it('validates company, contact, owner and pipeline', async () => {
    const cases: object[] = [
      { organisationId: crypto.randomUUID(), name: 'X' },
      { organisationId: carrefour.id, name: 'X', contactId: crypto.randomUUID() },
      { organisationId: otherCompany.id, name: 'X', contactId: buyerContact.id }, // contact of another company
      { organisationId: carrefour.id, name: 'X', ownerMembershipId: members.adminB },
      { organisationId: carrefour.id, name: 'X', pipelineId: crypto.randomUUID() },
      { organisationId: carrefour.id, name: 'X', estimatedValue: '12,5' },
      { organisationId: carrefour.id, name: 'X', currency: 'USD' },
    ];
    for (const payload of cases) {
      expect((await createOpp('sales1', payload)).statusCode, JSON.stringify(payload)).toBe(422);
    }
    expect((await createOpp('buyer', { organisationId: carrefour.id, name: 'X' })).statusCode).toBe(403);
  });

  it('OWN scope: Sales change and close only their own opportunities', async () => {
    const mine = await newOpp('sales1', 'Owned by sales1');
    expect((await get('sales2', `/opportunities/${mine.id}`)).statusCode).toBe(200);
    const denied = await act('sales2', mine.id, 'move-stage', { stageId: stage('Qualified').id });
    expect(denied.statusCode).toBe(403);
    expect((await act('sales2', mine.id, 'lose', { lostReason: 'Not mine' })).statusCode).toBe(403);
    // Handing it over moves the rights with it.
    expect((await patchOpp('sales1', mine.id, { ownerMembershipId: members.sales2 })).statusCode).toBe(200);
    expect((await act('sales2', mine.id, 'move-stage', { stageId: stage('Qualified').id })).statusCode).toBe(
      200,
    );
    expect((await act('sales1', mine.id, 'move-stage', { stageId: stage('Lead').id })).statusCode).toBe(403);
  });

  it('requires If-Match on changes and actions', async () => {
    const deal = await newOpp('sales1', 'Precondition');
    expect(
      (await act('sales1', deal.id, 'move-stage', { stageId: stage('Contacted').id }, null)).statusCode,
    ).toBe(428);
    expect(
      (await act('sales1', deal.id, 'move-stage', { stageId: stage('Contacted').id }, etagOf(9))).statusCode,
    ).toBe(412);
  });

  it('lists with filters, newest first, and pages without gaps', async () => {
    const won = (await get('admin', '/opportunities?status=WON')).json<Page<OpportunityListItem>>();
    expect(won.data.every((o) => o.stage.kind === 'WON')).toBe(true);
    const byName = (await get('admin', '/opportunities?q=lidl')).json<Page<OpportunityListItem>>();
    expect(byName.data.map((o) => o.name)).toEqual(['Lidl pylons']);

    const all = (await get('admin', '/opportunities?limit=100'))
      .json<Page<OpportunityListItem>>()
      .data.map((o) => o.id);
    const walked: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await get('admin', `/opportunities?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      const page: Page<OpportunityListItem> = response.json();
      walked.push(...page.data.map((o) => o.id));
      cursor = page.page.nextCursor;
    } while (cursor);
    expect(walked).toEqual(all);
  });
});

describe('the company timeline', () => {
  it('logs calls and meetings; system entries are read-only; authors edit their own', async () => {
    const logged = await app.inject({
      method: 'POST',
      url: '/api/v1/activities',
      headers: bearer('buyer'),
      payload: {
        organisationId: carrefour.id,
        contactId: buyerContact.id,
        activityTypeId: types.call,
        subject: 'Call about Sinaia',
        body: 'Wants 6 directional signs',
      },
    });
    expect(logged.statusCode).toBe(201);
    const call = logged.json<ActivityItem>();
    expect(call).toMatchObject({ type: { key: 'call' }, author: { membershipId: members.buyer } });

    const patch = async (who: UserName, id: string, payload: object) => {
      const [row] = await owner.db
        .select({ version: activity.version })
        .from(activity)
        .where(eq(activity.id, id));
      return app.inject({
        method: 'PATCH',
        url: `/api/v1/activities/${id}`,
        headers: { ...bearer(who), 'if-match': etagOf(row!.version) },
        payload,
      });
    };
    expect((await patch('buyer', call.id, { subject: 'Call about Sinaia and Brașov' })).statusCode).toBe(200);
    // sales holds activity.update@OWN: not their entry.
    expect((await patch('sales2', call.id, { subject: 'Mine now' })).statusCode).toBe(403);

    const system = (await timeline('admin', `?organisationId=${carrefour.id}`)).data.find(
      (a) => a.type.isSystem,
    )!;
    expect(code(await patch('admin', system.id, { subject: 'Rewrite history' }))).toBe('INVALID_TRANSITION');
  });

  it('refuses system types and records of another company', async () => {
    const bad = (payload: object) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/activities',
        headers: bearer('buyer'),
        payload: { organisationId: carrefour.id, activityTypeId: types.note, subject: 'X', ...payload },
      });
    expect((await bad({ activityTypeId: types.stage_change })).statusCode).toBe(422);
    expect((await bad({ organisationId: otherCompany.id, contactId: buyerContact.id })).statusCode).toBe(422);
  });

  it('pages newest first without gaps, even for entries microseconds apart', async () => {
    // Timestamps differing only in microseconds, which a JS Date (milliseconds) can't represent:
    // a cursor built from a JS Date would skip some of these.
    const [note] = await owner.db
      .select({ tenantId: activity.tenantId })
      .from(activity)
      .where(eq(activity.tenantId, tenantA))
      .limit(1);
    for (let i = 1; i <= 5; i++) {
      await owner.db.insert(activity).values({
        tenantId: note!.tenantId,
        organisationId: otherCompany.id,
        activityTypeId: types.note!,
        subject: `Note ${i}`,
        authorMembershipId: members.buyer,
        occurredAt: sql`${`2026-09-30 10:00:00.12345${i}+00`}::timestamptz`,
      });
    }
    const all = (await timeline('buyer', `?organisationId=${otherCompany.id}&limit=100`)).data.map(
      (a) => a.id,
    );
    const walked: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await timeline(
        'buyer',
        `?organisationId=${otherCompany.id}&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      walked.push(...page.data.map((a) => a.id));
      cursor = page.page.nextCursor;
    } while (cursor);
    expect(walked).toEqual(all);
    expect(new Set(walked).size).toBe(5);
  });
});

describe('tenant isolation', () => {
  it('opportunities and timelines of another tenant are unreachable', async () => {
    const [someDeal] = await owner.db
      .select({ id: opportunity.id })
      .from(opportunity)
      .where(eq(opportunity.tenantId, tenantA))
      .limit(1);
    expect((await get('adminB', `/opportunities/${someDeal!.id}`)).statusCode).toBe(404);
    expect((await act('adminB', someDeal!.id, 'lose', { lostReason: 'Hostile' }, '*')).statusCode).toBe(404);
    expect((await get('adminB', '/opportunities')).json<Page<OpportunityListItem>>().data).toHaveLength(0);
    expect((await timeline('adminB', `?organisationId=${carrefour.id}`)).data).toHaveLength(0);
    void tenantB;
  });
});
