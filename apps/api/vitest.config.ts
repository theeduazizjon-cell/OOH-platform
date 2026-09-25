import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
  // esbuild (Vitest's default transform) does not emit decorator metadata, which NestJS DI needs.
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
