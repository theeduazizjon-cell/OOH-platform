import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      // Compile the shared contracts from source (the package's dist is CommonJS for the API).
      '@ooh/contracts': path.resolve(import.meta.dirname, '../../packages/contracts/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    // Same-origin API in development: the refresh cookie (SameSite=Strict, path /api/v1/auth) just works.
    proxy: { '/api': 'http://localhost:3000' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
