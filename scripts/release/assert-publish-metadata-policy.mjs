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

/** @param {string} metadataFileName */
function readMetadataText(metadataFileName) {
    return readFileSync(resolve(artifactsDir, metadataFileName), 'utf8');
}

assertPublishUpdaterMetadataPolicy(artifactNames, process.env);
const hasUpdaterMetadata = assertPublishUpdaterMetadataReferences(
    artifactNames,
    readMetadataText,
);

if (!hasUpdaterMetadata) {
    process.stdout.write('No updater metadata published for this release; continuing with manual-install artifacts only.\n');
} else {
    assertUpdaterMetadataVersion(
        artifactNames,
        readMetadataText,
        expectedVersion,
    );
    assertUpdaterArtifactIntegrity({
        artifactNames,
        artifactsDir,
        readMetadataText,
    });
    assertMacUpdaterMetadataHashes({
        artifactNames,
        artifactsDir,
        readMetadataText,
    });
    process.stdout.write('Publish updater metadata policy passed.\n');
}
