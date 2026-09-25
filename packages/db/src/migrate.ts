import path from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDatabase } from './client';

/** Absolute path of the committed SQL migrations (shipped with the package). */
export const MIGRATIONS_FOLDER = path.resolve(__dirname, '..', 'migrations');

/**
 * Applies pending migrations. Must run as the schema owner (MIGRATION_DATABASE_URL), never as the
 * runtime role. Idempotent: applied migrations are tracked in the `drizzle` schema.
 */
export async function runMigrations(ownerUrl: string): Promise<void> {
  const connection = createDatabase(ownerUrl, { max: 1, applicationName: 'ooh-migrate' });
  try {
    await migrate(connection.db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await connection.close();
  }
}
