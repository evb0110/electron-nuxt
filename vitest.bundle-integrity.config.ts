import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {alias: {
        '@app': resolve(__dirname, 'app'),
        '@electron': resolve(__dirname, 'electron'),
        '@contracts': resolve(__dirname, 'packages/contracts'),
        '@i18n-core': resolve(__dirname, 'packages/i18n-core'),
        '@i18n-app': resolve(__dirname, 'packages/i18n-app'),
        '@releaseSelection': resolve(__dirname, 'packages/release-selection'),
        electron: resolve(__dirname, 'tests/mocks/electron.ts'),
    }},
    test: {
        include: ['tests/unit/electron/bundleIntegrity.test.ts'],
        globals: false,
        setupFiles: ['tests/setup.ts'],
    },
});
