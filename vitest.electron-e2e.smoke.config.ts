import { defineConfig } from 'vitest/config';

export default defineConfig({ test: {
    // Keep manual smoke focused on the one deterministic cross-stack startup
    // check that is still hard to replace with lower-level tests.
    include: ['tests/e2e/electron/phase0.startup-hydration.e2e.test.ts'],
    globals: false,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    retry: 0,
    testTimeout: 240_000,
    hookTimeout: 300_000,
    sequence: { concurrent: false },
} });
