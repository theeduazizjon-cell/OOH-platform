import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../src/migrate';

/** Keep in sync with infrastructure/docker/docker-compose.yml. */
export const POSTGIS_IMAGE = 'postgis/postgis:18-3.6';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Schema owner (superuser in tests): bypasses RLS, used for fixtures and assertions. */
    ownerUrl: string;
    /** Runtime role `ooh_app`: RLS applies, exactly like the API. */
    appUrl: string;
  }
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
 * Creates a throw-away database, bootstraps roles and applies all migrations exactly as a real
 * environment would. Uses TEST_DATABASE_URL (a superuser URL) when set, otherwise starts a
 * PostGIS container via Testcontainers (requires a Docker runtime).
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let adminUrl = process.env.TEST_DATABASE_URL;
  let stopContainer: (() => Promise<unknown>) | undefined;
  if (!adminUrl) {
    const container = await new PostgreSqlContainer(POSTGIS_IMAGE).start();
    adminUrl = container.getConnectionUri();
    stopContainer = () => container.stop();
  }

  const databaseName = `ooh_test_${Date.now()}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  await admin.unsafe(readFileSync(path.resolve(__dirname, '../sql/bootstrap-roles.sql'), 'utf8'));
  await admin.unsafe(`CREATE DATABASE ${databaseName}`);

  const ownerUrl = withDatabase(adminUrl, databaseName);
  await runMigrations(ownerUrl);

  project.provide('ownerUrl', ownerUrl);
  project.provide('appUrl', withDatabase(adminUrl, databaseName, { user: 'ooh_app', password: 'ooh_app' }));

  return async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
    await stopContainer?.();
  };
}
