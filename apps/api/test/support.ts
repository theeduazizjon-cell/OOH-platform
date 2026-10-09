import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { type FileLinkItem, type UploadTicket } from '@ooh/contracts';
import { inject } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp, createFastifyAdapter } from '../src/bootstrap';
import { loadEnv } from '../src/config/env';
import { THROTTLE_STORE, type ThrottleStore } from '../src/core/auth/login-throttle';
import { FILE_SCANNER, type FileScanner, NoFileScanner } from '../src/core/files/scanner';
import { GEO_PROVIDER, type GeocodeResult, type GeoProvider } from '../src/core/geo/geo-provider';
import { OutboxDispatcher } from '../src/core/outbox/outbox.dispatcher';
import { RedisService } from '../src/core/redis/redis.service';

/** In-memory ThrottleStore for tests (no Redis). */
export class MemoryThrottleStore implements ThrottleStore {
  readonly counts = new Map<string, number>();

  increment(key: string): Promise<number> {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return Promise.resolve(next);
  }

  read(key: string): Promise<number> {
    return Promise.resolve(this.counts.get(key) ?? 0);
  }

  reset(key: string): Promise<void> {
    this.counts.delete(key);
    return Promise.resolve();
  }
}

/**
 * Deterministic geocoding for tests, by city: Sinaia resolves (one precise match), Brașov is
 * ambiguous (two stores), "Down" throws (transient outage), anything else is not found. Records queries.
 */
export class FakeGeoProvider implements GeoProvider {
  readonly queries: string[] = [];

  geocode(query: string): Promise<GeocodeResult> {
    this.queries.push(query);
    if (query.includes('Down')) return Promise.reject(new Error('provider unavailable'));
    if (query.includes('Sinaia')) {
      return Promise.resolve({
        kind: 'resolved',
        candidate: {
          lat: 45.3486,
          lng: 25.5517,
          placeId: 'fake-sinaia',
          formattedAddress: 'Bd. Carol I 25, Sinaia',
          precise: true,
        },
      });
    }
    if (query.includes('Brașov')) {
      return Promise.resolve({
        kind: 'ambiguous',
        candidates: [
          {
            lat: 45.6427,
            lng: 25.5887,
            placeId: 'fake-b1',
            formattedAddress: 'Carrefour Coresi, Brașov',
            precise: true,
          },
          {
            lat: 45.6579,
            lng: 25.6012,
            placeId: 'fake-b2',
            formattedAddress: 'Carrefour Brașov Centru',
            precise: true,
          },
        ],
      });
    }
    return Promise.resolve({ kind: 'failed', reason: 'The address was not found.' });
  }
}

/** The full API (real HTTP pipeline, runtime DB role) with Redis replaced by in-memory fakes. */
export async function createTestApp(
  throttleStore: ThrottleStore = new MemoryThrottleStore(),
  geo: GeoProvider = new FakeGeoProvider(),
  scanner: FileScanner = new NoFileScanner(),
): Promise<NestFastifyApplication> {
  const env = loadEnv({
    NODE_ENV: 'test',
    // TEST_LOG_LEVEL=error shows the server side of unexpected 500s while debugging a test.
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    DATABASE_URL: inject('appUrl'),
    REDIS_URL: 'redis://localhost:1',
    JWT_SECRET: 'integration-secret-integration-secret-1',
    // Local storage (signed URLs served by the API) in a throwaway directory.
    FILE_STORAGE_DIR: mkdtempSync(join(tmpdir(), 'ooh-files-')),
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] })
    .overrideProvider(THROTTLE_STORE)
    .useValue(throttleStore)
    .overrideProvider(RedisService)
    .useValue({ onApplicationShutdown: () => Promise.resolve() })
    .overrideProvider(GEO_PROVIDER)
    .useValue(geo)
    .overrideProvider(FILE_SCANNER)
    .useValue(scanner)
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(env));
  await configureApp(app, env);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

/** Runs the outbox dispatcher until nothing is due (what the worker does in production). */
export async function drainOutbox(app: { get: NestFastifyApplication['get'] }): Promise<number> {
  const dispatcher = app.get(OutboxDispatcher);
  let total = 0;
  for (let pass = 0; pass < 20; pass++) {
    const processed = await dispatcher.runOnce();
    total += processed;
    if (processed === 0) break;
  }
  return total;
}

export interface UploadInput {
  subjectType: 'asset';
  subjectId: string;
  purpose: FileLinkItem['purpose'];
  body: Buffer;
  mime: string;
  name?: string;
  visibility?: 'INTERNAL' | 'EXTERNAL';
  /** Declared checksum (defaults to the real one). */
  sha256?: string;
}

/**
 * The browser's upload flow against local storage: ticket → PUT to the signed URL → complete →
 * the worker processes it. Returns the link as listed afterwards.
 */
export async function uploadFile(
  app: NestFastifyApplication,
  token: string,
  input: UploadInput,
): Promise<FileLinkItem> {
  const auth = { authorization: `Bearer ${token}` };
  const ticketRes = await app.inject({
    method: 'POST',
    url: '/api/v1/files/uploads',
    headers: auth,
    payload: {
      originalName: input.name ?? 'photo.jpg',
      mime: input.mime,
      sizeBytes: input.body.length,
      sha256: input.sha256 ?? createHash('sha256').update(input.body).digest('hex'),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      purpose: input.purpose,
      ...(input.visibility ? { visibility: input.visibility } : {}),
    },
  });
  if (ticketRes.statusCode !== 201)
    throw new Error(`upload ticket: ${ticketRes.statusCode} ${ticketRes.body}`);
  const ticket = ticketRes.json<UploadTicket>();
  const put = await app.inject({
    method: 'PUT',
    url: ticket.upload.url,
    headers: ticket.upload.headers,
    payload: input.body,
  });
  if (put.statusCode !== 200) throw new Error(`upload PUT: ${put.statusCode} ${put.body}`);
  const done = await app.inject({
    method: 'POST',
    url: `/api/v1/files/${ticket.link.file.id}/complete`,
    headers: auth,
  });
  if (done.statusCode !== 202) throw new Error(`complete: ${done.statusCode} ${done.body}`);
  await drainOutbox(app);
  const list = await app.inject({
    method: 'GET',
    url: `/api/v1/files?subjectType=${input.subjectType}&subjectId=${input.subjectId}`,
    headers: auth,
  });
  return list.json<FileLinkItem[]>().find((l) => l.linkId === ticket.link.linkId)!;
}
