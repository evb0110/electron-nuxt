import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import AutoImport from 'unplugin-auto-import/vite';

export default defineConfig({
    plugins: [AutoImport({
        imports: [
            'vue',
            { 'vue-i18n': ['useI18n'] },
        ],
        dirs: ['app/composables/**'],
    })],
    resolve: {alias: {
        '@app': resolve(__dirname, 'app'),
        '@electron': resolve(__dirname, 'electron'),
        '@contracts': resolve(__dirname, 'packages/contracts'),
        '@i18n-core': resolve(__dirname, 'packages/i18n-core'),
        '@release-selection': resolve(__dirname, 'packages/release-selection'),
    }},
    test: {
        include: [
            'tests/unit/**/*.test.ts',
            'tests/integration/**/*.test.ts',
        ],
        globals: false,
        setupFiles: ['tests/setup.ts'],
        coverage: {
            provider: 'v8',
            reporter: [
                'text',
                'lcov',
            ],
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
