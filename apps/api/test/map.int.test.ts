/**
 * Map and geo end to end (M5a, real PostGIS): the viewport layer (points from zoom 13, grid clusters
 * below), its filters and scopes, and the provider-backed helpers (reverse geocoding, driving route)
 * with and without a provider.
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type AssetTypeItem,
  type AuthSession,
  haversineM,
  initialBearing,
  type MapAssetsResponse,
  type ReverseGeocodeResponse,
  type RouteResponse,
} from '@ooh/contracts';
import {
  appUser,
  createDatabase,
  type DatabaseConnection,
  membership,
  membershipRole,
  oohAsset,
  provisionTenant,
  role,
} from '@ooh/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PasswordService } from '../src/core/auth/password.service';
import { UnconfiguredGeoProvider } from '../src/core/geo/geo-provider';
import { createTestApp, FakeGeoProvider } from './support';

const PASSWORD = 'correct horse battery staple';
const suffix = Date.now().toString(36);
const email = (name: string) => `${name}-${suffix}@example.com`;

type UserName = 'buyer' | 'decorator' | 'noAccess' | 'adminB';
const tokens = {} as Record<UserName, string>;

let app: NestFastifyApplication;
let bare: NestFastifyApplication; // no geo provider configured
let owner: DatabaseConnection;
const geo = new FakeGeoProvider();
let tenantA: string;
let types: Record<string, AssetTypeItem>;

const SINAIA = { lat: 45.3486, lng: 25.5517 };
const BUSTENI = { lat: 45.4153, lng: 25.5375 };
/** A box of roughly 1.5 × 2 km around Sinaia's centre, and one around all of Romania. */
const SINAIA_BOX = '25.54,45.34,25.56,45.36';
const ROMANIA_BOX = '20.2,43.6,29.7,48.3';

async function insertAsset(
  tenantId: string,
  type: AssetTypeItem,
  code: string,
  at: { lat: number; lng: number },
  lifecycle: 'PROSPECTIVE' | 'ACTIVE' | 'DECOMMISSIONED' = 'ACTIVE',
) {
  await owner.db.insert(oohAsset).values({
    tenantId,
    code,
    assetTypeId: type.id,
    lifecycle,
    location: sql`ST_SetSRID(ST_MakePoint(${at.lng}, ${at.lat}), 4326)::geography`,
  });
}

beforeAll(async () => {
  owner = createDatabase(inject('ownerUrl'), { max: 2 });
  ({ tenantId: tenantA } = await provisionTenant(owner.db, { name: 'Map Alpha', slug: `mapa-${suffix}` }));
  const { tenantId: tenantB } = await provisionTenant(owner.db, { name: 'Map Beta', slug: `mapb-${suffix}` });
  const passwordHash = await new PasswordService().hash(PASSWORD);
  const add = async (tenantId: string, name: UserName, roleKey: string | null) => {
    const [u] = await owner.db
      .insert(appUser)
      .values({ email: email(name), displayName: name, passwordHash })
      .returning({ id: appUser.id });
    const [m] = await owner.db
      .insert(membership)
      .values({ tenantId, userId: u!.id, status: 'ACTIVE' })
      .returning({ id: membership.id });
    if (!roleKey) return; // a member without any role: no permissions at all
    const [r] = await owner.db
      .select({ id: role.id })
      .from(role)
      .where(and(eq(role.tenantId, tenantId), eq(role.key, roleKey)));
    await owner.db.insert(membershipRole).values({ tenantId, membershipId: m!.id, roleId: r!.id });
  };
  await add(tenantA, 'buyer', 'ooh_buyer');
  await add(tenantA, 'decorator', 'decorator');
  await add(tenantA, 'noAccess', null);
  await add(tenantB, 'adminB', 'company_admin');

  app = await createTestApp(undefined, geo);
  bare = await createTestApp(undefined, new UnconfiguredGeoProvider());
  for (const name of ['buyer', 'decorator', 'noAccess', 'adminB'] as const) {
    tokens[name] = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: email(name), password: PASSWORD },
      })
    ).json<AuthSession>().accessToken;
  }
  types = Object.fromEntries(
    (await get('buyer', '/config/asset-types')).json<AssetTypeItem[]>().map((t) => [t.key, t]),
  );

  // Sinaia: two poles, a billboard and a decommissioned pole; Bușteni (7 km north): one pole.
  await insertAsset(tenantA, types.pole!, 'POLE-000001', SINAIA);
  await insertAsset(tenantA, types.pole!, 'POLE-000002', { lat: 45.3501, lng: 25.5489 }, 'PROSPECTIVE');
  await insertAsset(tenantA, types.billboard!, 'BB-000001', { lat: 45.3452, lng: 25.5551 });
  await insertAsset(tenantA, types.pole!, 'POLE-000003', { lat: 45.3478, lng: 25.5502 }, 'DECOMMISSIONED');
  await insertAsset(tenantA, types.pole!, 'POLE-000004', BUSTENI);
  // A dense block in Bucharest for clustering: 200 poles on a ~1 km grid of 20 × 10.
  for (let i = 0; i < 200; i++) {
    const at = { lat: 44.4268 + Math.floor(i / 20) * 0.0005, lng: 26.1025 + (i % 20) * 0.0005 };
    await insertAsset(tenantA, types.pole!, `POLE-${String(100 + i).padStart(6, '0')}`, at);
  }
  // Another company's pole on the same Sinaia spot.
  const typesB = (await get('adminB', '/config/asset-types')).json<AssetTypeItem[]>();
  await insertAsset(
    tenantB,
    typesB.find((t) => t.key === 'pole')!,
    'POLE-000001',
    SINAIA,
  );
});

