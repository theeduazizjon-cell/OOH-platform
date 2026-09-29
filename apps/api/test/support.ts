import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { inject } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp, createFastifyAdapter } from '../src/bootstrap';
import { loadEnv } from '../src/config/env';
import { THROTTLE_STORE, type ThrottleStore } from '../src/core/auth/login-throttle';
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

/** The full API (real HTTP pipeline, runtime DB role) with Redis replaced by in-memory fakes. */
export async function createTestApp(
  throttleStore: ThrottleStore = new MemoryThrottleStore(),
): Promise<NestFastifyApplication> {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: inject('appUrl'),
    REDIS_URL: 'redis://localhost:1',
    JWT_SECRET: 'integration-secret-integration-secret-1',
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] })
    .overrideProvider(THROTTLE_STORE)
    .useValue(throttleStore)
    .overrideProvider(RedisService)
    .useValue({ onApplicationShutdown: () => Promise.resolve() })
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(env));
  await configureApp(app, env);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
