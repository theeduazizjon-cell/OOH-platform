import { defineConfig } from 'vitest/config';

/** Integration tests: real PostgreSQL 18 + PostGIS (Testcontainers, or TEST_DATABASE_URL). */
export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 180_000,
    // One database shared by all files; files run sequentially to keep fixtures predictable.
    fileParallelism: false,
  },
});
