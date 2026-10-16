/**
 * asset_nearby_same_kind (migration 0030): the CSV import's duplicate check. SECURITY DEFINER so the
 * spatial index works under RLS, therefore it must still answer only about the caller's own tenant.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionTenant } from '../src/provisioning';
import { assetType, oohAsset } from '../src/schema';
import { withTenantTx } from '../src/tenant-context';
import { appConnection, expectPgError, ownerConnection, SQLSTATE } from './helpers';

const owner = ownerConnection();
const app = appConnection();
const suffix = Date.now().toString(36);
let tenantA: string;
let tenantB: string;

type Nearby = {
  line: number;
  code: string;
  distance_m: number;
};

const point = (lat: number, lng: number) => sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`;
const addAsset = async (
  tenantId: string,
  key: string,
  code: string,
  lat: number,
  lng: number,
  lifecycle = 'PROSPECTIVE',
) => {
  const [type] = await owner.db
    .select({ id: assetType.id })
    .from(assetType)
    .where(and(eq(assetType.tenantId, tenantId), eq(assetType.key, key)));
  await owner.db.insert(oohAsset).values({
    tenantId,
    code,
    assetTypeId: type!.id,
    location: point(lat, lng),
    lifecycle: lifecycle as 'PROSPECTIVE',
  });
};
const nearby = (tenantId: string, points: object[], radius = 10) =>
  withTenantTx(app.db, { tenantId, actorUserId: null }, (tx) =>
    tx.execute<Nearby>(
      sql`SELECT * FROM asset_nearby_same_kind(${JSON.stringify(points)}::jsonb, ${radius})`,
    ),
  ).then((rows) => [...rows]);

beforeAll(async () => {
  ({ tenantId: tenantA } = await provisionTenant(owner.db, { name: 'Nearby A', slug: `nba-${suffix}` }));
  ({ tenantId: tenantB } = await provisionTenant(owner.db, { name: 'Nearby B', slug: `nbb-${suffix}` }));
  await addAsset(tenantA, 'pole', 'POLE-000001', 45.3486, 25.5517);
  await addAsset(tenantA, 'billboard', 'BB-000001', 45.3486, 25.5517); // same spot, other kind
  await addAsset(tenantA, 'pole', 'POLE-000002', 45.3486, 25.55175, 'DECOMMISSIONED');
  await addAsset(tenantB, 'pole', 'POLE-000001', 45.34861, 25.5517); // other company, ≈ 1 m away
});

afterAll(async () => {
  await app.close();
  await owner.close();
});

describe('asset_nearby_same_kind', () => {
  it("answers per point with the caller's live same-kind assets only", async () => {
    const rows = await nearby(tenantA, [
      { line: 2, lat: 45.34862, lng: 25.5517, kind: 'POLE' },
      { line: 3, lat: 45.36, lng: 25.56, kind: 'POLE' },
    ]);
    expect(rows.map((r) => [r.line, r.code])).toEqual([[2, 'POLE-000001']]);
    expect(rows[0]!.distance_m).toBeCloseTo(2.2, 0);
    const b = await nearby(tenantB, [{ line: 2, lat: 45.3486, lng: 25.5517, kind: 'POLE' }]);
    expect(b.map((r) => r.code)).toEqual(['POLE-000001']); // B's own pole, not A's
  });

  it('is refused outside a tenant context and for oversized input', async () => {
    await expectPgError(
      app.db.execute(sql`SELECT * FROM asset_nearby_same_kind('[]'::jsonb, 10)`),
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
    const many = Array.from({ length: 1001 }, (_, i) => ({ line: i, lat: 45, lng: 25, kind: 'POLE' }));
    await expectPgError(nearby(tenantA, many), '22023');
  });

  it('caps the radius at 100 m', async () => {
    // ≈ 155 m away: not found even when asked for 1 km.
    expect(await nearby(tenantA, [{ line: 2, lat: 45.35, lng: 25.5517, kind: 'POLE' }], 1000)).toEqual([]);
  });
});
