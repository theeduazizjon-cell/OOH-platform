/**
 * Inventory CSV import end to end (real PostGIS): a Romanian Excel export (semicolons, decimal commas,
 * diacritics) is previewed row by row, nothing is written until the import, the import is all or
 * nothing, re-importing the same file creates nothing twice, and duplicates need a reason.
 */
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type AssetDetail,
  type AssetTypeItem,
  type AuthSession,
  etagOf,
  type ImportPreview,
  type ImportResult,
} from '@ooh/contracts';
import {
  appUser,
  auditEvent,
  createDatabase,
  type DatabaseConnection,
  membership,
  membershipRole,
  oohAsset,
  provisionTenant,
  role,
} from '@ooh/db';
import { and, count, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PasswordService } from '../src/core/auth/password.service';
import { createTestApp } from './support';

const PASSWORD = 'correct horse battery staple';
const suffix = Date.now().toString(36);
const email = (name: string) => `${name}-${suffix}@example.com`;

type UserName = 'buyer' | 'sales' | 'adminB';
const tokens = {} as Record<UserName, string>;

let app: NestFastifyApplication;
let owner: DatabaseConnection;
let tenantId: string;
let existing: AssetDetail;

// Sinaia; 0.0001° of longitude ≈ 7.8 m here, 0.001° ≈ 78 m.
const FILE = [
  'Cod vechi;Tip;Latitudine;Longitudine;Adresă;Oraș;Județ;Material;Pole height (m);Nr. crt.',
  'S-001;Stâlp;45,3500;25,5500;Bd. Carol I 1;Sinaia;Prahova;metal;6,5;1', // ERROR: "Stâlp" is not a type name, key or prefix
  'S-002;pole;45,3510;25,5500;Bd. Carol I 9;Sinaia;Prahova;CONCRETE;;2', // READY (allowed value, any case)
  'S-003;Flag pole;45,3510;25,55003;Bd. Carol I 9;Sinaia;Prahova;;;3', // DUPLICATE of row 3 (≈ 2 m)
  'S-004;BB;45,3486;25,5517;Calea Doftanei;Sinaia;Prahova;;;4', // READY (billboard: no pole attributes)
  'S-005;Kiosk;45,3520;25,5500;;Sinaia;;;;5', // ERROR: unknown type
  'S-006;POLE;95,0;25,5500;;Sinaia;;;;6', // ERROR: latitude
  'S-007;pole;45,3530;25,5500;;Sinaia;;plastic;;7', // ERROR: material not allowed
  'S-008;pole;45,34860;25,55171;near the existing one;Sinaia;;;;8', // DUPLICATE of the existing pole (≈ 1 m)
].join('\r\n');

beforeAll(async () => {
  owner = createDatabase(inject('ownerUrl'), { max: 2 });
  ({ tenantId } = await provisionTenant(owner.db, { name: 'Import Alpha', slug: `ima-${suffix}` }));
  const { tenantId: tenantB } = await provisionTenant(owner.db, {
    name: 'Import Beta',
    slug: `imb-${suffix}`,
  });
  const passwordHash = await new PasswordService().hash(PASSWORD);
  const add = async (t: string, name: UserName, roleKey: string) => {
    const [u] = await owner.db
      .insert(appUser)
      .values({ email: email(name), displayName: name, passwordHash })
      .returning({ id: appUser.id });
    const [m] = await owner.db
      .insert(membership)
      .values({ tenantId: t, userId: u!.id, status: 'ACTIVE' })
      .returning({ id: membership.id });
    const [r] = await owner.db
      .select({ id: role.id })
      .from(role)
      .where(and(eq(role.tenantId, t), eq(role.key, roleKey)));
    await owner.db.insert(membershipRole).values({ tenantId: t, membershipId: m!.id, roleId: r!.id });
  };
  await add(tenantId, 'buyer', 'ooh_buyer');
  await add(tenantId, 'sales', 'sales');
  await add(tenantB, 'adminB', 'company_admin');
  app = await createTestApp();
  for (const name of ['buyer', 'sales', 'adminB'] as const) {
    tokens[name] = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: email(name), password: PASSWORD },
      })
    ).json<AuthSession>().accessToken;
  }
  const types = (await send('buyer', 'GET', '/config/asset-types')).json<AssetTypeItem[]>();
  existing = (
    await send('buyer', 'POST', '/assets', {
      assetTypeId: types.find((t) => t.key === 'pole')!.id,
      lat: 45.3486,
      lng: 25.5517,
      city: 'Sinaia',
      externalRef: 'OLD-1',
    })
  ).json<AssetDetail>();
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
const assetCount = async () =>
  (await owner.db.select({ n: count() }).from(oohAsset).where(eq(oohAsset.tenantId, tenantId)))[0]!.n;
