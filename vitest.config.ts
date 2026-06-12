import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/test/**/*.test.ts'],
    // CLI/daemon suites spawn real node processes; under parallel workers on a
    // loaded host their wall-clock blows past the 5s default. Deadline, not logic.
    testTimeout: 30_000,
  },
});
