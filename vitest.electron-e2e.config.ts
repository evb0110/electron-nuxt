import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/e2e/electron/**/*.e2e.test.ts'],
        globals: false,
        fileParallelism: false,
        maxWorkers: 1,
        minWorkers: 1,
        retry: process.env.CI ? 1 : 0,
        testTimeout: 240_000,
        hookTimeout: 300_000,
        sequence: { concurrent: false },
    },
    // Puppeteer serializes helper callbacks into the page. esbuild keepNames
    // injects a runtime __name(...) wrapper that does not exist there.
    esbuild: { keepNames: false },
});
