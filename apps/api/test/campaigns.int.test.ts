/**
 * Campaigns end to end (M3b, 04-user-flows.md A5, 06-state-machines.md §4–§5): brief → campaign
 * convert (new, or into an existing campaign per OPD-07b), derived dates and counts, location
 * hold / resume / cancel, campaign cancel cascading, the portal ORGANISATION scope, If-Match and
 * tenant isolation.
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type AuthSession,
  type BriefDetail,
  type CampaignDetail,
  type CampaignListItem,
  etagOf,
  type LocationItem,
  type OrganisationDetail,
  type Page,
} from '@ooh/contracts';
import {
  appUser,
  auditEvent,
  campaignLocation,
  createDatabase,
  type DatabaseConnection,
  membership,
  membershipRole,
  outboxEvent,
  provisionTenant,
  role,
} from '@ooh/db';
import { and, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PasswordService } from '../src/core/auth/password.service';
import { createTestApp } from './support';

const PASSWORD = 'correct horse battery staple';
const suffix = Date.now().toString(36);
const email = (name: string) => `${name}-${suffix}@example.com`;
const YEAR = new Date().getUTCFullYear();

type UserName = 'admin' | 'buyer' | 'sales' | 'agency' | 'client' | 'otherClient' | 'adminB';
const members = {} as Record<UserName, string>;
const tokens = {} as Record<UserName, string>;

let app: NestFastifyApplication;
let owner: DatabaseConnection;
let tenantA: string;
let carrefour: OrganisationDetail;
let agencyX: OrganisationDetail;
let lidl: OrganisationDetail;
let kaufland: OrganisationDetail;

beforeAll(async () => {
  owner = createDatabase(inject('ownerUrl'), { max: 2 });
  ({ tenantId: tenantA } = await provisionTenant(owner.db, {
    name: 'Campaigns Alpha',
    slug: `cpa-${suffix}`,
  }));
  const { tenantId: tenantB } = await provisionTenant(owner.db, {
    name: 'Campaigns Beta',
    slug: `cpb-${suffix}`,
  });
  const passwordHash = await new PasswordService().hash(PASSWORD);
  const add = async (
    tenantId: string,
    name: UserName,
    roleKey: string,
    extra: Partial<typeof membership.$inferInsert> = {},
  ) => {
    const [u] = await owner.db
      .insert(appUser)
      .values({ email: email(name), displayName: name, passwordHash })
      .returning({ id: appUser.id });
    const [m] = await owner.db
      .insert(membership)
      .values({ tenantId, userId: u!.id, status: 'ACTIVE', ...extra })
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
  await add(tenantB, 'adminB', 'company_admin');

  app = await createTestApp();
  const login = async (name: UserName) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: email(name), password: PASSWORD },
    });
    tokens[name] = response.json<AuthSession>().accessToken;
  };
  for (const name of ['admin', 'buyer', 'sales', 'adminB'] as const) await login(name);
  const company = async (displayName: string) =>
    (await send('admin', 'POST', '/organisations', { displayName })).json<OrganisationDetail>();
  carrefour = await company(`Carrefour ${suffix}`);
  agencyX = await company(`Agency X ${suffix}`);
  lidl = await company(`Lidl ${suffix}`);
  kaufland = await company(`Kaufland ${suffix}`);
  // Agency X manages Lidl too (relationship), but Kaufland is nobody's.
  await send('admin', 'POST', `/organisations/${agencyX.id}/relationships`, {
    kind: 'AGENCY_OF',
    toOrganisationId: lidl.id,
  });
  // Portal users: an agency user of Agency X and a client user of Carrefour.
  await add(tenantA, 'agency', 'agency_user', { kind: 'EXTERNAL', organisationId: agencyX.id });
  await add(tenantA, 'client', 'end_client', { kind: 'EXTERNAL', organisationId: carrefour.id });
  await add(tenantA, 'otherClient', 'end_client', { kind: 'EXTERNAL', organisationId: kaufland.id });
  for (const name of ['agency', 'client', 'otherClient'] as const) await login(name);
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

/** A confirmed brief for the client with these stores. */
async function confirmedBrief(title: string, clientId: string, lines: object[], extra: object = {}) {
  let b = (
    await send('buyer', 'POST', '/briefs', {
      title,
      clientOrganisationId: clientId,
      requestedStart: '2027-03-01',
      requestedEnd: '2027-05-31',
      lines,
      ...extra,
    })
  ).json<BriefDetail>();
  b = (await send('buyer', 'POST', `/briefs/${b.id}/actions/confirm`, {}, b.version)).json<BriefDetail>();
  return b;
}
const convert = (who: UserName, b: BriefDetail, payload: object = {}) =>
  send(who, 'POST', `/briefs/${b.id}/actions/convert`, payload, b.version);
