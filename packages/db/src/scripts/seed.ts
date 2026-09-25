import { hash } from '@node-rs/argon2';
import { and, eq } from 'drizzle-orm';
import { createDatabase, type Database } from '../client';
import { provisionTenant } from '../provisioning';
import { appUser, membership, membershipRole, role } from '../schema';

/**
 * Local development seed. Safe to re-run. Never run against production.
 * Users (password = SEED_PASSWORD, default below):
 *   admin@demo.local   → Company Admin of "Demo OOH SRL" and Viewer of "Second OOH SRL"
 *   viewer@demo.local  → Viewer of "Demo OOH SRL" (useful to see 403 responses)
 */
const DEFAULT_PASSWORD = 'demo-password-change-me';

async function ensureUser(
  db: Database,
  email: string,
  displayName: string,
  passwordHash: string,
): Promise<string> {
  await db
    .insert(appUser)
    .values({ email, displayName, passwordHash })
    .onConflictDoNothing({ target: appUser.email });
  const [user] = await db.select({ id: appUser.id }).from(appUser).where(eq(appUser.email, email));
  return user!.id;
}

async function ensureMember(db: Database, tenantId: string, userId: string, roleKey: string): Promise<void> {
  await db
    .insert(membership)
    .values({ tenantId, userId, status: 'ACTIVE' })
    .onConflictDoNothing({ target: [membership.tenantId, membership.userId] });
  const [m] = await db
    .select({ id: membership.id })
    .from(membership)
    .where(and(eq(membership.tenantId, tenantId), eq(membership.userId, userId)));
  const [r] = await db
    .select({ id: role.id })
    .from(role)
    .where(and(eq(role.tenantId, tenantId), eq(role.key, roleKey)));
  await db
    .insert(membershipRole)
    .values({ tenantId, membershipId: m!.id, roleId: r!.id })
    .onConflictDoNothing();
}

async function main(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is not set (copy .env.example to .env).');
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed demo data in production.');
  const password = process.env.SEED_PASSWORD ?? DEFAULT_PASSWORD;

  const connection = createDatabase(url, { max: 1, applicationName: 'ooh-seed' });
  try {
    const { db } = connection;
    const { tenantId: demo } = await provisionTenant(db, { name: 'Demo OOH SRL', slug: 'demo' });
    const { tenantId: second } = await provisionTenant(db, { name: 'Second OOH SRL', slug: 'second' });

    const passwordHash = await hash(password);
    const admin = await ensureUser(db, 'admin@demo.local', 'Demo Admin', passwordHash);
    const viewer = await ensureUser(db, 'viewer@demo.local', 'Demo Viewer', passwordHash);
    await ensureMember(db, demo, admin, 'company_admin');
    await ensureMember(db, second, admin, 'viewer');
    await ensureMember(db, demo, viewer, 'viewer');

    console.log('✔ seed complete');
    console.log(`  tenants: demo (${demo}), second (${second})`);
    console.log(
      `  users:   admin@demo.local, viewer@demo.local  (password: ${process.env.SEED_PASSWORD ? '$SEED_PASSWORD' : DEFAULT_PASSWORD})`,
    );
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  console.error('✖ seed failed:', error);
  process.exit(1);
});
