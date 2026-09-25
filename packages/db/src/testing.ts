/**
 * Test support: provisions a throw-away PostgreSQL 18 + PostGIS database with roles bootstrapped
 * and all migrations applied, exactly like a real environment. Import from `@ooh/db/testing`
 * in Vitest global setups only (depends on Testcontainers, a dev dependency).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { runMigrations } from './migrate';

/** Keep in sync with infrastructure/docker/docker-compose.yml. */
export const POSTGIS_IMAGE = 'postgis/postgis:18-3.6';

export const BOOTSTRAP_ROLES_SQL = path.resolve(__dirname, '..', 'sql', 'bootstrap-roles.sql');

export interface TestDatabase {
  /** Schema owner (superuser in tests): bypasses RLS; for fixtures and assertions. */
  readonly ownerUrl: string;
  /** Runtime role `ooh_app`: RLS applies, exactly like the API. */
  readonly appUrl: string;
  dispose(): Promise<void>;
}

function withDatabase(
  url: string,
  database: string,
  credentials?: { user: string; password: string },
): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (credentials) {
    parsed.username = credentials.user;
    parsed.password = credentials.password;
  }
  return parsed.toString();
}

/**
 * Uses TEST_DATABASE_URL (a superuser URL of an existing server) when set, otherwise starts a
 * PostGIS container via Testcontainers (requires a Docker runtime).
 */
export async function createTestDatabase(label = 'test'): Promise<TestDatabase> {
  let adminUrl = process.env.TEST_DATABASE_URL;
  let stopContainer: (() => Promise<unknown>) | undefined;
  if (!adminUrl) {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const container = await new PostgreSqlContainer(POSTGIS_IMAGE).start();
    adminUrl = container.getConnectionUri();
    stopContainer = () => container.stop();
  }

  const databaseName = `ooh_${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  await admin.unsafe(readFileSync(BOOTSTRAP_ROLES_SQL, 'utf8')).simple();
  await admin.unsafe(`CREATE DATABASE ${databaseName}`);

  const ownerUrl = withDatabase(adminUrl, databaseName);
  await runMigrations(ownerUrl);

  return {
    ownerUrl,
    appUrl: withDatabase(adminUrl, databaseName, { user: 'ooh_app', password: 'ooh_app' }),
    async dispose() {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin.end();
      await stopContainer?.();
    },
  };
}
