import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit generates SQL from the TypeScript schema. Only tables listed here are managed by the
 * generator. Tables needing features drizzle-kit can't express (e.g. the partitioned audit_event)
 * live in hand-written migrations; see migrations/README.md.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/identity.ts',
  out: './migrations',
  strict: true,
  verbose: true,
});
