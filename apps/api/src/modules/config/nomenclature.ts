import type { Transaction } from '@ooh/db';
import { like } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { type Principal } from '../../core/auth/principal';
import { type ClientInfo } from '../../core/http/client-info';

/** Shared helpers of the nomenclature services (keys and audit actor). */

export function slugKey(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return /^[a-z]/.test(slug) ? slug : `c_${slug || 'item'}`;
}

/** Slug of the name, suffixed `_2`, `_3`… when taken in the tenant (defaults use the bare slugs). */
export async function freeKey(
  tx: Transaction,
  table: PgTable,
  keyColumn: PgColumn,
  name: string,
): Promise<string> {
  const base = slugKey(name);
  const taken = new Set(
    (
      await tx
        .select({ key: keyColumn })
        .from(table)
        .where(like(keyColumn, `${base}%`))
    ).map((r) => String(r.key)),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

export function configActor(principal: Principal, client: ClientInfo) {
  return {
    tenantId: principal.tenantId,
    actorType: 'USER' as const,
    actorUserId: principal.userId,
    actorMembershipId: principal.membershipId,
    client,
  };
}
