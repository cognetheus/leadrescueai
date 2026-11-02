import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Integration tests spin up HTTP servers and SQLite files; keep files isolated per worker.
    pool: 'forks',
    // Local-model tests only run when explicitly requested.
    exclude: process.env.RUN_OLLAMA_TESTS === '1' ? [] : ['tests/**/*.ollama.test.ts'],
  },
});
