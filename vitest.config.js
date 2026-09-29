import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./test/setup.js'],
    // Each file gets its own process so the module-level target list and
    // timers in targetsService cannot leak between files.
    pool: 'forks',
  },
});
