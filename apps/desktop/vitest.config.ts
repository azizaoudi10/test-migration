import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'test/e2e/**/*.test.ts'],
    globals: true,
    environment: 'node',
    exclude: ['node_modules', 'dist-electron', 'dist-renderer', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts', 'electron/**/*.ts'],
    },
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
