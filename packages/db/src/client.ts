import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Database = PostgresJsDatabase<typeof schema>;

/** A transaction handle as passed to `db.transaction(cb)`. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DatabaseConnection {
  readonly db: Database;
  readonly client: postgres.Sql;
  close(): Promise<void>;
}

export interface CreateDatabaseOptions {
  /** Pool size. Default 10. */
  max?: number;
  /** Shown in pg_stat_activity; helps identify API vs worker vs scripts. */
  applicationName?: string;
}

/**
 * Creates a pooled connection. Connections are opened lazily on first query.
 * The runtime API must use the restricted `ooh_app` role (DATABASE_URL) so RLS applies.
 */
export function createDatabase(url: string, options: CreateDatabaseOptions = {}): DatabaseConnection {
  const client = postgres(url, {
    max: options.max ?? 10,
    connection: { application_name: options.applicationName ?? 'ooh' },
    onnotice: () => undefined,
  });
  const db = drizzle({ client, schema });
  return { db, client, close: () => client.end({ timeout: 5 }) };
}

export interface RoleInspection {
  readonly role: string;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
}

/**
 * Reports the privileges of the role this connection logs in as. The API refuses to start in
 * production when it could bypass Row-Level Security (i.e. was given the owner/superuser URL).
 */
export async function inspectCurrentRole(connection: DatabaseConnection): Promise<RoleInspection> {
  const [row] = await connection.client<{ role: string; superuser: boolean; bypass_rls: boolean }[]>`
    SELECT current_user AS role, rolsuper AS superuser, rolbypassrls AS bypass_rls
    FROM pg_roles WHERE rolname = current_user`;
  if (!row) throw new Error('Could not inspect the current database role');
  return { role: row.role, superuser: row.superuser, bypassRls: row.bypass_rls };
}
