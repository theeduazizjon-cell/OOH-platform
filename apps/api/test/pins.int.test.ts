/**
 * Store pins (M3c.2, 04-user-flows.md A6–A7) on real PostGIS: the worker geocodes each new location
 * (resolved / ambiguous / failed), people confirm or move pins, research needs a confirmed pin, a
 * draft's new address is geocoded again, stale results are dropped and outages are retried.
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type AuthSession,
  type BriefDetail,
  type CampaignDetail,
  etagOf,
  type LocationItem,
  type OrganisationDetail,
  type Page,
  type TaskItem,
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
import { and, eq, sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PasswordService } from '../src/core/auth/password.service';
import { createTestApp, drainOutbox, FakeGeoProvider } from './support';

const PASSWORD = 'correct horse battery staple';
const suffix = Date.now().toString(36);
const email = (name: string) => `${name}-${suffix}@example.com`;

let app: NestFastifyApplication;
let owner: DatabaseConnection;
let token: string;
let buyerId: string;
let client: OrganisationDetail;
const geo = new FakeGeoProvider();

beforeAll(async () => {
  owner = createDatabase(inject('ownerUrl'), { max: 2 });
  const { tenantId } = await provisionTenant(owner.db, { name: 'Pins Alpha', slug: `pin-${suffix}` });
  const passwordHash = await new PasswordService().hash(PASSWORD);
  const [u] = await owner.db
    .insert(appUser)
    .values({ email: email('buyer'), displayName: 'buyer', passwordHash })
    .returning({ id: appUser.id });
  const [m] = await owner.db
    .insert(membership)
    .values({ tenantId, userId: u!.id, status: 'ACTIVE' })
    .returning({ id: membership.id });
  buyerId = m!.id;
  const [r] = await owner.db
    .select({ id: role.id })
    .from(role)
    .where(and(eq(role.tenantId, tenantId), eq(role.key, 'ooh_buyer')));
  await owner.db.insert(membershipRole).values({ tenantId, membershipId: m!.id, roleId: r!.id });
  app = await createTestApp(undefined, geo);
  token = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: email('buyer'), password: PASSWORD },
    })
  ).json<AuthSession>().accessToken;
  client = (await send('POST', '/organisations', { displayName: `Pins Client ${suffix}` })).json();
  await drainOutbox(app);
});

afterAll(async () => {
  await app?.close();
  await owner?.close();
});

function send(method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, payload?: object, version?: number) {
  return app.inject({
    method,
    url: `/api/v1${path}`,
    headers: {
      authorization: `Bearer ${token}`,
      ...(version === undefined ? {} : { 'if-match': etagOf(version) }),
    },
    ...(payload ? { payload } : {}),
  });
}
const code = (response: LightMyRequestResponse) => response.json<{ code: string }>().code;
const location = async (id: string) => (await send('GET', `/locations/${id}`)).json<LocationItem>();
const tasksOf = async (campaignId: string) =>
  (await send('GET', `/tasks?state=all&campaignId=${campaignId}`)).json<Page<TaskItem>>().data;

let c: CampaignDetail;
const byName = (name: string) => c.locationItems.find((l) => l.name === name)!;

describe('geocoding new locations', () => {
  it('resolves, flags ambiguous and failed addresses, and asks a person to place those pins', async () => {
    let b = (
      await send('POST', '/briefs', {
        title: `Pins ${suffix}`,
        clientOrganisationId: client.id,
        datesTbd: true,
        lines: [
          { storeName: 'Sinaia', address: 'Bd. Carol I 25', city: 'Sinaia' },
          { storeName: 'Brasov', city: 'Brașov' },
          { storeName: 'Nowhere', city: 'Atlantis' },
          { storeName: 'No address' },
        ],
      })
    ).json<BriefDetail>();
    b = (await send('POST', `/briefs/${b.id}/actions/confirm`, {}, b.version)).json();
    b = (await send('POST', `/briefs/${b.id}/actions/convert`, {}, b.version)).json();
    c = (await send('GET', `/campaigns/${b.convertedCampaign!.id}`)).json();
    expect(c.locationItems.every((l) => l.geocodeStatus === 'PENDING' && l.storePoint === null)).toBe(true);

    await drainOutbox(app);
    c = (await send('GET', `/campaigns/${c.id}`)).json();
    expect(byName('Sinaia')).toMatchObject({
      geocodeStatus: 'RESOLVED',
      storePoint: { lat: 45.3486, lng: 25.5517 },
      geocodedAddress: 'Bd. Carol I 25, Sinaia',
      actions: ['hold', 'cancel'], // research waits for a person to confirm the pin
    });
    expect(byName('Brasov')).toMatchObject({ geocodeStatus: 'AMBIGUOUS', storePoint: null });
    expect(byName('Brasov').geocodedAddress).toContain('Carrefour Coresi, Brașov');
    expect(byName('Nowhere')).toMatchObject({
      geocodeStatus: 'FAILED',
      geocodeError: 'The address was not found.',
    });
    expect(byName('No address')).toMatchObject({ geocodeStatus: 'FAILED' });
    expect(geo.queries).toContain('Bd. Carol I 25, Sinaia, Romania');
    expect(geo.queries).not.toContain('Romania'); // nothing to look up: no provider call

    const pinTasks = (await tasksOf(c.id)).filter((t) => t.title.startsWith('Confirm store pin'));
    expect(pinTasks.map((t) => t.title).sort()).toEqual(
      ['Confirm store pin: Brasov', 'Confirm store pin: No address', 'Confirm store pin: Nowhere'].sort(),
    );
    expect(pinTasks.every((t) => t.assignee?.membershipId === buyerId && t.source === 'SYSTEM')).toBe(true);
  });

  it('stores a real PostGIS point', async () => {
    const [row] = await owner.db
      .select({
        metres: sql<number>`ST_Distance(${campaignLocation.storePoint}, ST_SetSRID(ST_MakePoint(25.5517, 45.3486), 4326)::geography)`,
        srid: sql<number>`ST_SRID(${campaignLocation.storePoint}::geometry)`,
      })
      .from(campaignLocation)
      .where(eq(campaignLocation.id, byName('Sinaia').id));
    expect(Number(row!.metres)).toBeLessThan(1);
    expect(Number(row!.srid)).toBe(4326);
  });
});

describe('confirming pins and starting research', () => {
  it('research needs a confirmed pin; confirming one closes its task', async () => {
    const brasov = byName('Brasov');
    expect(
      code(await send('POST', `/locations/${brasov.id}/actions/start-research`, {}, brasov.version)),
    ).toBe('INVALID_TRANSITION');
    expect(
      (await send('PUT', `/locations/${brasov.id}/store-point`, { lat: 45.6427, lng: 25.5887 })).statusCode,
    ).toBe(428);
    expect(
      (await send('PUT', `/locations/${brasov.id}/store-point`, { lat: 100, lng: 25 }, brasov.version))
        .statusCode,
    ).toBe(422);
    const confirmed = await send(
      'PUT',
      `/locations/${brasov.id}/store-point`,
      { lat: 45.6427, lng: 25.5887, placeId: 'fake-b1' },
      brasov.version,
    );
    expect(confirmed.statusCode).toBe(200);
    const pinned = confirmed.json<LocationItem>();
    expect(pinned).toMatchObject({
      geocodeStatus: 'CONFIRMED',
      storePoint: { lat: 45.6427, lng: 25.5887 },
      actions: ['start-research', 'hold', 'cancel'],
    });
    expect(pinned.pinConfirmedAt).not.toBeNull();
    const pinTask = (await tasksOf(c.id)).find((t) => t.title === 'Confirm store pin: Brasov');
    expect(pinTask?.status).toBe('DONE');

    const research = await send('POST', `/locations/${brasov.id}/actions/start-research`, {}, pinned.version);
    expect(research.json<LocationItem>()).toMatchObject({ status: 'RESEARCH', actions: ['hold', 'cancel'] });
    const [audit] = await owner.db
      .select({ changes: auditEvent.changes })
      .from(auditEvent)
      .where(
        and(eq(auditEvent.action, 'campaign_location.store_confirmed'), eq(auditEvent.subjectId, brasov.id)),
      );
    expect(audit?.changes).toMatchObject({ storePoint: { from: null, to: { lat: 45.6427, lng: 25.5887 } } });
  });

  it('the database refuses research without a confirmed pin', async () => {
    await expect(
      owner.db
        .update(campaignLocation)
        .set({ status: 'RESEARCH' })
        .where(eq(campaignLocation.id, byName('Nowhere').id)),
    ).rejects.toThrow();
  });
});

describe('address changes, stale results and outages', () => {
  it("a draft's new address is geocoded again; a confirmed pin stays", async () => {
    const nowhere = await location(byName('Nowhere').id);
    const moved = await send('PATCH', `/locations/${nowhere.id}`, { city: 'Sinaia' }, nowhere.version);
    expect(moved.json<LocationItem>()).toMatchObject({ geocodeStatus: 'PENDING', geocodeError: null });
    await drainOutbox(app);
    expect(await location(nowhere.id)).toMatchObject({
      geocodeStatus: 'RESOLVED',
      storePoint: { lat: 45.3486 },
    });

    const brasov = await location(byName('Brasov').id); // confirmed, in research
    await send('PATCH', `/locations/${brasov.id}`, { address: 'Str. Nouă 1' }, brasov.version);
    expect(await location(brasov.id)).toMatchObject({
      geocodeStatus: 'CONFIRMED',
      storePoint: { lat: 45.6427 },
    });
  });

  it('drops a result for an address that has changed since', async () => {
    const added = (
      await send('POST', `/campaigns/${c.id}/locations`, { name: 'Stale', city: 'Sinaia' })
    ).json<LocationItem>();
    await send('PATCH', `/locations/${added.id}`, { city: 'Atlantis' }, added.version); // before the worker runs
    await drainOutbox(app);
    // The Sinaia answer arrived for an outdated address and was ignored; Atlantis then failed.
    expect(await location(added.id)).toMatchObject({ geocodeStatus: 'FAILED', storePoint: null });
  });

  it('retries when the provider is down', async () => {
    const added = (
      await send('POST', `/campaigns/${c.id}/locations`, { name: 'Outage', city: 'Down' })
    ).json<LocationItem>();
    await drainOutbox(app);
    expect(await location(added.id)).toMatchObject({ geocodeStatus: 'PENDING' });
    const [event] = await owner.db
      .select()
      .from(outboxEvent)
      .where(
        and(
          eq(outboxEvent.eventType, 'campaign_location.created'),
          sql`${outboxEvent.payload}->>'campaign_locationId' = ${added.id}`,
        ),
      );
    expect(event).toMatchObject({ attempts: 1, lastError: 'provider unavailable', dispatchedAt: null });
  });
});