afterAll(async () => {
  await app?.close();
  await bare?.close();
  await owner?.close();
});

function get(who: UserName, path: string, target = app) {
  return target.inject({
    method: 'GET',
    url: `/api/v1${path}`,
    headers: { authorization: `Bearer ${tokens[who]}` },
  });
}

function post(who: UserName, path: string, payload: object, target = app) {
  return target.inject({
    method: 'POST',
    url: `/api/v1${path}`,
    headers: { authorization: `Bearer ${tokens[who]}` },
    payload,
  });
}

const map = async (who: UserName, query: string) => {
  const response = await get(who, `/map/assets?${query}`);
  expect(response.statusCode).toBe(200);
  return response.json<MapAssetsResponse>();
};
const codes = (r: MapAssetsResponse) =>
  r.kind === 'points' ? r.points.map((p) => p.code).sort() : expect.fail('expected points');

describe('map assets', () => {
  it('returns individual points in the viewport from zoom 13, without decommissioned ones', async () => {
    const result = await map('buyer', `bbox=${SINAIA_BOX}&zoom=15`);
    expect(result.kind).toBe('points');
    expect(codes(result)).toEqual(['BB-000001', 'POLE-000001', 'POLE-000002']);
    const pole = result.kind === 'points' ? result.points.find((p) => p.code === 'POLE-000001')! : null;
    expect(pole).toMatchObject({ kind: 'POLE', assetTypeId: types.pole!.id, lifecycle: 'ACTIVE' });
    expect(pole!.lat).toBeCloseTo(SINAIA.lat, 5);
    expect(pole!.lng).toBeCloseTo(SINAIA.lng, 5);
    if (result.kind === 'points') expect(result.truncated).toBe(false);
  });

  it('filters by type and lifecycle (decommissioned only when asked)', async () => {
    expect(
      codes(await map('buyer', `bbox=${SINAIA_BOX}&zoom=15&assetTypeId=${types.billboard!.id}`)),
    ).toEqual(['BB-000001']);
    expect(codes(await map('buyer', `bbox=${SINAIA_BOX}&zoom=15&lifecycle=PROSPECTIVE`))).toEqual([
      'POLE-000002',
    ]);
    expect(codes(await map('buyer', `bbox=${SINAIA_BOX}&zoom=15&lifecycle=DECOMMISSIONED`))).toEqual([
      'POLE-000003',
    ]);
  });

  it('aggregates into grid clusters below zoom 13, counting every visible asset once', async () => {
    const result = await map('buyer', `bbox=${ROMANIA_BOX}&zoom=7`);
    expect(result.kind).toBe('clusters');
    if (result.kind !== 'clusters') return;
    // 4 Sinaia/Bușteni assets (the decommissioned one hidden) + 200 in Bucharest.
    expect(result.total).toBe(204);
    expect(result.clusters.reduce((sum, c) => sum + c.count, 0)).toBe(204);
    const bucharest = result.clusters.find((c) => c.count === 200);
    expect(bucharest).toBeDefined();
    // The marker sits on the data (the block's centre), not on a grid corner.
    expect(bucharest!.lat).toBeCloseTo(44.4268 + 0.00225, 3);
    expect(bucharest!.lng).toBeCloseTo(26.1025 + 0.00475, 3);
    // Zooming in splits Sinaia from Bușteni (7 km apart) while one block stays one cluster.
    const closer = await map('buyer', `bbox=${ROMANIA_BOX}&zoom=11`);
    if (closer.kind !== 'clusters') return expect.fail('expected clusters');
    expect(closer.total).toBe(204);
    expect(closer.clusters.length).toBeGreaterThan(result.clusters.length);
  });

  it('keeps companies apart and applies the read scope', async () => {
    expect(codes(await map('adminB', `bbox=${SINAIA_BOX}&zoom=15`))).toEqual(['POLE-000001']);
    // Decorators see assets through their field jobs (M9): none yet.
    expect(codes(await map('decorator', `bbox=${SINAIA_BOX}&zoom=15`))).toEqual([]);
    expect((await get('noAccess', `/map/assets?bbox=${SINAIA_BOX}&zoom=15`)).statusCode).toBe(403);
  });

  it('validates the viewport', async () => {
    for (const query of [
      `bbox=${SINAIA_BOX}`,
      'bbox=25.56,45.34,25.54,45.36&zoom=15', // west > east
      'bbox=1,2,3&zoom=15',
      `bbox=${SINAIA_BOX}&zoom=23`,
    ]) {
      expect((await get('buyer', `/map/assets?${query}`)).statusCode, query).toBe(422);
    }
  });
});

