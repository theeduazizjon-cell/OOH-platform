import { sql } from 'drizzle-orm';
import type { Database, Transaction } from './client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, name: string): void {
  if (!UUID_RE.test(value)) throw new TypeError(`${name} must be a UUID, got "${value}"`);
}

export interface TenantContext {
  /** The tenant the operation acts in. Always taken from the verified access token. */
  readonly tenantId: string;
  /** The acting user, recorded for auditing (null for system jobs). */
  readonly actorUserId: string | null;
}

/**
 * Runs `fn` in a transaction bound to one tenant. Every tenant-scoped query MUST go through this
 * (or withUserTx): RLS policies read the transaction-local settings it sets, and without them
 * every tenant-owned table appears empty (fail closed).
 *
 * `set_config(..., true)` is transaction-local, so the context never leaks to the next user of a
 * pooled connection.
 */
export async function withTenantTx<T>(
  db: Database,
  context: TenantContext,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  assertUuid(context.tenantId, 'tenantId');
  if (context.actorUserId !== null) assertUuid(context.actorUserId, 'actorUserId');
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${context.tenantId}, true),
                 set_config('app.actor_id', ${context.actorUserId ?? ''}, true)`,
    );
    return fn(tx);
  });
}

/**
 * "User mode": runs `fn` in a transaction where only the user's own identity rows are visible
 * (their app_user row, their memberships across tenants, those tenants). Used before a tenant has
 * been selected, e.g. to build the tenant picker at login. Never combined with a tenant context.
 */
export async function withUserTx<T>(
  db: Database,
  userId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  assertUuid(userId, 'userId');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}
