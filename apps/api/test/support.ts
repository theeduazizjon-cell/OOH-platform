import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { inject } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp, createFastifyAdapter } from '../src/bootstrap';
import { loadEnv } from '../src/config/env';
import { THROTTLE_STORE, type ThrottleStore } from '../src/core/auth/login-throttle';
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
): Promise<NestFastifyApplication> {
  const env = loadEnv({
    NODE_ENV: 'test',
    // TEST_LOG_LEVEL=error shows the server side of unexpected 500s while debugging a test.
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    DATABASE_URL: inject('appUrl'),
    REDIS_URL: 'redis://localhost:1',
    JWT_SECRET: 'integration-secret-integration-secret-1',
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] })
    .overrideProvider(THROTTLE_STORE)
    .useValue(throttleStore)
    .overrideProvider(RedisService)
    .useValue({ onApplicationShutdown: () => Promise.resolve() })
    .overrideProvider(GEO_PROVIDER)
    .useValue(geo)
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
