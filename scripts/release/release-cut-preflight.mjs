#!/usr/bin/env node

import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertReleaseCutPreconditions} from './cut-release.mjs';

export async function runReleasePreflight({
    assertPreconditions = assertReleaseCutPreconditions,
    level = 'patch',
    write = message => {
        process.stdout.write(message);
    },
} = {}) {
    const {
        currentVersion,
        nextVersion,
        upstream,
    } = await assertPreconditions({
        context: 'Release preflight',
        level,
    });

    write(`Release ${level} preflight passed: ${currentVersion} -> ${nextVersion} on ${upstream.ref}.\n`);
    return {
        currentVersion,
        nextVersion,
        upstream,
    };
}

const isMain = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
    runReleasePreflight().catch(error => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
