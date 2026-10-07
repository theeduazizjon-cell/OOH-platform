/**
 * The outbox's worker read path (migration 0023): outbox_claim leases pending events of every tenant,
 * only outside a tenant context, without handing the same event to two workers.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionTenant } from '../src/provisioning';
import { outboxEvent } from '../src/schema';
import { withTenantTx } from '../src/tenant-context';
import { appConnection, expectPgError, ownerConnection, SQLSTATE } from './helpers';

const owner = ownerConnection();
const app = appConnection();
const suffix = Date.now().toString(36);
let tenantA: string;
let tenantB: string;

interface Claimed {
  id: string;
  tenant_id: string;
  event_type: string;
}
const claim = (limit = 100, lease = 60) =>
  app.client<Claimed[]>`SELECT * FROM outbox_claim(${limit}, ${lease})`.then((rows) => [...rows]);
const publish = (tenantId: string, eventType: string) =>
  withTenantTx(app.db, { tenantId, actorUserId: null }, (tx) =>
    tx
      .insert(outboxEvent)
      .values({ tenantId, eventType, payload: { suffix } })
      .returning({ id: outboxEvent.id }),
  ).then((rows) => rows[0]!.id);

beforeAll(async () => {
  ({ tenantId: tenantA } = await provisionTenant(owner.db, { name: 'Outbox A', slug: `oba-${suffix}` }));
  ({ tenantId: tenantB } = await provisionTenant(owner.db, { name: 'Outbox B', slug: `obb-${suffix}` }));
  // Start from a clean slate: earlier suites leave undispatched events behind.
  await owner.db
    .update(outboxEvent)
    .set({ dispatchedAt: sql`now()` })
    .where(sql`${outboxEvent.dispatchedAt} IS NULL`);
});

afterAll(async () => {
  await app.close();
  await owner.close();
});

describe('outbox_claim', () => {
  it('leases pending events of every tenant, once', async () => {
    const a = await publish(tenantA, `test.a.${suffix}`);
    const b = await publish(tenantB, `test.b.${suffix}`);
    const first = await claim();
    expect(first.map((e) => [e.id, e.tenant_id]).sort()).toEqual(
      [
        [a, tenantA],
        [b, tenantB],
      ].sort(),
    );
    // Leased: a second worker gets nothing until the lease runs out.
    expect(await claim()).toEqual([]);

    await owner.db
      .update(outboxEvent)
      .set({ lockedUntil: sql`now() - interval '1 second'` })
      .where(eq(outboxEvent.id, a));
    expect((await claim()).map((e) => e.id)).toEqual([a]);
  });

  it('skips dispatched, failed and not-yet-due events, and honours the batch size', async () => {
    const done = await publish(tenantA, 'test.done');
    const dead = await publish(tenantA, 'test.dead');
    const later = await publish(tenantA, 'test.later');
    await owner.db
      .update(outboxEvent)
      .set({ dispatchedAt: sql`now()` })
      .where(eq(outboxEvent.id, done));
    await owner.db
      .update(outboxEvent)
      .set({ failedAt: sql`now()` })
      .where(eq(outboxEvent.id, dead));
    await owner.db
      .update(outboxEvent)
      .set({ nextAttemptAt: sql`now() + interval '1 hour'` })
      .where(eq(outboxEvent.id, later));
    expect(await claim()).toEqual([]);

    await publish(tenantA, 'test.one');
    await publish(tenantA, 'test.two');
    expect(await claim(1)).toHaveLength(1);
    expect(await claim(1)).toHaveLength(1);
  });

  it('is refused inside a tenant context, and the app role still cannot read other tenants directly', async () => {
    await expectPgError(
      withTenantTx(app.db, { tenantId: tenantA, actorUserId: null }, (tx) =>
        tx.execute(sql`SELECT * FROM outbox_claim(10, 60)`),
      ),
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
    await publish(tenantB, 'test.private');
    const visible = await withTenantTx(app.db, { tenantId: tenantA, actorUserId: null }, (tx) =>
      tx.select({ tenantId: outboxEvent.tenantId }).from(outboxEvent),
    );
    expect(visible.every((e) => e.tenantId === tenantA)).toBe(true);
  });
});
