import { createDatabase } from '../client';
import { provisionTenant } from '../provisioning';

/** Local development seed. Safe to re-run. */
async function main(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is not set (copy .env.example to .env).');
  const connection = createDatabase(url, { max: 1, applicationName: 'ooh-seed' });
  try {
    const { tenantId } = await provisionTenant(connection.db, { name: 'Demo OOH SRL', slug: 'demo' });
    console.log(`✔ tenant "demo" ready (${tenantId}) with system roles`);
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  console.error('✖ seed failed:', error);
  process.exit(1);
});
