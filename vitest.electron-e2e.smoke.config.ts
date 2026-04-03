import { defineConfig } from 'vitest/config';

export default defineConfig({ test: {
    // Keep smoke focused on deterministic cross-stack checks that exercise
    // startup plus the critical drawing persistence lifecycle in the desktop app.
    include: [
        'tests/e2e/electron/phase0.startup-hydration.e2e.test.ts',
        'tests/e2e/electron/phase1.draw-shape-lifecycle.e2e.test.ts',
    ],
    globals: false,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    retry: 0,
    testTimeout: 240_000,
    hookTimeout: 300_000,
    sequence: { concurrent: false },
} });
