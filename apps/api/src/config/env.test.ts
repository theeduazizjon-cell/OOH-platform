import { describe, expect, it } from 'vitest';
import { InvalidEnvironmentError, loadEnv } from './env';

const valid = {
  DATABASE_URL: 'postgres://ooh_app:ooh_app@localhost:5432/ooh',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'test-secret-test-secret-test-secret-123',
};
const productionFiles = {
  FILE_STORAGE: 's3',
  S3_BUCKET: 'ooh-files',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
  FILE_SCANNER: 'clamav',
};

describe('loadEnv', () => {
  it('derives secure cookies from NODE_ENV and forbids insecure cookies in production', () => {
    expect(loadEnv({ ...valid }).COOKIE_SECURE).toBe(false);
    expect(loadEnv({ ...valid, ...productionFiles, NODE_ENV: 'production' }).COOKIE_SECURE).toBe(true);
    expect(loadEnv({ ...valid, COOKIE_SECURE: 'true' }).COOKIE_SECURE).toBe(true);
    expect(() =>
      loadEnv({ ...valid, ...productionFiles, NODE_ENV: 'production', COOKIE_SECURE: 'false' }),
    ).toThrow(InvalidEnvironmentError);
  });

  it('files: local disk and no scanner in development only; S3 needs its bucket and keys', () => {
    expect(loadEnv({ ...valid })).toMatchObject({ FILE_STORAGE: 'local', FILE_SCANNER: 'none' });
    expect(() => loadEnv({ ...valid, NODE_ENV: 'production' })).toThrow(
      /FILE_STORAGE=s3 and FILE_SCANNER=clamav/,
    );
    expect(() =>
      loadEnv({ ...valid, ...productionFiles, NODE_ENV: 'production', FILE_SCANNER: 'none' }),
    ).toThrow(InvalidEnvironmentError);
    expect(() => loadEnv({ ...valid, FILE_STORAGE: 's3' })).toThrow(/S3_BUCKET/);
  });

  it('rejects a short JWT secret', () => {
    expect(() => loadEnv({ ...valid, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

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
