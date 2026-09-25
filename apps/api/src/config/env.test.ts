import { describe, expect, it } from 'vitest';
import { InvalidEnvironmentError, loadEnv } from './env';

const valid = {
  DATABASE_URL: 'postgres://ooh_app:ooh_app@localhost:5432/ooh',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadEnv', () => {
  it('applies defaults and parses CORS origins', () => {
    const env = loadEnv({ ...valid, CORS_ORIGINS: 'http://localhost:5173, https://app.example.com ,' });
    expect(env).toMatchObject({ NODE_ENV: 'development', LOG_LEVEL: 'info', API_PORT: 3000 });
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'https://app.example.com']);
  });

  it('coerces the port', () => {
    expect(loadEnv({ ...valid, API_PORT: '8080' }).API_PORT).toBe(8080);
  });

  it('refuses to start with missing or malformed values and names them', () => {
    expect(() => loadEnv({ REDIS_URL: 'http://not-redis' })).toThrow(InvalidEnvironmentError);
    try {
      loadEnv({ REDIS_URL: 'http://not-redis' });
    } catch (error) {
      expect((error as Error).message).toContain('DATABASE_URL');
      expect((error as Error).message).toContain('REDIS_URL');
    }
  });
});
