import {
    join,
    relative,
} from 'node:path';

export const vendoredPackages = [
    'i18n-core',
    'release-selection',
];

export const vendoredContractFiles = [
    'release.ts',
    'runtimeGuards.ts',
];

export function createVendorManifest({
    landingRoot,
    repoPackages,
}) {
    const manifest = vendoredContractFiles.map(file => ({
        src: join(repoPackages, 'contracts', file),
        dest: join(landingRoot, 'vendor/contracts', file),
    }));

    for (const pkg of vendoredPackages) {
        const sourceDir = join(repoPackages, pkg);
        manifest.push({
            destDir: join(landingRoot, 'vendor', pkg),
            sourceDir,
        });
    }

    return manifest;
}

export function formatVendorPath(landingRoot, filePath) {
    return relative(landingRoot, filePath).replaceAll('\\', '/');
}