describe('reverse geocoding', () => {
  it('finds the address at a point and caches repeated clicks', async () => {
    const before = geo.reverseCalls;
    const first = await post('buyer', '/geo/reverse', SINAIA);
    expect(first.statusCode).toBe(200);
    expect(first.json<ReverseGeocodeResponse>()).toEqual({
      configured: true,
      result: {
        formattedAddress: 'Bd. Carol I 25, Sinaia 106100, Romania',
        address: 'Bd. Carol I 25',
        city: 'Sinaia',
        county: 'Prahova',
        placeId: 'fake-carol-25',
      },
    });
    // Same point to ~1 m: answered from the cache, not the paid API.
    await post('buyer', '/geo/reverse', { lat: SINAIA.lat + 0.000001, lng: SINAIA.lng });
    expect(geo.reverseCalls).toBe(before + 1);
  });

  it('answers "nothing here", "not configured" and outages distinctly', async () => {
    expect((await post('buyer', '/geo/reverse', { lat: 44.0, lng: 28.0 })).json()).toEqual({
      configured: true,
      result: null,
    });
    expect((await post('buyer', '/geo/reverse', SINAIA, bare)).json()).toEqual({
      configured: false,
      result: null,
    });
    const down = await post('buyer', '/geo/reverse', { lat: 89.5, lng: 0 });
    expect(down.statusCode).toBe(503);
    expect(down.json<{ code: string }>().code).toBe('SERVICE_UNAVAILABLE');
    expect((await post('buyer', '/geo/reverse', { lat: 91, lng: 0 })).statusCode).toBe(422);
    expect((await post('noAccess', '/geo/reverse', SINAIA)).statusCode).toBe(403);
  });
});

describe('driving route', () => {
  it('returns the straight line and the driving route with its starting bearing', async () => {
    const response = await post('buyer', '/geo/route', { origin: SINAIA, destination: BUSTENI });
    expect(response.statusCode).toBe(200);
    const body = response.json<RouteResponse>();
    const straight = haversineM(SINAIA, BUSTENI);
    expect(body.straight.distanceM).toBe(Math.round(straight));
    expect(body.straight.bearing).toBe(initialBearing(SINAIA, BUSTENI));
    expect(body.straight.bearing).toBeGreaterThan(340); // Bușteni is north, slightly west
    expect(body.route).not.toBeNull();
    expect(body.route!.distanceM).toBe(Math.round(straight * 1.4));
    expect(body.route!.durationS).toBeGreaterThan(0);
    expect(body.route!.initialBearing).toBe(body.straight.bearing); // the fake road is straight
    expect(body.routeUnavailable).toBeNull();
  });

  it('still gives the straight line without a route or a provider', async () => {
    const none = (
      await post('buyer', '/geo/route', { origin: SINAIA, destination: { lat: 45, lng: 15 } })
    ).json<RouteResponse>();
    expect(none.route).toBeNull();
    expect(none.routeUnavailable).toBe('No driving route between these points.');
    expect(none.straight.distanceM).toBeGreaterThan(700_000);

    const bareRoute = (
      await post('buyer', '/geo/route', { origin: SINAIA, destination: BUSTENI }, bare)
    ).json<RouteResponse>();
    expect(bareRoute.route).toBeNull();
    expect(bareRoute.routeUnavailable).toBe('Driving routes are not configured.');
    expect(bareRoute.straight.distanceM).toBe(Math.round(haversineM(SINAIA, BUSTENI)));
  });
});
