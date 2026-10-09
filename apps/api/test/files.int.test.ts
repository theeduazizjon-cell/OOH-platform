/**
 * Files end to end (M4b, local storage): the upload flow (ticket → PUT to the signed URL → complete →
 * worker), processing (size, checksum, real type, virus scan, thumbnail without metadata), download
 * links, access through the record (asset), unlinking, and tampered or expired upload links.
 */
import { createHash } from 'node:crypto';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type AssetDetail,
  type AssetTypeItem,
  type AuthSession,
  type FileItem,
  type FileLinkItem,
  type UploadTicket,
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
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PasswordService } from '../src/core/auth/password.service';
import { type FileScanner, type ScanResult } from '../src/core/files/scanner';
import { createTestApp, FakeGeoProvider, MemoryThrottleStore, uploadFile } from './support';

const PASSWORD = 'correct horse battery staple';
const suffix = Date.now().toString(36);
const email = (name: string) => `${name}-${suffix}@example.com`;

type UserName = 'admin' | 'buyer' | 'sales' | 'adminB';
const tokens = {} as Record<UserName, string>;

/** Flags anything containing the EICAR test marker, like ClamAV would. */
class FakeScanner implements FileScanner {
  scan(body: Buffer): Promise<ScanResult> {
    return Promise.resolve(
      body.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')
        ? { clean: false, engine: 'fake', signature: 'Eicar-Test-Signature' }
        : { clean: true, engine: 'fake' },
    );
  }
}

let app: NestFastifyApplication;
let owner: DatabaseConnection;
let tenantId: string;
let asset: AssetDetail;
let jpeg: Buffer;

beforeAll(async () => {
  owner = createDatabase(inject('ownerUrl'), { max: 2 });
  ({ tenantId } = await provisionTenant(owner.db, { name: 'Files Alpha', slug: `fia-${suffix}` }));
  const { tenantId: tenantB } = await provisionTenant(owner.db, {
    name: 'Files Beta',
    slug: `fib-${suffix}`,
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
  await add(tenantId, 'admin', 'company_admin');
  await add(tenantId, 'buyer', 'ooh_buyer');
  await add(tenantId, 'sales', 'sales');
  await add(tenantB, 'adminB', 'company_admin');
  app = await createTestApp(new MemoryThrottleStore(), new FakeGeoProvider(), new FakeScanner());
  for (const name of ['admin', 'buyer', 'sales', 'adminB'] as const) {
    tokens[name] = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: email(name), password: PASSWORD },
      })
    ).json<AuthSession>().accessToken;
  }
  const types = (await send('buyer', 'GET', '/config/asset-types')).json<AssetTypeItem[]>();
  asset = (
    await send('buyer', 'POST', '/assets', {
      assetTypeId: types.find((t) => t.key === 'pole')!.id,
      lat: 45.3486,
      lng: 25.5517,
      city: 'Sinaia',
    })
  ).json<AssetDetail>();
  // A 1200×800 photo carrying EXIF (camera make): derivatives must not keep it.
  jpeg = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#2b6' } })
    .withExif({ IFD0: { Make: 'TestCam' } })
    .jpeg()
    .toBuffer();
});

afterAll(async () => {
  await app?.close();
  await owner?.close();
});

function send(who: UserName, method: 'GET' | 'POST' | 'DELETE', path: string, payload?: object) {
  return app.inject({
    method,
    url: `/api/v1${path}`,
    headers: { authorization: `Bearer ${tokens[who]}` },
    ...(payload ? { payload } : {}),
  });
}
const code = (response: LightMyRequestResponse) => response.json<{ code: string }>().code;
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex');
const ticketFor = (who: UserName, body: Buffer, extra: object = {}) =>
  send(who, 'POST', '/files/uploads', {
    originalName: 'pole.jpg',
    mime: 'image/jpeg',
    sizeBytes: body.length,
    sha256: sha(body),
    subjectType: 'asset',
    subjectId: asset.id,
    purpose: 'ASSET_PHOTO',
    ...extra,
  });