const preview = (csv: string, who: UserName = 'buyer') =>
  send(who, 'POST', '/assets/import/preview', { csv });

describe('preview', () => {
  it('checks every row of a Romanian Excel file and writes nothing', async () => {
    const before = await assetCount();
    const response = await preview(FILE);
    expect(response.statusCode).toBe(200);
    const result = response.json<ImportPreview>();
    expect(result.fileProblems).toEqual([]);
    expect(result.columns.map((c) => c.mappedTo)).toEqual([
      'externalRef',
      'type',
      'lat',
      'lng',
      'address',
      'city',
      'county',
      'attr:material',
      'attr:poleHeightM',
      null, // "Nr. crt." is ignored
    ]);
    const byLine = Object.fromEntries(result.rows.map((r) => [r.line, r]));
    expect(result.rows.map((r) => [r.line, r.status])).toEqual([
      [2, 'ERROR'],
      [3, 'READY'],
      [4, 'DUPLICATE'],
      [5, 'READY'],
      [6, 'ERROR'],
      [7, 'ERROR'],
      [8, 'ERROR'],
      [9, 'DUPLICATE'],
    ]);
    // "Stâlp" is not a type name here (types are "Flag pole", key "pole", prefix "POLE").
    expect(byLine[2]!.problems[0]!.column).toBe('Tip');
    expect(byLine[2]!.problems[0]!.message).toMatch(/^Unknown type "Stâlp"/);
    expect(byLine[3]).toMatchObject({
      typeName: 'Flag pole',
      lat: 45.351,
      lng: 25.55,
      externalRef: 'S-002',
      attributes: { material: 'concrete' },
    });
    expect(byLine[4]).toMatchObject({ duplicateOfLine: 3, nearby: [] });
    expect(byLine[5]).toMatchObject({ typeName: 'Billboard', problems: [] });
    expect(byLine[7]!.problems).toEqual([
      { column: 'Latitudine', message: 'Latitude must be a number between -90 and 90' },
    ]);
    expect(byLine[8]!.problems).toEqual([
      { column: 'Material', message: 'Material is one of metal, concrete, wood' },
    ]);
    expect(byLine[9]!.nearby).toEqual([
      expect.objectContaining({ code: existing.code, distanceM: expect.any(Number) as number }),
    ]);
    expect(result.summary).toEqual({ READY: 2, DUPLICATE: 2, EXISTS: 0, ERROR: 4 });
    expect(await assetCount()).toBe(before);
  });

  it('reports problems with the file itself', async () => {
    expect((await preview('address;city\nX;Sinaia')).json<ImportPreview>().fileProblems).toEqual([
      'Add a "type" column (asset type name, key or code prefix).',
      'Add "lat" and "lng" columns, or a "coordinates" column ("45.3486, 25.5517" or a Google Maps link).',
    ]);
    const big = ['type,coordinates', ...Array.from({ length: 1001 }, (_, i) => `pole,"45.${i}, 25.5"`)].join(
      '\n',
    );
    expect((await preview(big)).json<ImportPreview>().fileProblems[0]).toMatch(/at most 1000/);
    // A coordinates column with Google Maps links works too.
    const links = (
      await preview('type,coordinates\npole,"https://www.google.com/maps/@45.40,25.60,17z"')
    ).json<ImportPreview>();
    expect(links.rows[0]).toMatchObject({ status: 'READY', lat: 45.4, lng: 25.6 });
  });

  it('needs asset.create; other companies see only their own inventory', async () => {
    expect((await preview(FILE, 'sales')).statusCode).toBe(403);
    const other = (await preview(FILE, 'adminB')).json<ImportPreview>();
    expect(other.rows.find((r) => r.line === 9)).toMatchObject({ status: 'READY', nearby: [] });
  });
});