const getCampaign = async (who: UserName, id: string) =>
  (await send(who, 'GET', `/campaigns/${id}`)).json<CampaignDetail>();
const locationAct = (who: UserName, l: LocationItem, action: string, payload: object = {}) =>
  send(who, 'POST', `/locations/${l.id}/actions/${action}`, payload, l.version);

let sinaiaCampaign: CampaignDetail;

// ── convert ──────────────────────────────────────────────────────────────────

describe('brief → campaign', () => {
  it('creates a campaign with one draft location per store, in one transaction', async () => {
    const b = await confirmedBrief(
      `Openings ${suffix}`,
      carrefour.id,
      [
        { storeName: 'Carrefour Sinaia', city: 'Sinaia', requestedUnits: 7 },
        { storeName: 'Carrefour Brașov', city: 'Brașov', startDate: '2027-04-01', endDate: '2027-06-30' },
      ],
      { agencyOrganisationId: agencyX.id, specialRequirements: 'Directional flags only' },
    );
    expect(code(await convert('sales', b))).toBe('FORBIDDEN'); // Sales: no brief.convert
    expect((await send('buyer', 'POST', `/briefs/${b.id}/actions/convert`, {})).statusCode).toBe(428);

    const response = await convert('buyer', b);
    expect(response.statusCode).toBe(200);
    const converted = response.json<BriefDetail>();
    expect(converted).toMatchObject({ status: 'CONVERTED', actions: [] });
    expect(converted.convertedCampaign).toMatchObject({ name: `Openings ${suffix}`, code: `${YEAR}-0001` });

    sinaiaCampaign = await getCampaign('buyer', converted.convertedCampaign!.id);
    expect(sinaiaCampaign).toMatchObject({
      status: 'ACTIVE',
      client: { id: carrefour.id },
      agency: { id: agencyX.id },
      owner: { membershipId: members.buyer },
      notes: 'Directional flags only',
      startDate: '2027-03-01',
      endDate: '2027-06-30',
      locations: { total: 2, byStatus: { DRAFT: 2 } },
      actions: ['hold', 'cancel'],
    });
    expect(sinaiaCampaign.locationItems.map((l) => [l.name, l.status, l.startDate, l.endDate])).toEqual([
      ['Carrefour Sinaia', 'DRAFT', '2027-03-01', '2027-05-31'],
      ['Carrefour Brașov', 'DRAFT', '2027-04-01', '2027-06-30'],
    ]);
    expect(sinaiaCampaign.locationItems.every((l) => l.buyer?.membershipId === members.buyer)).toBe(true);
    expect(sinaiaCampaign.locationItems[0]!.briefLineId).toBe(b.lines[0]!.id);

    const events = (await owner.db.select().from(outboxEvent).where(eq(outboxEvent.tenantId, tenantA))).map(
      (e) => e.eventType,
    );
    expect(events.filter((e) => e === 'campaign_location.created')).toHaveLength(2);
    expect(events).toEqual(expect.arrayContaining(['campaign.created', 'brief.converted']));

    expect(code(await convert('buyer', converted))).toBe('INVALID_TRANSITION');
  });

  it('adds a later brief to an existing campaign of the same client (OPD-07b)', async () => {
    const more = await confirmedBrief(`More stores ${suffix}`, carrefour.id, [
      { storeName: 'Carrefour Cluj', city: 'Cluj' },
    ]);
    const added = await convert('buyer', more, { campaignId: sinaiaCampaign.id });
    expect(added.json<BriefDetail>().convertedCampaign?.id).toBe(sinaiaCampaign.id);
    expect((await getCampaign('buyer', sinaiaCampaign.id)).locations.total).toBe(3);

    const otherClient = await confirmedBrief(`Lidl ${suffix}`, lidl.id, [
      { storeName: 'Lidl Iași', city: 'Iași' },
    ]);
    expect(code(await convert('buyer', otherClient, { campaignId: sinaiaCampaign.id }))).toBe(
      'VALIDATION_FAILED',
    );
    const own = await convert('buyer', otherClient, { campaignName: `Lidl spring ${suffix}` });
    expect(own.json<BriefDetail>().convertedCampaign).toMatchObject({
      code: `${YEAR}-0002`,
      name: `Lidl spring ${suffix}`,
    });
  });
});

