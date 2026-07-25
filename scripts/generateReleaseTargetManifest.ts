import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ELECTRON_BUILDER_PLATFORM_KEYS,
    GLOBAL_PACKAGED_RESOURCES,
    getPackagedNativeToolFamilies,
    NATIVE_RESOURCE_PLATFORM_ARCHES,
} from '@scripts/nativeResourceManifest';
import { writeGeneratedFileIfChanged } from '@scripts/writeGeneratedFileIfChanged';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedRelativePath = 'scripts/release/generated-release-targets.cjs';

export function createReleaseTargetManifest() {
    const families = getPackagedNativeToolFamilies();
    return {
        electronBuilderPlatformKeys: ELECTRON_BUILDER_PLATFORM_KEYS,
        families,
        globalResources: GLOBAL_PACKAGED_RESOURCES,
        platformArches: NATIVE_RESOURCE_PLATFORM_ARCHES,
        schemaVersion: 1,
        signing: {
            entitlementsPathSegments: [
                'build',
                'entitlements.mac.plist',
            ],
            executableRoots: families.map(family => family.stagedRootSegments),
            platforms: ['darwin'],
        },
    };
}

export function renderReleaseTargetManifest() {
    const serializedManifest = JSON.stringify(createReleaseTargetManifest(), null, 4);
    return `'use strict';
const manifest = JSON.parse(String.raw\`${serializedManifest}\`);
function assertManifest(value) {
    const record = item => item && typeof item === 'object' && !Array.isArray(item);
    const strings = item => Array.isArray(item) && item.length > 0 && item.every(part => typeof part === 'string' && part.length > 0);
    const paths = item => strings(item) && item.every(part => part !== '.' && part !== '..' && !part.startsWith('/'));
    if (!record(value) || value.schemaVersion !== 1 || !strings(value.platformArches)) throw new Error('[release manifest] Invalid root');
    if (!record(value.electronBuilderPlatformKeys) || !Array.isArray(value.families) || value.families.length === 0) throw new Error('[release manifest] Invalid targets');
    for (const family of value.families) {
        if (!record(family) || !paths(family.sourceRootSegments) || !paths(family.stagedRootSegments) || !Array.isArray(family.packagedEntries) || family.packagedEntries.length === 0) throw new Error('[release manifest] Invalid family');
        for (const entry of family.packagedEntries) {
            if (!record(entry) || !paths(entry.pathSegments) || ![
                'directory',
                'file',
            ].includes(entry.type)) throw new Error('[release manifest] Invalid packaged entry');
        }
    }
    if (!Array.isArray(value.globalResources) || value.globalResources.length === 0) throw new Error('[release manifest] globalResources must be a non-empty array');
    for (const resource of value.globalResources) {
        if (!record(resource) || !paths(resource.sourceSegments) || !paths(resource.stagedSegments)) throw new Error('[release manifest] Invalid global resource');
    }
    if (!record(value.signing) || !strings(value.signing.platforms) || !paths(value.signing.entitlementsPathSegments) || !Array.isArray(value.signing.executableRoots) || !value.signing.executableRoots.every(paths)) throw new Error('[release manifest] Invalid signing inputs');
    return value;
}
function renderPackagedEntries(tag) {
    const platform = tag.slice(0, tag.lastIndexOf('-'));
    if (!manifest.platformArches.includes(tag)) {
        throw new Error(\`[release manifest] Unsupported platform-arch: \${tag}\`);
    }
    const suffix = platform === 'win32' ? '.exe' : '';
    const lines = manifest.families.flatMap(family => family.packagedEntries
        .filter(entry => !entry.platforms || entry.platforms.includes(platform))
        .map(entry => [
            'native',
            family.stagedRootSegments.join('/'),
            entry.pathSegments.join('/').replaceAll('{exeSuffix}', suffix),
            entry.type,
            entry.label,
            entry.id,
        ].join('\\t')));
    lines.push(...manifest.globalResources.map(resource => [
        'global',
        '',
        resource.stagedSegments.join('/'),
        resource.type,
        resource.label,
        resource.id,
    ].join('\\t')));
    return lines.join('\\n');
}
module.exports = {
    manifest: assertManifest(manifest),
    renderPackagedEntries,
    validateReleaseTargetManifest: assertManifest,
};
`;
}

export async function generateReleaseTargetManifest({projectRoot: targetRoot = projectRoot}: { projectRoot?: string } = {}) {
    return writeGeneratedFileIfChanged(
        path.join(targetRoot, generatedRelativePath),
        renderReleaseTargetManifest(),
    );
}

const isDirectCliRun = process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun && await generateReleaseTargetManifest()) {
    console.info('Generated release target manifest.');
}
