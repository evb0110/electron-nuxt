import { readFile } from 'node:fs/promises';
import path from 'node:path';

interface ILandingVendorFile {
    source: string;
    vendor: string;
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const VENDORED_FILES: readonly ILandingVendorFile[] = [
    {
        source: 'packages/contracts/release.ts',
        vendor: 'landing/vendor/contracts/release.ts',
    },
    {
        source: 'packages/i18n-core/createTypedI18nComposer.ts',
        vendor: 'landing/vendor/i18n-core/createTypedI18nComposer.ts',
    },
    {
        source: 'packages/i18n-core/index.ts',
        vendor: 'landing/vendor/i18n-core/index.ts',
    },
    {
        source: 'packages/i18n-core/localeCodes.ts',
        vendor: 'landing/vendor/i18n-core/localeCodes.ts',
    },
    {
        source: 'packages/i18n-core/localeDefinitions.ts',
        vendor: 'landing/vendor/i18n-core/localeDefinitions.ts',
    },
    {
        source: 'packages/i18n-core/messageFormat.ts',
        vendor: 'landing/vendor/i18n-core/messageFormat.ts',
    },
    {
        source: 'packages/i18n-core/schemaTypes.ts',
        vendor: 'landing/vendor/i18n-core/schemaTypes.ts',
    },
    {
        source: 'packages/release-selection/index.ts',
        vendor: 'landing/vendor/release-selection/index.ts',
    },
    {
        source: 'packages/release-selection/releaseSelection.ts',
        vendor: 'landing/vendor/release-selection/releaseSelection.ts',
    },
];

function transformVendoredSource(source: string) {
    return source
        .replaceAll('@evb/i18n-core/', './')
        .replaceAll('@evb/releaseSelection/releaseSelection', './releaseSelection');
}

async function readRepoFile(filePath: string) {
    return readFile(path.join(REPO_ROOT, filePath), 'utf8');
}

async function findDriftedVendoredFiles() {
    const drifted: string[] = [];

    for (const file of VENDORED_FILES) {
        const source = transformVendoredSource(await readRepoFile(file.source));
        const vendor = await readRepoFile(file.vendor);
        if (source !== vendor) {
            drifted.push(file.vendor);
        }
    }

    return drifted;
}

try {
    const drifted = await findDriftedVendoredFiles();
    if (drifted.length === 0) {
        console.log('landing/vendor is in sync with packages.');
    } else {
        console.error([
            'landing/vendor is out of sync with packages:',
            ...drifted.map(file => `  ${file}`),
            'Run `pnpm --dir landing run sync:vendor` and commit the result.',
        ].join('\n'));
        process.exit(1);
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