// ── campaigns ────────────────────────────────────────────────────────────────

describe('campaigns', () => {
  it('lists with derived counts and finds by code', async () => {
    const listed = (await send('buyer', 'GET', `/campaigns?q=${YEAR}-0001`)).json<Page<CampaignListItem>>();
    expect(listed.data.map((c) => c.id)).toEqual([sinaiaCampaign.id]);
    expect(listed.data[0]!.locations).toEqual({ total: 3, byStatus: { DRAFT: 3 } });
  });

  it('creates manually, adds and edits locations with If-Match and audit', async () => {
    const created = await send('buyer', 'POST', '/campaigns', {
      name: `Manual ${suffix}`,
      clientOrganisationId: kaufland.id,
    });
    expect(created.statusCode).toBe(201);
    const c = created.json<CampaignDetail>();
    expect(c).toMatchObject({
      locations: { total: 0 },
      startDate: null,
      owner: { membershipId: members.buyer },
    });
    expect(
      code(
        await send('buyer', 'POST', '/campaigns', {
          name: 'X',
          clientOrganisationId: kaufland.id,
          agencyOrganisationId: kaufland.id,
        }),
      ),
    ).toBe('VALIDATION_FAILED');

    const l = (
      await send('buyer', 'POST', `/campaigns/${c.id}/locations`, {
        name: 'Kaufland Ploiești',
        city: 'Ploiești',
      })
    ).json<LocationItem>();
    expect(l).toMatchObject({
      status: 'DRAFT',
      buyer: { membershipId: members.buyer },
      actions: ['hold', 'cancel'],
    });
    expect((await send('buyer', 'PATCH', `/locations/${l.id}`, { startDate: '2027-01-10' })).statusCode).toBe(
      428,
    );
    const moved = await send(
      'buyer',
      'PATCH',
      `/locations/${l.id}`,
      { startDate: '2027-01-10', endDate: '2027-02-10' },
      l.version,
    );
    expect(moved.json<LocationItem>()).toMatchObject({ startDate: '2027-01-10', version: 2 });
    expect(code(await send('buyer', 'PATCH', `/locations/${l.id}`, { endDate: '2026-12-01' }, 2))).toBe(
      'VALIDATION_FAILED',
    );
    const [audit] = await owner.db
      .select({ changes: auditEvent.changes })
      .from(auditEvent)
      .where(and(eq(auditEvent.action, 'campaign_location.updated'), eq(auditEvent.subjectId, l.id)));
    expect(audit?.changes).toMatchObject({ startDate: { from: null, to: '2027-01-10' } });
  });

  it('locations hold (with reason), resume to where they were, and cancel', async () => {
    const [sinaia, brasov] = (await getCampaign('buyer', sinaiaCampaign.id)).locationItems;
    expect((await locationAct('buyer', sinaia!, 'hold')).statusCode).toBe(422);
    const held = (
      await locationAct('buyer', sinaia!, 'hold', { reason: 'Store opening delayed' })
    ).json<LocationItem>();
    expect(held).toMatchObject({
      status: 'ON_HOLD',
      previousStatus: 'DRAFT',
      holdReason: 'Store opening delayed',
      actions: ['resume', 'cancel'],
    });
    const resumed = (await locationAct('buyer', held, 'resume')).json<LocationItem>();
    expect(resumed).toMatchObject({ status: 'DRAFT', previousStatus: null, holdReason: null });

    const cancelled = (
      await locationAct('buyer', brasov!, 'cancel', { reason: 'Client dropped Brașov' })
    ).json<LocationItem>();
    expect(cancelled).toMatchObject({ status: 'CANCELLED', actions: [] });
    expect(code(await locationAct('buyer', cancelled, 'resume'))).toBe('INVALID_TRANSITION');
    // Cancelled locations no longer drive the campaign's dates.
    expect(await getCampaign('buyer', sinaiaCampaign.id)).toMatchObject({ endDate: '2027-05-31' });
  });

  it('cancelling a campaign cascades, but never over a live location', async () => {
    const b = await confirmedBrief(`Cascade ${suffix}`, lidl.id, [
      { storeName: 'Lidl A', city: 'Arad' },
      { storeName: 'Lidl B', city: 'Bacău' },
    ]);
    const c = await getCampaign(
      'buyer',
      (await convert('buyer', b)).json<BriefDetail>().convertedCampaign!.id,
    );
    const live = c.locationItems[0]!;
    await owner.db.update(campaignLocation).set({ status: 'LIVE' }).where(eq(campaignLocation.id, live.id));
    const blocked = await send(
      'buyer',
      'POST',
      `/campaigns/${c.id}/actions/cancel`,
      { reason: 'Budget cut' },
      c.version,
    );
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ meta: { locations: { id: string }[] } }>().meta.locations.map((l) => l.id)).toEqual(
      [live.id],
    );

    await owner.db.update(campaignLocation).set({ status: 'DRAFT' }).where(eq(campaignLocation.id, live.id));
    const held = (
      await send('buyer', 'POST', `/campaigns/${c.id}/actions/hold`, {}, c.version)
    ).json<CampaignDetail>();
    expect(held).toMatchObject({ status: 'ON_HOLD', actions: ['resume', 'cancel'] });
    const cancelled = (
      await send('buyer', 'POST', `/campaigns/${c.id}/actions/cancel`, { reason: 'Budget cut' }, held.version)
    ).json<CampaignDetail>();
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'Budget cut', actions: [] });
    expect(cancelled.locationItems.map((l) => [l.status, l.cancelReason])).toEqual([
      ['CANCELLED', 'Campaign cancelled: Budget cut'],
      ['CANCELLED', 'Campaign cancelled: Budget cut'],
    ]);
    expect(code(await send('buyer', 'POST', `/campaigns/${c.id}/locations`, { name: 'Late' }))).toBe(
      'INVALID_TRANSITION',
    );
  });
});