const upload = (who: UserName, body: Buffer, extra: Partial<Parameters<typeof uploadFile>[2]> = {}) =>
  uploadFile(app, tokens[who], {
    subjectType: 'asset',
    subjectId: asset.id,
    purpose: 'ASSET_PHOTO',
    body,
    mime: 'image/jpeg',
    ...extra,
  });

describe('upload and processing', () => {
  let photo: FileLinkItem;

  it('a photo becomes READY with its size and a thumbnail; downloads use short-lived links', async () => {
    photo = await upload('buyer', jpeg, { name: 'Stâlp nord.jpg' });
    expect(photo).toMatchObject({
      subjectType: 'asset',
      subjectId: asset.id,
      purpose: 'ASSET_PHOTO',
      visibility: 'INTERNAL',
      file: { status: 'READY', width: 1200, height: 800, hasThumbnail: true, mime: 'image/jpeg' },
    });

    const original = await send('sales', 'GET', `/files/${photo.file.id}/url`);
    expect(original.statusCode).toBe(200);
    const got = await app.inject({ method: 'GET', url: original.json<{ url: string }>().url });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/jpeg');
    expect(got.headers['content-disposition']).toContain("filename*=UTF-8''St%C3%A2lp%20nord.jpg");
    expect(sha(got.rawPayload)).toBe(sha(jpeg)); // the original is kept as uploaded

    const thumbUrl = (await send('sales', 'GET', `/files/${photo.file.id}/url?variant=thumb`)).json<{
      url: string;
    }>();
    const thumb = await app.inject({ method: 'GET', url: thumbUrl.url });
    expect(thumb.headers['content-type']).toBe('image/webp');
    const meta = await sharp(thumb.rawPayload).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 480, height: 320 });
    expect(meta.exif).toBeUndefined();

    const events = await owner.db
      .select({ action: auditEvent.action })
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, tenantId), eq(auditEvent.subjectId, photo.file.id)));
    expect(events.map((e) => e.action).sort()).toEqual([
      'file.ready',
      'file.upload_started',
      'file.uploaded',
    ]);
  });

  it('rejects content that is not what was declared, and altered uploads', async () => {
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');
    const disguised = await upload('buyer', pdf, { name: 'photo.jpg' });
    expect(disguised.file).toMatchObject({
      status: 'REJECTED',
      statusReason: 'The content is application/pdf, not image/jpeg.',
    });

    const altered = await upload('buyer', jpeg, { sha256: sha(Buffer.from('something else')) });
    expect(altered.file).toMatchObject({ status: 'REJECTED' });
    expect(altered.file.statusReason).toMatch(/checksum/);

    // Never served.
    const url = await send('buyer', 'GET', `/files/${altered.file.id}/url`);
    expect([url.statusCode, code(url)]).toEqual([409, 'INVALID_TRANSITION']);
  });

  it('quarantines infected files', async () => {
    const eicar = Buffer.concat([
      jpeg.subarray(0, 16),
      Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'),
    ]);
    const infected = await upload('buyer', eicar);
    expect(infected.file).toMatchObject({
      status: 'QUARANTINED',
      statusReason: 'Virus found: Eicar-Test-Signature',
    });
    expect((await send('admin', 'GET', `/files/${infected.file.id}/url`)).statusCode).toBe(409);
  });

  it('validates the ticket: allowed types and per-type size limits', async () => {
    const exe = await ticketFor('buyer', jpeg, { mime: 'application/x-msdownload' });
    expect(exe.statusCode).toBe(422);
    const huge = await ticketFor('buyer', jpeg, { sizeBytes: 26 * 1024 * 1024 });
    expect(huge.statusCode).toBe(422);
  });

  it('complete needs the bytes first and happens once', async () => {
    const ticket = (await ticketFor('buyer', jpeg)).json<UploadTicket>();
    const early = await send('buyer', 'POST', `/files/${ticket.link.file.id}/complete`);
    expect([early.statusCode, code(early)]).toEqual([409, 'CONFLICT']);
    await app.inject({
      method: 'PUT',
      url: ticket.upload.url,
      headers: ticket.upload.headers,
      payload: jpeg,
    });
    const done = await send('buyer', 'POST', `/files/${ticket.link.file.id}/complete`);
    expect(done.json<FileItem>()).toMatchObject({ status: 'PENDING' });
    expect((await send('buyer', 'POST', `/files/${ticket.link.file.id}/complete`)).statusCode).toBe(409);
    // Still checking: no download yet.
    expect((await send('buyer', 'GET', `/files/${ticket.link.file.id}/url`)).statusCode).toBe(409);
  });

  it('upload links are bound to their signature, type and size', async () => {
    const ticket = (await ticketFor('buyer', jpeg)).json<UploadTicket>();
    const [payload, signature] = new URL(ticket.upload.url, 'http://x').searchParams.get('token')!.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), k: 'elsewhere/x' }),
    ).toString('base64url');
    const tampered = await app.inject({
      method: 'PUT',
      url: `/api/v1/storage?token=${forged}.${signature}`,
      headers: ticket.upload.headers,
      payload: jpeg,
    });
    expect(tampered.statusCode).toBe(403);
    const wrongType = await app.inject({
      method: 'PUT',
      url: ticket.upload.url,
      headers: { 'content-type': 'image/png' },
      payload: jpeg,
    });
    expect(wrongType.statusCode).toBe(400);
    const wrongSize = await app.inject({
      method: 'PUT',
      url: ticket.upload.url,
      headers: ticket.upload.headers,
      payload: jpeg.subarray(0, 100),
    });
    expect(wrongSize.statusCode).toBe(400);
    // A download link is not an upload link.
    const read = (await send('buyer', 'GET', `/files/${photo.file.id}/url`)).json<{ url: string }>();
    expect(
      (await app.inject({ method: 'PUT', url: read.url, headers: ticket.upload.headers, payload: jpeg }))
        .statusCode,
    ).toBe(403);
    // Binary bodies are only accepted on storage URLs.
    const elsewhere = await app.inject({
      method: 'POST',
      url: '/api/v1/files/uploads',
      headers: { authorization: `Bearer ${tokens.buyer}`, 'content-type': 'image/jpeg' },
      payload: jpeg,
    });
    expect(elsewhere.statusCode).toBe(415);
  });

  it('access follows the asset: readers download, editors attach, other tenants see nothing', async () => {
    const salesTicket = await ticketFor('sales', jpeg);
    expect([salesTicket.statusCode, code(salesTicket)]).toEqual([403, 'FORBIDDEN']);
    const salesList = await send('sales', 'GET', `/files?subjectType=asset&subjectId=${asset.id}`);
    expect(salesList.json<FileLinkItem[]>().length).toBeGreaterThan(0);

    const otherTenant = await ticketFor('adminB', jpeg);
    expect(otherTenant.statusCode).toBe(404);
    expect((await send('adminB', 'GET', `/files/${photo.file.id}/url`)).statusCode).toBe(404);
    expect((await send('adminB', 'GET', `/files?subjectType=asset&subjectId=${asset.id}`)).statusCode).toBe(
      404,
    );
  });

  it('unlinking detaches the file from the asset (it is no longer reachable through it)', async () => {
    expect((await send('sales', 'DELETE', `/file-links/${photo.linkId}`)).statusCode).toBe(403);
    expect((await send('buyer', 'DELETE', `/file-links/${photo.linkId}`)).statusCode).toBe(204);
    const list = (await send('buyer', 'GET', `/files?subjectType=asset&subjectId=${asset.id}`)).json<
      FileLinkItem[]
    >();
    expect(list.map((l) => l.linkId)).not.toContain(photo.linkId);
    expect((await send('buyer', 'GET', `/files/${photo.file.id}/url`)).statusCode).toBe(404);
  });
});
