import { Test } from '@nestjs/testing';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AppModule } from './app.module';
import { configureApp, createFastifyAdapter } from './bootstrap';
import { type Env, loadEnv } from './config/env';
import { DatabaseService } from './core/database/database.service';
import { RedisService } from './core/redis/redis.service';

const env: Env = loadEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://ooh_app:ooh_app@localhost:1/none',
  REDIS_URL: 'redis://localhost:1',
  JWT_SECRET: 'test-secret-test-secret-test-secret-123',
});

interface Fakes {
  database: Partial<DatabaseService>;
  redis: Partial<RedisService>;
}

let app: NestFastifyApplication | undefined;

async function createTestApp(fakes: Fakes): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] })
    .overrideProvider(DatabaseService)
    .useValue({
      onApplicationBootstrap: () => Promise.resolve(),
      onApplicationShutdown: () => Promise.resolve(),
      ...fakes.database,
    })
    .overrideProvider(RedisService)
    .useValue({ onApplicationShutdown: () => Promise.resolve(), ...fakes.redis })
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(env));
  await configureApp(app, env);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

const healthy: Fakes = {
  database: { ping: () => Promise.resolve({ postgis: '3.6.0' }) },
  redis: { ping: () => Promise.resolve({ response: 'PONG' }) },
};

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /api/v1/health', () => {
  it('returns 200 when PostgreSQL/PostGIS and Redis are up', async () => {
    const server = await createTestApp(healthy);
    const response = await server.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      checks: {
        database: { status: 'up', details: { postgis: '3.6.0' } },
        redis: { status: 'up', details: { ping: 'PONG' } },
      },
    });
  });

  it('returns 503 and names the failing dependency', async () => {
    const server = await createTestApp({
      ...healthy,
      database: {
        ping: () => Promise.reject(new Error('connect ECONNREFUSED')),
      },
    });
    const response = await server.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'degraded',
      checks: { database: { status: 'down', error: 'connect ECONNREFUSED' }, redis: { status: 'up' } },
    });
  });
});

describe('HTTP pipeline', () => {
  it('answers unknown routes with RFC 9457 problem details correlated by request id', async () => {
    const server = await createTestApp(healthy);
    const response = await server.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const body = response.json<{ code: string; requestId: string; instance: string }>();
    expect(body.code).toBe('NOT_FOUND');
    expect(body.instance).toBe('/api/v1/nope');
    expect(body.requestId).toBe(response.headers['x-request-id']);
  });

  it('propagates a well-formed caller request id and replaces a malformed one', async () => {
    const server = await createTestApp(healthy);
    const kept = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'x-request-id': 'lb-12345678' },
    });
    expect(kept.headers['x-request-id']).toBe('lb-12345678');
    const replaced = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'x-request-id': 'bad id<script>' },
    });
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets security headers', async () => {
    const server = await createTestApp(healthy);
    const response = await server.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['strict-transport-security']).toBeDefined();
  });
});
