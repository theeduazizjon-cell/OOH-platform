/**
 * Inventory end to end (M4a, real PostGIS). Roadmap acceptance (12-roadmap.md, M4): "POLE-001245 with
 * 2 mounts × 2 faces; duplicate within 10 m blocked". Also attributes, the mount limit, faces with
 * presets, terms without overlaps, the lifecycle, blocks, the near search, the supplier scope, If-Match
 * and tenant isolation.
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type AssetDetail,
  type AssetListItem,
  type AssetTypeItem,
  type AuthSession,
  type DimensionPresetItem,
  etagOf,
  type NearbyAsset,
  type OrganisationDetail,
  type Page,
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
} from '@ooh/db';
import { and, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PasswordService } from '../src/core/auth/password.service';
import sharp from 'sharp';
import { createTestApp, uploadFile } from './support';

const PASSWORD = 'correct horse battery staple';
const suffix = Date.now().toString(36);
const email = (name: string) => `${name}-${suffix}@example.com`;

type UserName = 'admin' | 'buyer' | 'finance' | 'sales' | 'supplier' | 'adminB';
const tokens = {} as Record<UserName, string>;

let app: NestFastifyApplication;
let owner: DatabaseConnection;
let types: Record<string, AssetTypeItem>;
let presets: DimensionPresetItem[];
let supplierCo: OrganisationDetail;

// Sinaia, Bd. Carol I (≈ 45.3486 N, 25.5517 E); 0.0001° of longitude ≈ 7.8 m here.
const SPOT = { lat: 45.3486, lng: 25.5517 };
const east = (metres: number) => ({ lat: SPOT.lat, lng: SPOT.lng + metres / 78_200 });

beforeAll(async () => {
  owner = createDatabase(inject('ownerUrl'), { max: 2 });
  const { tenantId } = await provisionTenant(owner.db, { name: 'Inventory Alpha', slug: `ina-${suffix}` });
  const { tenantId: tenantB } = await provisionTenant(owner.db, {
    name: 'Inventory Beta',
    slug: `inb-${suffix}`,
  });
  const passwordHash = await new PasswordService().hash(PASSWORD);
  const add = async (
    t: string,
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
      .values({ tenantId: t, userId: u!.id, status: 'ACTIVE', ...extra })
      .returning({ id: membership.id });
    const [r] = await owner.db
      .select({ id: role.id })
      .from(role)
      .where(and(eq(role.tenantId, t), eq(role.key, roleKey)));
    await owner.db.insert(membershipRole).values({ tenantId: t, membershipId: m!.id, roleId: r!.id });
  };
  await add(tenantId, 'admin', 'company_admin');
  await add(tenantId, 'buyer', 'ooh_buyer');
  await add(tenantId, 'finance', 'finance');
  await add(tenantId, 'sales', 'sales');
  await add(tenantB, 'adminB', 'company_admin');
  app = await createTestApp();
  const login = async (name: UserName) => {
    tokens[name] = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: email(name), password: PASSWORD },
      })
    ).json<AuthSession>().accessToken;
  };
  for (const name of ['admin', 'buyer', 'finance', 'sales', 'adminB'] as const) await login(name);
  supplierCo = (await send('admin', 'POST', '/organisations', { displayName: `Supplier ${suffix}` })).json();
  await add(tenantId, 'supplier', 'ooh_supplier', { kind: 'EXTERNAL', organisationId: supplierCo.id });
  await login('supplier');
  types = Object.fromEntries(
    (await send('buyer', 'GET', '/config/asset-types')).json<AssetTypeItem[]>().map((t) => [t.key, t]),
  );
  presets = (await send('buyer', 'GET', '/config/dimension-presets')).json<DimensionPresetItem[]>();
});

afterAll(async () => {
  await app?.close();
  await owner?.close();
});

function send(
  who: UserName,
  method: 'GET' | 'POST' | 'PATCH',
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
const createAsset = (type: string, at: { lat: number; lng: number }, extra: object = {}) =>
  send('buyer', 'POST', '/assets', { assetTypeId: types[type]!.id, ...at, city: 'Sinaia', ...extra });

let pole: AssetDetail;

describe('assets', () => {
  it('acceptance: a pole gets its code and 2 mounts × 2 faces from the type template', async () => {
    const response = await createAsset('pole', SPOT, {
      address: 'Bd. Carol I 25',
      attributes: { material: 'metal' },
    });
    expect(response.statusCode).toBe(201);
    pole = response.json<AssetDetail>();
    expect(pole).toMatchObject({
      code: 'POLE-000001',
      type: { kind: 'POLE', name: 'Flag pole' },
      location: SPOT,
      lifecycle: 'PROSPECTIVE',
      verificationStatus: 'NOT_VERIFIED',
      mountCount: 2,
      faceCount: 4,
      attributes: { material: 'metal' },
      actions: ['activate', 'decommission'],
    });
    expect(pole.mounts.map((m) => [m.positionNo, m.faces.map((f) => f.faceCode)])).toEqual([
      [1, ['A', 'B']],
      [2, ['A', 'B']],
    ]);
    const billboard = (await createAsset('billboard', east(50))).json<AssetDetail>();
    expect(billboard).toMatchObject({ code: 'BB-000001', mountCount: 1, faceCount: 2 });
  });

  it('acceptance: a same-kind asset within 10 m is blocked, unless a reason is given', async () => {
    const blocked = await createAsset('pole', east(5));
    expect(blocked.statusCode).toBe(409);
    expect(code(blocked)).toBe('DUPLICATE_SUSPECTED');
    const [nearby] = blocked.json<{ meta: { nearby: NearbyAsset[] } }>().meta.nearby;
    expect(nearby).toMatchObject({ id: pole.id, code: 'POLE-000001' });
    expect(nearby!.distanceM).toBeGreaterThan(4);
    expect(nearby!.distanceM).toBeLessThan(6);

    expect((await createAsset('prism', east(5))).statusCode).toBe(201); // other kind: fine
    expect((await createAsset('pole', east(15))).statusCode).toBe(201); // beyond 10 m: fine
    const forced = await createAsset('pole', east(5), {
      duplicateOverride: { reason: 'Second pole on the other kerb' },
    });
    expect(forced.statusCode).toBe(201);
    const [audit] = await owner.db
      .select({ metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.action, 'asset.duplicate_overridden'),
          eq(auditEvent.subjectId, forced.json<AssetDetail>().id),
        ),
      );
    expect(audit?.metadata).toMatchObject({ reason: 'Second pole on the other kerb' });

    // Moving an asset onto another one is checked the same way.
    const far = (await createAsset('pole', east(300))).json<AssetDetail>();
    const moved = await send('buyer', 'PATCH', `/assets/${far.id}`, { ...east(3) }, far.version);
    expect(code(moved)).toBe('DUPLICATE_SUSPECTED');
  });

  it("validates attributes against the type's schema", async () => {
    expect(code(await createAsset('pole', east(600), { attributes: { material: 'plastic' } }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(code(await createAsset('pole', east(700), { attributes: { colour: 'red' } }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(code(await createAsset('pole', east(800), { attributes: { poleHeightM: 'tall' } }))).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('mount limit of the type, mounts and faces with If-Match, presets copied as values', async () => {
    expect(code(await send('buyer', 'POST', `/assets/${pole.id}/mounts`, {}))).toBe('CONFLICT');
    const wall = (await createAsset('wall', east(1000))).json<AssetDetail>();
    const twoMounts = (
      await send('buyer', 'POST', `/assets/${wall.id}/mounts`, { orientationBearing: 90 })
    ).json<AssetDetail>();
    expect(twoMounts.mounts.map((m) => m.positionNo)).toEqual([1, 2]);

    const mount = pole.mounts[0]!;
    expect(
      (await send('buyer', 'PATCH', `/mounts/${mount.id}`, { orientationBearing: 120 })).statusCode,
    ).toBe(428);
    const turned = (
      await send('buyer', 'PATCH', `/mounts/${mount.id}`, { orientationBearing: 120 }, mount.version)
    ).json<AssetDetail>();
    expect(turned.mounts[0]!.orientationBearing).toBe(120);
    expect(
      (await send('buyer', 'PATCH', `/mounts/${mount.id}`, { orientationBearing: 130 }, mount.version))
        .statusCode,
    ).toBe(412);

    const face = mount.faces[0]!;
    const flag = presets.find((p) => p.name === '0.8 × 2 m')!;
    const sized = (
      await send(
        'buyer',
        'PATCH',
        `/faces/${face.id}`,
        { dimensionPresetId: flag.id, facingBearing: 300, illuminated: true },
        face.version,
      )
    ).json<AssetDetail>();
    expect(sized.mounts[0]!.faces[0]).toMatchObject({
      widthM: '0.80',
      heightM: '2.00',
      dimensionPresetId: flag.id,
      illuminated: true,
    });
    expect(sized.version).toBeGreaterThan(pole.version); // parts move the asset's ETag too
    pole = sized;
  });
});

describe('terms, lifecycle and blocks', () => {
  it('finance records terms; periods never overlap; others see or not', async () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(
      (await send('buyer', 'POST', `/assets/${pole.id}/terms`, { acquisition: 'DIRECT', validFrom: today }))
        .statusCode,
    ).toBe(403);
    expect(
      code(
        await send('finance', 'POST', `/assets/${pole.id}/terms`, {
          acquisition: 'SUBLEASED',
          validFrom: today,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    const leased = await send('finance', 'POST', `/assets/${pole.id}/terms`, {
      acquisition: 'SUBLEASED',
      supplierOrganisationId: supplierCo.id,
      costAmount: '150',
      costUnit: 'MONTH',
      validFrom: '2026-01-01',
    });
    expect(leased.statusCode).toBe(201);
    const terms = leased.json<AssetDetail>().terms!;
    expect(terms).toEqual([
      expect.objectContaining({
        acquisition: 'SUBLEASED',
        supplier: { id: supplierCo.id, displayName: supplierCo.displayName },
        validFrom: '2026-01-01',
        validTo: null,
      }),
    ]);
    const overlap = await send('finance', 'POST', `/assets/${pole.id}/terms`, {
      acquisition: 'DIRECT',
      validFrom: '2027-01-01',
    });
    expect(code(overlap)).toBe('CONFLICT');

    const closed = await send(
      'finance',
      'POST',
      `/terms/${terms[0]!.id}/actions/close`,
      { validTo: '2026-12-31' },
      terms[0]!.version,
    );
    expect(closed.json<AssetDetail>().terms![0]).toMatchObject({ validTo: '2026-12-31' });
    expect(
      (
        await send('finance', 'POST', `/assets/${pole.id}/terms`, {
          acquisition: 'DIRECT',
          validFrom: '2027-01-01',
        })
      ).statusCode,
    ).toBe(201);

    expect((await send('buyer', 'GET', `/assets/${pole.id}`)).json<AssetDetail>().terms).toHaveLength(2);
    expect((await send('sales', 'GET', `/assets/${pole.id}`)).json<AssetDetail>().terms).toBeNull();
  });

  it('activates with current terms and a photo; suspends with a reason; only admins decommission', async () => {
    const bare = (await createAsset('mesh', east(2000))).json<AssetDetail>();
    const refused = await send('buyer', 'POST', `/assets/${bare.id}/actions/activate`, {}, bare.version);
    expect(refused.statusCode).toBe(422);
    expect(refused.json<{ errors: { path: string }[] }>().errors.map((e) => e.path)).toEqual([
      'terms',
      'photos',
    ]);

    // Terms alone are not enough: a checked photo too.
    let p = (await send('buyer', 'GET', `/assets/${pole.id}`)).json<AssetDetail>();
    const noPhoto = await send('buyer', 'POST', `/assets/${p.id}/actions/activate`, {}, p.version);
    expect(noPhoto.json<{ errors: { path: string }[] }>().errors.map((e) => e.path)).toEqual(['photos']);
    const photo = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#3a6' } })
      .jpeg()
      .toBuffer();
    const link = await uploadFile(app, tokens.buyer, {
      subjectType: 'asset',
      subjectId: p.id,
      purpose: 'ASSET_PHOTO',
      body: photo,
      mime: 'image/jpeg',
    });
    expect(link.file.status).toBe('READY');
    p = (await send('buyer', 'POST', `/assets/${p.id}/actions/activate`, {}, p.version)).json();
    expect(p).toMatchObject({ lifecycle: 'ACTIVE', actions: ['suspend', 'decommission'] });
    expect((await send('buyer', 'POST', `/assets/${p.id}/actions/suspend`, {}, p.version)).statusCode).toBe(
      422,
    );
    p = (
      await send('buyer', 'POST', `/assets/${p.id}/actions/suspend`, { reason: 'Pole damaged' }, p.version)
    ).json();
    expect(p).toMatchObject({ lifecycle: 'SUSPENDED', suspendReason: 'Pole damaged' });
    p = (await send('buyer', 'POST', `/assets/${p.id}/actions/reinstate`, {}, p.version)).json();
    expect(p).toMatchObject({ lifecycle: 'ACTIVE', suspendReason: null });

    expect(
      (await send('buyer', 'POST', `/assets/${bare.id}/actions/decommission`, {}, bare.version)).statusCode,
    ).toBe(403);
    const gone = (
      await send('admin', 'POST', `/assets/${bare.id}/actions/decommission`, {}, bare.version)
    ).json<AssetDetail>();
    expect(gone).toMatchObject({ lifecycle: 'DECOMMISSIONED', actions: [] });
    expect(code(await send('buyer', 'PATCH', `/assets/${bare.id}`, { notes: 'x' }, gone.version))).toBe(
      'INVALID_TRANSITION',
    );
    pole = p;
  });

  it('blocks a face for a period and releases it', async () => {
    const face = pole.mounts[1]!.faces[1]!;
    const blocked = await send('buyer', 'POST', `/assets/${pole.id}/blocks`, {
      faceId: face.id,
      from: '2026-11-01',
      to: '2026-11-15',
      reason: 'Municipal works',
    });
    const [block] = blocked.json<AssetDetail>().blocks;
    expect(block).toMatchObject({
      faceId: face.id,
      from: '2026-11-01',
      to: '2026-11-15',
      reason: 'Municipal works',
    });
    expect(
      code(
        await send('buyer', 'POST', `/assets/${pole.id}/blocks`, {
          faceId: crypto.randomUUID(),
          from: '2026-11-01',
          to: '2026-11-02',
          reason: 'x y z',
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    const released = await send('buyer', 'POST', `/blocks/${block!.id}/actions/release`);
    expect(released.json<AssetDetail>().blocks).toEqual([]);
  });
});

describe('finding assets and who sees them', () => {
  it('lists assets near a point, nearest first, with distances', async () => {
    const near = (
      await send('buyer', 'GET', `/assets?nearLat=${SPOT.lat}&nearLng=${SPOT.lng}&radiusM=60`)
    ).json<Page<AssetListItem>>();
    expect(near.data[0]).toMatchObject({ code: 'POLE-000001', distanceM: 0 });
    expect(near.data.every((a, i) => i === 0 || a.distanceM! >= near.data[i - 1]!.distanceM!)).toBe(true);
    expect(near.data.every((a) => a.distanceM! <= 60)).toBe(true);
    const byCode = (await send('buyer', 'GET', '/assets?q=BB-')).json<Page<AssetListItem>>();
    expect(byCode.data.map((a) => a.code)).toEqual(['BB-000001']);
  });

  it('an OOH supplier sees only the assets it supplies', async () => {
    const seen = (await send('supplier', 'GET', '/assets?limit=100')).json<Page<AssetListItem>>();
    expect(seen.data.map((a) => a.id)).toEqual([pole.id]);
    const other = (await send('buyer', 'GET', '/assets?q=BB-')).json<Page<AssetListItem>>().data[0]!;
    expect((await send('supplier', 'GET', `/assets/${other.id}`)).statusCode).toBe(404);
    expect(
      (await send('supplier', 'POST', '/assets', { assetTypeId: types.pole!.id, ...east(5000) })).statusCode,
    ).toBe(403);
  });

  it('never reaches another tenant', async () => {
    expect((await send('adminB', 'GET', `/assets/${pole.id}`)).statusCode).toBe(404);
    expect(
      (await send('adminB', 'GET', '/assets?limit=100'))
        .json<Page<AssetListItem>>()
        .data.some((a) => a.id === pole.id),
    ).toBe(false);
    // Tenant B's own pole at the same spot is not a duplicate of tenant A's.
    const typeB = (await send('adminB', 'GET', '/config/asset-types'))
      .json<AssetTypeItem[]>()
      .find((t) => t.key === 'pole')!;
    expect(
      (await send('adminB', 'POST', '/assets', { assetTypeId: typeB.id, ...SPOT })).json<AssetDetail>().code,
    ).toBe('POLE-000001');
  });
});
