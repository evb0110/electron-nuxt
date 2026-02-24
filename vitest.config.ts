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
                statements: 45,
                branches: 36,
                functions: 45,
                lines: 45,
                'electron/**/*.ts': {
                    statements: 53,
                    branches: 42,
                    functions: 50,
                    lines: 53,
                },
            },
        },
    },
});
