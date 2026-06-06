import { resolve } from 'node:path';

const projectRoot = resolve(__dirname, '..');

export const vitestResolveAlias = {
    '@app': resolve(projectRoot, 'app'),
    '@electron': resolve(projectRoot, 'electron'),
    '@electron-worker-bundles': resolve(projectRoot, 'packages/electron-worker-bundles'),
    '@contracts': resolve(projectRoot, 'packages/contracts'),
    '@pdf-core': resolve(projectRoot, 'packages/pdf-core'),
    '@i18n-core': resolve(projectRoot, 'packages/i18n-core'),
    '@i18n-app': resolve(projectRoot, 'packages/i18n-app'),
    '@releaseSelection': resolve(projectRoot, 'packages/release-selection'),
    '@scripts': resolve(projectRoot, 'scripts'),
    '@server': resolve(projectRoot, 'server'),
    '@tests': resolve(projectRoot, 'tests'),
    electron: resolve(projectRoot, 'tests/mocks/electron.ts'),
} as const;