// ── scopes ───────────────────────────────────────────────────────────────────

describe('who sees which campaigns', () => {
  it('portal users see their own and their clients’ campaigns, read-only', async () => {
    const ids = async (who: UserName) =>
      (await send(who, 'GET', '/campaigns?limit=100'))
        .json<Page<CampaignListItem>>()
        .data.map((c) => c.client.id);
    // Agency X: campaigns where it is the agency (Carrefour) or of a client it serves (Lidl).
    expect(new Set(await ids('agency'))).toEqual(new Set([carrefour.id, lidl.id]));
    expect(new Set(await ids('client'))).toEqual(new Set([carrefour.id]));
    expect(new Set(await ids('otherClient'))).toEqual(new Set([kaufland.id]));
    expect((await send('client', 'GET', `/campaigns/${sinaiaCampaign.id}`)).statusCode).toBe(200);
    expect((await send('otherClient', 'GET', `/campaigns/${sinaiaCampaign.id}`)).statusCode).toBe(404);
    const location = sinaiaCampaign.locationItems[0]!;
    expect((await send('otherClient', 'GET', `/locations/${location.id}`)).statusCode).toBe(404);
    expect(
      (await send('client', 'PATCH', `/campaigns/${sinaiaCampaign.id}`, { name: 'X' }, 1)).statusCode,
    ).toBe(403);
  });

  it('never reaches another tenant', async () => {
    expect((await send('adminB', 'GET', `/campaigns/${sinaiaCampaign.id}`)).statusCode).toBe(404);
    const location = sinaiaCampaign.locationItems[0]!;
    expect(
      (await send('adminB', 'PATCH', `/locations/${location.id}`, { name: 'X' }, location.version))
        .statusCode,
    ).toBe(404);
    const listed = (await send('adminB', 'GET', '/campaigns?limit=100')).json<Page<CampaignListItem>>();
    expect(listed.data).toEqual([]);
  });
});
