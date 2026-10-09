/**
 * Inventory guarantees (M4a) on real PostGIS: provisioned asset types and presets, the type
 * template's mount limit (trigger), non-overlapping terms (exclusion constraint), face and period
 * checks, the GiST-backed proximity query, and tenant isolation.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionTenant } from '../src/provisioning';
import {
  advertisingFace,
  assetBlock,
  assetTerms,
  assetType,
  dimensionPreset,
  mountPosition,
  oohAsset,
} from '../src/schema';
import { withTenantTx } from '../src/tenant-context';
import { appConnection, expectPgError, ownerConnection, SQLSTATE } from './helpers';

const owner = ownerConnection();
const app = appConnection();
const suffix = Date.now().toString(36);
const CHECK = '23514';
const EXCLUSION = '23P01';
let tenantA: string;
let tenantB: string;

const inA = <T>(fn: Parameters<typeof withTenantTx<T>>[2]) =>
  withTenantTx(app.db, { tenantId: tenantA, actorUserId: null }, fn);
const typeId = async (tenantId: string, key: string) =>
  (
    await owner.db
      .select({ id: assetType.id })
      .from(assetType)
      .where(and(eq(assetType.tenantId, tenantId), eq(assetType.key, key)))
  )[0]!.id;
let n = 0;
const newAsset = async (key: string, values: Partial<typeof oohAsset.$inferInsert> = {}) => {
  const assetTypeId = await typeId(tenantA, key);
  return inA((tx) =>
    tx
      .insert(oohAsset)
      .values({
        tenantId: tenantA,
        code: `T-${suffix}-${++n}`,
        assetTypeId,
        location: 'SRID=4326;POINT(25.5517 45.3486)',
        ...values,
      })
      .returning(),
  ).then((rows) => rows[0]!);
};
const mount = (assetId: string, positionNo: number) =>
  inA((tx) => tx.insert(mountPosition).values({ tenantId: tenantA, assetId, positionNo }).returning()).then(
    (r) => r[0]!,
  );

beforeAll(async () => {
  ({ tenantId: tenantA } = await provisionTenant(owner.db, { name: 'Inventory A', slug: `inv-a-${suffix}` }));
  ({ tenantId: tenantB } = await provisionTenant(owner.db, { name: 'Inventory B', slug: `inv-b-${suffix}` }));
});

afterAll(async () => {
  await app.close();
  await owner.close();
});

describe('inventory', () => {
  it('provisions the default asset types and face sizes once', async () => {
    const types = await owner.db.select().from(assetType).where(eq(assetType.tenantId, tenantA));
    expect(types.map((t) => t.key).sort()).toEqual(['billboard', 'mesh', 'other', 'pole', 'prism', 'wall']);
    expect(types.find((t) => t.key === 'pole')).toMatchObject({
      maxMountPositions: 2,
      facesPerMount: 2,
      facesBookedTogether: true,
    });
    await provisionTenant(owner.db, { name: 'Inventory A', slug: `inv-a-${suffix}` });
    expect(await owner.db.select().from(assetType).where(eq(assetType.tenantId, tenantA))).toHaveLength(6);
    expect(
      (await owner.db.select().from(dimensionPreset).where(eq(dimensionPreset.tenantId, tenantA))).length,
    ).toBe(5);
  });

  it('a pole has at most two mount positions (type template, trigger)', async () => {
    const pole = await newAsset('pole');
    await mount(pole.id, 1);
    await mount(pole.id, 2);
    await expectPgError(mount(pole.id, 3), CHECK);
    const wall = await newAsset('wall'); // no limit
    for (const no of [1, 2, 3]) await mount(wall.id, no);
  });

  it('faces are A–D, unique per mount, with positive sizes', async () => {
    const asset = await newAsset('billboard');
    const m = await mount(asset.id, 1);
    const face = (values: Partial<typeof advertisingFace.$inferInsert>) =>
      inA((tx) =>
        tx
          .insert(advertisingFace)
          .values({ tenantId: tenantA, mountPositionId: m.id, faceCode: 'A', ...values }),
      );
    await face({});
    await expectPgError(face({}), '23505');
    await expectPgError(face({ faceCode: 'E' }), CHECK);
    await expectPgError(face({ faceCode: 'B', widthM: '0' }), CHECK);
    await expectPgError(face({ faceCode: 'B', facingBearing: 400 }), CHECK);
  });

  it('terms periods of one asset never overlap; subleased needs a supplier', async () => {
    const asset = await newAsset('pole');
    const terms = (period: string, values: Partial<typeof assetTerms.$inferInsert> = {}) =>
      inA((tx) =>
        tx.insert(assetTerms).values({
          tenantId: tenantA,
          assetId: asset.id,
          acquisition: 'DIRECT',
          validPeriod: period,
          ...values,
        }),
      );
    await terms('[2026-01-01,2027-01-01)');
    await expectPgError(terms('[2026-06-01,2026-07-01)'), EXCLUSION);
    await expectPgError(terms('[2026-12-31,)'), EXCLUSION);
    await terms('[2027-01-01,)'); // adjacent, open-ended
    await expectPgError(terms('[2028-01-01,2029-01-01)', { acquisition: 'SUBLEASED' }), CHECK);
    await expectPgError(terms('(,2025-01-01)'), CHECK); // no start date
    await expectPgError(terms('[2020-01-01,2021-01-01)', { costAmount: '100' }), CHECK); // amount without unit
    // Another asset's terms are independent.
    const other = await newAsset('pole');
    await inA((tx) =>
      tx.insert(assetTerms).values({
        tenantId: tenantA,
        assetId: other.id,
        acquisition: 'DIRECT',
        validPeriod: '[2026-01-01,2027-01-01)',
      }),
    );
  });

  it('blocks need a bounded period and a reason; suspended assets need a reason', async () => {
    const asset = await newAsset('mesh');
    const block = (values: Partial<typeof assetBlock.$inferInsert>) =>
      inA((tx) =>
        tx.insert(assetBlock).values({
          tenantId: tenantA,
          assetId: asset.id,
          period: '[2026-11-01,2026-11-15)',
          reason: 'Repair',
          ...values,
        }),
      );
    await block({});
    await expectPgError(block({ period: '[2026-11-01,)' }), CHECK);
    await expectPgError(block({ reason: ' ' }), CHECK);
    await expectPgError(newAsset('pole', { lifecycle: 'SUSPENDED' }), CHECK);
    await expectPgError(newAsset('pole', { verificationStatus: 'FIELD_VERIFIED' }), CHECK);
  });

  it('finds assets within metres (PostGIS, GiST)', async () => {
    const near = await newAsset('prism', { location: 'SRID=4326;POINT(25.60000 45.35000)' });
    await newAsset('prism', { location: 'SRID=4326;POINT(25.60010 45.35000)' }); // ~7.8 m east
    await newAsset('prism', { location: 'SRID=4326;POINT(25.61000 45.35000)' }); // ~780 m east
    const within = await inA((tx) =>
      tx
        .select({ id: oohAsset.id })
        .from(oohAsset)
        .where(
          sql`ST_DWithin(${oohAsset.location}, (SELECT location FROM ooh_asset WHERE id = ${near.id}), 10) AND ${oohAsset.id} <> ${near.id}`,
        ),
    );
    expect(within).toHaveLength(1);
  });

  it("never points at another tenant's asset type, and deletes of assets are refused", async () => {
    const typeB = await typeId(tenantB, 'pole');
    await expectPgError(
      inA((tx) =>
        tx.insert(oohAsset).values({
          tenantId: tenantA,
          code: `X-${suffix}`,
          assetTypeId: typeB,
          location: 'SRID=4326;POINT(25 45)',
        }),
      ),
      SQLSTATE.FOREIGN_KEY_VIOLATION,
    );
    const asset = await newAsset('pole');
    await expectPgError(
      inA((tx) => tx.delete(oohAsset).where(eq(oohAsset.id, asset.id))),
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
  });
});
