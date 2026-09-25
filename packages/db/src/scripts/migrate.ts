import { runMigrations } from '../migrate';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL is not set (copy .env.example to .env).');
  process.exit(1);
}

runMigrations(url)
  .then(() => console.log('✔ migrations applied'))
  .catch((error: unknown) => {
    console.error('✖ migration failed:', error);
    process.exit(1);
  });
