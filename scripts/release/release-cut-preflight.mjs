#!/usr/bin/env node

import {assertReleaseCutPreconditions} from './cut-release.mjs';

async function main() {
    const {
        currentVersion,
        nextVersion,
        upstream,
    } = await assertReleaseCutPreconditions({
        context: 'Release preflight',
        level: 'patch',
    });

    process.stdout.write(
        `Release patch preflight passed: ${currentVersion} -> ${nextVersion} on ${upstream.ref}.\n`,
    );
}

main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