describe('import', () => {
  const errorLines = [2, 6, 7, 8];

  it('is all or nothing: rows with problems must be fixed or skipped, duplicates skipped or explained', async () => {
    const before = await assetCount();
    const asIs = await send('buyer', 'POST', '/assets/import', { csv: FILE });
    expect([asIs.statusCode, code(asIs)]).toEqual([422, 'VALIDATION_FAILED']);
    expect(asIs.json<{ errors: { path: string }[] }>().errors.map((e) => e.path)).toEqual([
      'rows.2',
      'rows.4',
      'rows.6',
      'rows.7',
      'rows.8',
      'rows.9',
    ]);
    const noReason = await send('buyer', 'POST', '/assets/import', { csv: FILE, skipRows: errorLines });
    expect(noReason.statusCode).toBe(422);
    expect(await assetCount()).toBe(before);
  });

  it('creates the ready rows with codes, template mounts and faces, and their references', async () => {
    const response = await send('buyer', 'POST', '/assets/import', {
      csv: FILE,
      skipRows: [...errorLines, 4, 9],
    });
    expect(response.statusCode).toBe(201);
    const result = response.json<ImportResult>();
    expect(result.created.map((c) => [c.line, c.code])).toEqual([
      [3, 'POLE-000002'],
      [5, 'BB-000001'],
    ]);
    expect(result.skipped.map((s) => s.line)).toEqual([2, 4, 6, 7, 8, 9]);
    const pole = (await send('buyer', 'GET', `/assets/${result.created[0]!.id}`)).json<AssetDetail>();
    expect(pole).toMatchObject({
      lifecycle: 'PROSPECTIVE',
      externalRef: 'S-002',
      address: 'Bd. Carol I 9',
      county: 'Prahova',
      attributes: { material: 'concrete' },
      mountCount: 2,
      faceCount: 4,
      location: { lat: 45.351, lng: 25.55 },
    });
    const [summary] = await owner.db
      .select({ metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, tenantId), eq(auditEvent.action, 'asset.imported')));
    expect(summary!.metadata).toMatchObject({ created: 2, skipped: 6, codes: ['POLE-000002', 'BB-000001'] });
  });

  it('re-importing the same file skips what is already there', async () => {
    const again = (await preview(FILE)).json<ImportPreview>();
    expect(again.rows.filter((r) => r.status === 'EXISTS').map((r) => [r.line, r.existing?.code])).toEqual([
      [3, 'POLE-000002'],
      [5, 'BB-000001'],
    ]);
    // Row 4 was 2 m from row 3; row 3 is now a real asset, so row 4 is a duplicate of it.
    expect(again.rows.find((r) => r.line === 4)).toMatchObject({
      status: 'DUPLICATE',
      duplicateOfLine: null,
      nearby: [expect.objectContaining({ code: 'POLE-000002' })],
    });
  });

  it('imports possible duplicates when given a reason, recorded on each asset', async () => {
    const response = await send('buyer', 'POST', '/assets/import', {
      csv: FILE,
      skipRows: errorLines,
      duplicateReason: 'Second pole on the same corner',
    });
    expect(response.statusCode).toBe(201);
    const result = response.json<ImportResult>();
    expect(result.created.map((c) => c.line)).toEqual([4, 9]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { line: 3, status: 'EXISTS' },
        { line: 5, status: 'EXISTS' },
      ]),
    );
    const overrides = await owner.db
      .select({ subjectId: auditEvent.subjectId, metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, tenantId), eq(auditEvent.action, 'asset.duplicate_overridden')));
    expect(overrides.map((o) => o.subjectId).sort()).toEqual(result.created.map((c) => c.id).sort());
    expect(overrides[0]!.metadata).toMatchObject({ reason: 'Second pole on the same corner' });

    const nothing = await send('buyer', 'POST', '/assets/import', { csv: FILE, skipRows: errorLines });
    expect(nothing.json<{ detail: string }>().detail).toMatch(/Nothing to import/);
  });

  it('the reference is unique per company on create and edit too', async () => {
    const types = (await send('buyer', 'GET', '/config/asset-types')).json<AssetTypeItem[]>();
    const taken = await send('buyer', 'POST', '/assets', {
      assetTypeId: types.find((t) => t.key === 'mesh')!.id,
      lat: 45.36,
      lng: 25.56,
      externalRef: 'OLD-1',
    });
    expect([taken.statusCode, code(taken)]).toEqual([409, 'CONFLICT']);
    const edit = await send(
      'buyer',
      'PATCH',
      `/assets/${existing.id}`,
      { externalRef: 'S-002' },
      existing.version,
    );
    expect(edit.statusCode).toBe(409);
    const renamed = await send(
      'buyer',
      'PATCH',
      `/assets/${existing.id}`,
      { externalRef: 'OLD-1A' },
      existing.version,
    );
    expect(renamed.json<AssetDetail>()).toMatchObject({
      externalRef: 'OLD-1A',
      version: existing.version + 1,
    });
  });
});
