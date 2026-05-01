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
        '@i18n-app': resolve(__dirname, 'packages/i18n-app'),
        '@release-selection': resolve(__dirname, 'packages/release-selection'),
        electron: resolve(__dirname, 'tests/mocks/electron.ts'),
    }},
    test: {
        include: [
            'tests/unit/**/*.test.ts',
            'tests/integration/**/*.test.ts',
        ],
        exclude: ['tests/unit/electron/bundleIntegrity.test.ts'],
        globals: false,
        setupFiles: ['tests/setup.ts'],
        coverage: {
            provider: 'v8',
            reporter: [
                'text',
                'lcov',
            ],
            thresholds: {
                statements: 54,
                branches: 42,
                functions: 55,
                lines: 54,
                'electron/**/*.ts': {
                    statements: 58,
                    branches: 46,
                    functions: 57,
                    lines: 58,
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
