import { defineConfig } from 'vitest/config';

export default defineConfig({test: {
    include: ['tests/e2e/electron/**/*.e2e.test.ts'],
    globals: false,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    retry: process.env.CI ? 2 : 1,
    testTimeout: 240_000,
    hookTimeout: 300_000,
    sequence: {concurrent: false},
}});
