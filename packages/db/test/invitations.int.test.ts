/**
 * Database guarantees the invitation flow relies on.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionTenant } from '../src/provisioning';
import { appUser, invitation, membership } from '../src/schema';
import { withTenantTx } from '../src/tenant-context';
import { appConnection, expectPgError, ownerConnection, SQLSTATE } from './helpers';

const owner = ownerConnection();
const app = appConnection();
const suffix = Date.now().toString(36);
const UNIQUE_VIOLATION = '23505';

let tenantA: string;
let tenantB: string;
let inviteeId: string;
let membershipId: string;
let invitationId: string;

const inTenant = <T>(tenantId: string, fn: Parameters<typeof withTenantTx<T>>[2]) =>
  withTenantTx(app.db, { tenantId, actorUserId: null }, fn);

const ensureUser = (email: string, name = 'Invitee') =>
  sql`SELECT invitation_ensure_user(${email}, ${name}) AS id`;

type FoundInvitation = { tenant_id: string; membership_id: string; user_id: string; email: string };
const findInvitation = (id: string, hash: string) =>
  app.db.execute<FoundInvitation>(sql`SELECT * FROM auth_find_invitation(${id}, ${hash})`);

beforeAll(async () => {
  ({ tenantId: tenantA } = await provisionTenant(owner.db, { name: 'Invite A', slug: `inv-a-${suffix}` }));
  ({ tenantId: tenantB } = await provisionTenant(owner.db, { name: 'Invite B', slug: `inv-b-${suffix}` }));
});

afterAll(async () => {
  await app.close();
  await owner.close();
});

describe('invitation_ensure_user', () => {
  it('refuses to run without a tenant context', async () => {
    await expectPgError(
      app.db.execute(ensureUser(`nobody-${suffix}@example.com`)),
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
  });

  it('creates a passwordless user once and resolves the same email case-insensitively', async () => {
    const [created] = await inTenant(tenantA, (tx) =>
      tx.execute<{ id: string }>(ensureUser(`New-${suffix}@Example.com`)),
    );
    const [again] = await inTenant(tenantB, (tx) =>
      tx.execute<{ id: string }>(ensureUser(`new-${suffix}@example.com`, 'Other name')),
    );
    expect(created?.id).toBeTruthy();
    expect(again?.id).toBe(created?.id);
    inviteeId = created!.id;

    const [stored] = await owner.db.select().from(appUser).where(eq(appUser.id, inviteeId));
    expect(stored).toMatchObject({ displayName: 'Invitee', passwordHash: null });
  });

  it('returns null for a deactivated account', async () => {
    await owner.db
      .insert(appUser)
      .values({ email: `archived-${suffix}@example.com`, displayName: 'Old', archivedAt: new Date() });
    const [row] = await inTenant(tenantA, (tx) =>
      tx.execute<{ id: string | null }>(ensureUser(`archived-${suffix}@example.com`)),
    );
    expect(row?.id).toBeNull();
  });

  it('is the only path: the app role still cannot create users directly', async () => {
    await expectPgError(
      inTenant(tenantA, (tx) =>
        tx.insert(appUser).values({ email: `direct-${suffix}@example.com`, displayName: 'Direct' }),
      ),
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
  });
});

describe('invitation table', () => {
  beforeAll(async () => {
    const [m] = await inTenant(tenantA, (tx) =>
      tx.insert(membership).values({ tenantId: tenantA, userId: inviteeId }).returning({ id: membership.id }),
    );
    membershipId = m!.id;
    const [i] = await inTenant(tenantA, (tx) =>
      tx
        .insert(invitation)
        .values({
          tenantId: tenantA,
          membershipId,
          email: `new-${suffix}@example.com`,
          tokenHash: 'hash-1',
          expiresAt: new Date(Date.now() + 60_000),
        })
        .returning({ id: invitation.id }),
    );
    invitationId = i!.id;
  });

  it('is tenant-isolated', async () => {
    expect(await inTenant(tenantA, (tx) => tx.select().from(invitation))).toHaveLength(1);
    expect(await inTenant(tenantB, (tx) => tx.select().from(invitation))).toHaveLength(0);
  });

  it('allows only one pending invitation per membership', async () => {
    await expectPgError(
      inTenant(tenantA, (tx) =>
        tx.insert(invitation).values({
          tenantId: tenantA,
          membershipId,
          email: `new-${suffix}@example.com`,
          tokenHash: 'hash-2',
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ),
      UNIQUE_VIOLATION,
    );
  });

  it('is never deleted by the app (revoked instead)', async () => {
    await expectPgError(
      inTenant(tenantA, (tx) => tx.delete(invitation).where(eq(invitation.id, invitationId))),
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
  });
});

describe('auth_find_invitation', () => {
  it('finds an invitation without any context, but only with the matching token hash', async () => {
    const rows = await findInvitation(invitationId, 'hash-1');
    expect(rows).toEqual([
      expect.objectContaining({
        tenant_id: tenantA,
        membership_id: membershipId,
        user_id: inviteeId,
        email: `new-${suffix}@example.com`,
      }),
    ]);
    expect(await findInvitation(invitationId, 'wrong-hash')).toHaveLength(0);
  });

  it('is the only path: the app role cannot read invitations without context', async () => {
    const [row] = await app.client<{ n: number }[]>`SELECT count(*)::int AS n FROM invitation`;
    expect(row?.n).toBe(0);
  });
});
