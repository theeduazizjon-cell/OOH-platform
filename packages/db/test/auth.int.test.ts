/**
 * Database guarantees the authentication module relies on.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionTenant } from '../src/provisioning';
import { appUser, membership, refreshToken } from '../src/schema';
import { withTenantTx, withUserTx } from '../src/tenant-context';
import { appConnection, expectPgError, ownerConnection, SQLSTATE } from './helpers';

const owner = ownerConnection();
const app = appConnection();
const suffix = Date.now().toString(36);

let tenantId: string;
let userId: string;
let otherUserId: string;

beforeAll(async () => {
  ({ tenantId } = await provisionTenant(owner.db, { name: 'Auth OOH', slug: `auth-${suffix}` }));
  const users = await owner.db
    .insert(appUser)
    .values([
      { email: `Dana-${suffix}@Example.com`, displayName: 'Dana', passwordHash: '$argon2id$fake' },
      { email: `eve-${suffix}@example.com`, displayName: 'Eve', passwordHash: '$argon2id$other' },
      { email: `gone-${suffix}@example.com`, displayName: 'Gone', passwordHash: 'x', archivedAt: new Date() },
    ])
    .returning({ id: appUser.id });
  [userId, otherUserId] = users.map((u) => u.id) as [string, string];
  await owner.db.insert(membership).values([
    { tenantId, userId, status: 'ACTIVE' },
    { tenantId, userId: otherUserId, status: 'ACTIVE' },
  ]);
});

afterAll(async () => {
  await app.close();
  await owner.close();
});

type LoginRow = { user_id: string; password_hash: string | null };
const findLoginUser = (email: string) =>
  app.db.execute<LoginRow>(sql`SELECT * FROM auth_find_login_user(${email})`);

describe('auth_find_login_user', () => {
  it('finds a user by email case-insensitively without any context', async () => {
    const rows = await findLoginUser(`dana-${suffix}@example.COM`);
    expect(rows).toEqual([{ user_id: userId, password_hash: '$argon2id$fake' }]);
  });

  it('returns nothing for unknown or archived users', async () => {
    expect(await findLoginUser(`nobody-${suffix}@example.com`)).toHaveLength(0);
    expect(await findLoginUser(`gone-${suffix}@example.com`)).toHaveLength(0);
  });

  it('is the only path: the app role still cannot read users without context', async () => {
    const [row] = await app.client<{ n: number }[]>`SELECT count(*)::int AS n FROM app_user`;
    expect(row?.n).toBe(0);
  });

  it('is owned by a role nobody can log in as', async () => {
    const [role] = await owner.client<{ rolcanlogin: boolean }[]>`
      SELECT rolcanlogin FROM pg_roles WHERE rolname = 'ooh_auth'`;
    expect(role?.rolcanlogin).toBe(false);
  });
});

describe('refresh_token isolation', () => {
  const token = (forUser: string) => ({
    userId: forUser,
    familyId: '01000000-0000-7000-8000-000000000001',
    tokenHash: 'hash',
    activeTenantId: tenantId,
    expiresAt: new Date(Date.now() + 60_000),
  });

  it('lets a user create and read only their own tokens, in user mode', async () => {
    await withUserTx(app.db, userId, (tx) => tx.insert(refreshToken).values(token(userId)));
    await withUserTx(app.db, otherUserId, (tx) => tx.insert(refreshToken).values(token(otherUserId)));

    const own = await withUserTx(app.db, userId, (tx) => tx.select().from(refreshToken));
    expect(own.map((t) => t.userId)).toEqual([userId]);
  });

  it('rejects creating a token for someone else', async () => {
    await expectPgError(
      withUserTx(app.db, userId, (tx) => tx.insert(refreshToken).values(token(otherUserId))),
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
  });

  it('hides all tokens from tenant-mode transactions', async () => {
    const rows = await withTenantTx(app.db, { tenantId, actorUserId: userId }, (tx) =>
      tx.select().from(refreshToken),
    );
    expect(rows).toHaveLength(0);
  });

  it('never lets the app delete tokens (they are revoked instead)', async () => {
    await expectPgError(
      withUserTx(app.db, userId, (tx) => tx.delete(refreshToken).where(eq(refreshToken.userId, userId))),
      SQLSTATE.INSUFFICIENT_PRIVILEGE,
    );
  });
});
