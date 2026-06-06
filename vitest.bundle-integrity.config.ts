import { defineConfig } from 'vitest/config';
import { vitestResolveAlias } from './scripts/vitestResolveAlias';

export default defineConfig({
    resolve: {alias: vitestResolveAlias},
    test: {
        include: ['tests/unit/electron/bundleIntegrity.test.ts'],
        globals: false,
        setupFiles: ['tests/setup.ts'],
    },
});
