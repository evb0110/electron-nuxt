import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
    resolve: {
        alias: {
            '@app': resolve(__dirname, 'app'),
            '@electron': resolve(__dirname, 'electron'),
        },
    },
    test: {
        include: ['tests/**/*.test.ts'],
        globals: false,
        setupFiles: ['tests/setup.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov'],
            thresholds: {
                statements: 50,
                branches: 40,
                functions: 53,
                lines: 50,
                'electron/**/*.ts': {
                    statements: 55,
                    branches: 44,
                    functions: 55,
                    lines: 55,
                },
                'app/composables/page/**/*.ts': {
                    statements: 68,
                    branches: 60,
                    functions: 50,
                    lines: 68,
                },
            },
        },
    },
});
