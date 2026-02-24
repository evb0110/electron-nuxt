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
                statements: 37,
                branches: 32,
                functions: 37,
                lines: 37,
                'electron/**/*.ts': {
                    statements: 47,
                    branches: 37,
                    functions: 47,
                    lines: 47,
                },
            },
        },
    },
});
