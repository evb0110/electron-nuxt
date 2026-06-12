import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import {
    dirname,
    join,
    resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const landingRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoPackages = join(landingRoot, '..', 'packages');

const vendoredPackages = [
    'i18n-core',
    'release-selection',
];

function createVendorManifest({
    landingRoot: landingRootPath = landingRoot,
    repoPackages: repoPackagesPath = repoPackages,
} = {}) {
    const manifest = [{
        src: join(repoPackagesPath, 'contracts/release.ts'),
        dest: join(landingRootPath, 'vendor/contracts/release.ts'),
    }];

    for (const pkg of vendoredPackages) {
        const sourceDir = join(repoPackagesPath, pkg);
        for (const file of readdirSync(sourceDir)) {
            if (file.endsWith('.ts')) {
                manifest.push({
                    src: join(sourceDir, file),
                    dest: join(landingRootPath, 'vendor', pkg, file),
                });
            }
        }
    }

    return manifest;
}

export function transformVendoredSource(source) {
    return source
        .replaceAll('@evb/i18n-core/', './')
        .replaceAll('@evb/releaseSelection/releaseSelection', './releaseSelection');
}

function formatDriftError(drifted) {
    return [
        'landing/vendor is out of sync with ../packages:',
        ...drifted.map(file => `  ${file}`),
        'Run `pnpm sync:vendor` from landing/ and commit the result.',
    ].join('\n');
}

function formatMissingSourcesMessage() {
    return 'landing/vendor source packages are unavailable; using vendored files for this self-contained build';
}

function assertVendoredFilesExist({landingRoot: landingRootPath = landingRoot} = {}) {
    const missing = [
        join(landingRootPath, 'vendor/contracts/release.ts'),
        ...vendoredPackages.map(pkg => join(landingRootPath, 'vendor', pkg, 'index.ts')),
    ].filter(file => !existsSync(file));

    if (missing.length > 0) {
        throw new Error([
            'landing/vendor is incomplete:',
            ...missing.map(file => `  ${file}`),
            'Run `pnpm sync:vendor` from landing/ and commit the result.',
        ].join('\n'));
    }
}

export function syncVendor({
    check = false,
    landingRoot: landingRootPath = landingRoot,
    repoPackages: repoPackagesPath = repoPackages,
} = {}) {
    if (!existsSync(repoPackagesPath)) {
        if (!check) {
            throw new Error(`Cannot sync landing/vendor because ${repoPackagesPath} does not exist`);
        }

        assertVendoredFilesExist({landingRoot: landingRootPath});

        return {
            count: 0,
            drifted: [],
            skipped: formatMissingSourcesMessage(),
        };
    }

    const manifest = createVendorManifest({
        landingRoot: landingRootPath,
        repoPackages: repoPackagesPath,
    });
    const drifted = [];

    for (const {
        src, dest, 
    } of manifest) {
        const source = transformVendoredSource(readFileSync(src, 'utf8'));

        if (check) {
            if (!existsSync(dest) || readFileSync(dest, 'utf8') !== source) {
                drifted.push(dest);
            }
            continue;
        }

        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, source, 'utf8');
    }

    if (check && drifted.length > 0) {
        throw new Error(formatDriftError(drifted));
    }

    return {
        count: manifest.length,
        drifted,
    };
}

const isDirectCliRun = process.argv[1]
    && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    const check = process.argv.includes('--check');

    try {
        const result = syncVendor({check});
        if (result.skipped) {
            console.log(result.skipped);
        } else {
            console.log(check
                ? 'landing/vendor is in sync with ../packages'
                : `Synced ${result.count} files into landing/vendor`);
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
