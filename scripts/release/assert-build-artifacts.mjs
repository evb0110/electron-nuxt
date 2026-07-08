#!/usr/bin/env node

import {
    readFileSync,
    readdirSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    assertPublishUpdaterMetadataPolicy,
    assertPublishUpdaterMetadataReferences,
    expectsUpdaterMetadata,
    getRequiredArtifactPatterns,
    getUpdaterMetadataFileNames,
} from './policy.mjs';
import { assertMacUpdaterMetadataHashes } from './notarize-macos-dmgs.mjs';

function createBuildTarget(platform, arch) {
    if (![
        'mac',
        'linux',
        'win',
    ].includes(platform)) {
        throw new Error(`Unsupported release artifact platform "${platform}"`);
    }
    if (![
        'arm64',
        'x64',
    ].includes(arch)) {
        throw new Error(`Unsupported release artifact arch "${arch}"`);
    }

    return {
        arch,
        expectsUpdaterMetadata: (
            (platform === 'mac' && arch === 'arm64')
            || (platform === 'win' && arch === 'x64')
        ),
        isPrimaryHostTarget: true,
        platform,
    };
}

export function assertBuildArtifacts({
    arch,
    artifactsDir = 'release',
    env = process.env,
    platform,
    readMetadataText,
    readArtifactInfo,
    artifactNames,
} = {}) {
    if (!platform || !arch) {
        throw new Error('Usage: assert-build-artifacts.mjs <artifactsDir> <platform> <arch>');
    }

    const target = createBuildTarget(platform, arch);
    const files = [...(artifactNames ?? readdirSync(resolve(process.cwd(), artifactsDir)))];

    for (const pattern of getRequiredArtifactPatterns(target, env)) {
        if (!files.some(fileName => pattern.test(fileName))) {
            throw new Error(`Missing packaged artifact matching ${pattern} in ${artifactsDir}/`);
        }
    }

    assertPublishUpdaterMetadataPolicy(files, env);
    const hasUpdaterMetadata = assertPublishUpdaterMetadataReferences(
        files,
        readMetadataText ?? (metadataFileName => readFileSync(resolve(process.cwd(), artifactsDir, metadataFileName), 'utf8')),
    );
    const blockmaps = files.filter(fileName => fileName.endsWith('.blockmap'));
    const shouldPublishUpdaterMetadata = expectsUpdaterMetadata(target, env);

    if (shouldPublishUpdaterMetadata && !hasUpdaterMetadata) {
        throw new Error(`Missing updater metadata for ${platform}-${arch}`);
    }
    if (
        platform === 'mac'
        && shouldPublishUpdaterMetadata
        && hasUpdaterMetadata
        && (readArtifactInfo || artifactNames == null)
    ) {
        assertMacUpdaterMetadataHashes({
            artifactNames: files,
            artifactsDir,
            readArtifactInfo,
            readMetadataText: readMetadataText ?? (metadataFileName => readFileSync(resolve(process.cwd(), artifactsDir, metadataFileName), 'utf8')),
        });
    }
    if (!shouldPublishUpdaterMetadata) {
        const updaterMetadata = getUpdaterMetadataFileNames(files);
        if (updaterMetadata.length > 0 || blockmaps.length > 0) {
            throw new Error(
                `Unexpected updater metadata for ${platform}-${arch}: `
                + [
                    ...updaterMetadata,
                    ...blockmaps,
                ].sort().join(', '),
            );
        }
    }

    return true;
}

const isDirectCliRun = process.argv[1]
    && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    assertBuildArtifacts({
        arch: process.argv[4],
        artifactsDir: process.argv[2] ?? 'release',
        platform: process.argv[3],
    });
    process.stdout.write('Release build artifact policy passed.\n');
}
