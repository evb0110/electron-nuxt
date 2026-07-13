#!/usr/bin/env node

import {
    readFileSync,
    readdirSync,
} from 'node:fs';
import { resolve } from 'node:path';
import {
    assertPublishUpdaterMetadataPolicy,
    assertPublishUpdaterMetadataReferences,
    assertUpdaterMetadataVersion,
} from './policy.mjs';
import { assertMacUpdaterMetadataHashes } from './notarize-macos-dmgs.mjs';
import { assertUpdaterArtifactIntegrity } from './assert-updater-artifact-integrity.mjs';

const artifactsDir = resolve(process.cwd(), process.argv[2] ?? 'artifacts');
const artifactNames = readdirSync(artifactsDir);
const expectedVersion = process.argv[3]
    ?? JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')).version;

assertPublishUpdaterMetadataPolicy(artifactNames, process.env);
const hasUpdaterMetadata = assertPublishUpdaterMetadataReferences(
    artifactNames,
    metadataFileName => readFileSync(resolve(artifactsDir, metadataFileName), 'utf8'),
);

if (!hasUpdaterMetadata) {
    process.stdout.write('No updater metadata published for this release; continuing with manual-install artifacts only.\n');
} else {
    assertUpdaterMetadataVersion(
        artifactNames,
        metadataFileName => readFileSync(resolve(artifactsDir, metadataFileName), 'utf8'),
        expectedVersion,
    );
    assertUpdaterArtifactIntegrity({
        artifactNames,
        artifactsDir,
        readMetadataText: metadataFileName => readFileSync(resolve(artifactsDir, metadataFileName), 'utf8'),
    });
    assertMacUpdaterMetadataHashes({
        artifactNames,
        artifactsDir,
        readMetadataText: metadataFileName => readFileSync(resolve(artifactsDir, metadataFileName), 'utf8'),
    });
    process.stdout.write('Publish updater metadata policy passed.\n');
}
