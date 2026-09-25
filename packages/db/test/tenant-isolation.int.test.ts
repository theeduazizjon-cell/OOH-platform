/**
 * Tenant isolation: the database itself must prevent cross-tenant reads and writes, even if the
 * application forgets a WHERE clause. All assertions run as the runtime role `ooh_app`, like the API.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appUser, auditEvent, membership, membershipRole, role, tenant } from '../src/schema';
import { provisionTenant } from '../src/provisioning';
import { withTenantTx, withUserTx } from '../src/tenant-context';
import { appConnection, expectPgError, ownerConnection, SQLSTATE } from './helpers';

const owner = ownerConnection();
const app = appConnection();

let tenantA: string;
let tenantB: string;
let aliceId: string; // member of A
let bobId: string; // member of B
let carolId: string; // member of A and B (e.g. a decorator firm working for two OOH companies)
let aliceMembershipA: string;

beforeAll(async () => {
  const suffix = Date.now().toString(36);
  ({ tenantId: tenantA } = await provisionTenant(owner.db, { name: 'Alpha OOH', slug: `alpha-${suffix}` }));
  ({ tenantId: tenantB } = await provisionTenant(owner.db, { name: 'Beta OOH', slug: `beta-${suffix}` }));

  const users = await owner.db
    .insert(appUser)
    .values([
      { email: `alice-${suffix}@example.com`, displayName: 'Alice' },
      { email: `bob-${suffix}@example.com`, displayName: 'Bob' },
      { email: `carol-${suffix}@example.com`, displayName: 'Carol' },
    ])
    .returning({ id: appUser.id });
  [aliceId, bobId, carolId] = users.map((u) => u.id) as [string, string, string];

  const memberships = await owner.db
    .insert(membership)
    .values([
      { tenantId: tenantA, userId: aliceId, status: 'ACTIVE' },
      { tenantId: tenantB, userId: bobId, status: 'ACTIVE' },
      { tenantId: tenantA, userId: carolId, status: 'ACTIVE' },
      { tenantId: tenantB, userId: carolId, status: 'ACTIVE' },
    ])
    .returning({ id: membership.id });
  aliceMembershipA = memberships[0]!.id;
});

afterAll(async () => {
  await app.close();
  await owner.close();
});

const inA = <T>(fn: Parameters<typeof withTenantTx<T>>[2]) =>
  withTenantTx(app.db, { tenantId: tenantA, actorUserId: aliceId }, fn);

describe('tenant mode', () => {
  it('reads only rows of the active tenant', async () => {
    await inA(async (tx) => {
      const roles = await tx.select({ tenantId: role.tenantId }).from(role);
      expect(roles.length).toBeGreaterThan(0);
      expect(new Set(roles.map((r) => r.tenantId))).toEqual(new Set([tenantA]));

      const tenants = await tx.select({ id: tenant.id }).from(tenant);
      expect(tenants.map((t) => t.id)).toEqual([tenantA]);

      const members = await tx.select({ userId: membership.userId }).from(membership);
      expect(members.map((m) => m.userId).sort()).toEqual([aliceId, carolId].sort());

      // Global users are visible only when they are members of the active tenant.
      const users = await tx.select({ id: appUser.id }).from(appUser);
      expect(users.map((u) => u.id).sort()).toEqual([aliceId, carolId].sort());
    });
  });

  it('cannot insert rows into another tenant', async () => {
    await expectPgError(
      inA((tx) => tx.insert(role).values({ tenantId: tenantB, key: 'intruder', name: 'Intruder' })),
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
  });

  it('cannot move a row into another tenant', async () => {
    await expectPgError(
      inA((tx) => tx.update(role).set({ tenantId: tenantB }).where(eq(role.key, 'viewer'))),
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
  });

  it('cannot update or delete rows of another tenant (they are invisible)', async () => {
    const [updated, deleted] = await inA(async (tx) => [
      await tx.update(role).set({ name: 'Hacked' }).where(eq(role.tenantId, tenantB)).returning(),
      await tx.delete(membership).where(eq(membership.tenantId, tenantB)).returning(),
    ]);
    expect(updated).toHaveLength(0);
    expect(deleted).toHaveLength(0);

    const bRoles = await owner.db.select({ name: role.name }).from(role).where(eq(role.tenantId, tenantB));
    expect(bRoles.some((r) => r.name === 'Hacked')).toBe(false);
    const bMembers = await owner.db.select().from(membership).where(eq(membership.tenantId, tenantB));
    expect(bMembers).toHaveLength(2);
  });

  it('cannot create tenants', async () => {
    await expectPgError(
      inA((tx) => tx.insert(tenant).values({ name: 'Rogue', slug: `rogue-${Date.now()}` })),
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
  });
});

describe('without context (fail closed)', () => {
  it('sees nothing when no tenant or user context is set', async () => {
    const counts = await app.client<{ t: number; u: number; m: number; r: number; a: number }[]>`
      SELECT (SELECT count(*)::int FROM tenant) AS t, (SELECT count(*)::int FROM app_user) AS u,
             (SELECT count(*)::int FROM membership) AS m, (SELECT count(*)::int FROM role) AS r,
             (SELECT count(*)::int FROM audit_event) AS a`;
    expect(counts[0]).toEqual({ t: 0, u: 0, m: 0, r: 0, a: 0 });
  });

  it('does not leak context to the next query on the same pooled connection', async () => {
    await inA(async (tx) => {
      const rows = await tx.select().from(role);
      expect(rows.length).toBeGreaterThan(0);
    });
    // app pool has max: 1, so this reuses the very same connection.
    const [row] = await app.client<{ n: number }[]>`SELECT count(*)::int AS n FROM role`;
    expect(row?.n).toBe(0);
  });
});

describe('user mode (pre-tenant selection)', () => {
  it('lists only the user’s own memberships and tenants', async () => {
    await withUserTx(app.db, carolId, async (tx) => {
      const own = await tx.select({ tenantId: membership.tenantId }).from(membership);
      expect(own.map((m) => m.tenantId).sort()).toEqual([tenantA, tenantB].sort());
      const tenants = await tx.select({ id: tenant.id }).from(tenant);
      expect(tenants.map((t) => t.id).sort()).toEqual([tenantA, tenantB].sort());
      const users = await tx.select({ id: appUser.id }).from(appUser);
      expect(users.map((u) => u.id)).toEqual([carolId]);
      // Tenant data remains hidden until a tenant is selected.
      expect(await tx.select().from(role)).toHaveLength(0);
    });

    await withUserTx(app.db, aliceId, async (tx) => {
      const own = await tx.select({ tenantId: membership.tenantId }).from(membership);
      expect(own.map((m) => m.tenantId)).toEqual([tenantA]);
    });
  });
});

describe('composite foreign keys', () => {
  it('reject references that cross tenants, even for a role that bypasses RLS', async () => {
    const [bRole] = await owner.db
      .select({ id: role.id })
      .from(role)
      .where(and(eq(role.tenantId, tenantB), eq(role.key, 'viewer')));
    await expectPgError(
      owner.db
        .insert(membershipRole)
        .values({ tenantId: tenantA, membershipId: aliceMembershipA, roleId: bRole!.id }),
      SQLSTATE.FOREIGN_KEY_VIOLATION,
    );
  });
});

describe('audit trail', () => {
  it('is tenant-isolated and append-only', async () => {
    await inA((tx) =>
      tx
        .insert(auditEvent)
        .values({ tenantId: tenantA, actorType: 'USER', actorUserId: aliceId, action: 'test.recorded' }),
    );

    const seenInA = await inA((tx) =>
      tx.select().from(auditEvent).where(eq(auditEvent.action, 'test.recorded')),
    );
    expect(seenInA).toHaveLength(1);

    const seenInB = await withTenantTx(app.db, { tenantId: tenantB, actorUserId: bobId }, (tx) =>
      tx.select().from(auditEvent).where(eq(auditEvent.action, 'test.recorded')),
    );
    expect(seenInB).toHaveLength(0);

    await expectPgError(
      inA((tx) => tx.update(auditEvent).set({ action: 'test.tampered' })),
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
    await expectPgError(
      inA((tx) => tx.delete(auditEvent)),
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
  });

  it('rejects events written for another tenant', async () => {
    await expectPgError(
      inA((tx) =>
        tx.insert(auditEvent).values({ tenantId: tenantB, actorType: 'USER', action: 'test.spoofed' }),
      ),
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
  });

  it('accepts pre-tenant events without context, but they are not readable by tenants', async () => {
    await app.db
      .insert(auditEvent)
      .values({ tenantId: null, actorType: 'SYSTEM', action: 'auth.login_failed' });
    const visible = await inA((tx) =>
      tx.select().from(auditEvent).where(eq(auditEvent.action, 'auth.login_failed')),
    );
    expect(visible).toHaveLength(0);
    const [stored] = await owner.client<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_event WHERE action = 'auth.login_failed'`;
    expect(stored?.n).toBe(1);
  });

  it('cannot be read through a partition directly', async () => {
    const [partition] = await owner.client<{ name: string }[]>`
      SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'audit_event'::regclass LIMIT 1`;
    await expectPgError(
      inA((tx) => tx.execute(sql`SELECT * FROM ${sql.identifier(partition!.name)}`)),
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
  });
});
