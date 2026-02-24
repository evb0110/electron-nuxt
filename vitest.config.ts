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
                statements: 35,
                branches: 30,
                functions: 35,
                lines: 35,
                'electron/**/*.ts': {
                    statements: 45,
                    branches: 35,
                    functions: 45,
                    lines: 45,
                },
            },
        },
    },
});
