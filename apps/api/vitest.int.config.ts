import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/** API integration tests: the real HTTP pipeline against a real PostgreSQL 18 + PostGIS database. */
export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
