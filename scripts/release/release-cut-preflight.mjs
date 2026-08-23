#!/usr/bin/env node

import {
    assertGitHubCliReady,
    assertNodeProjectBaseline,
    assertTagAbsent,
    bumpVersion,
    getUpstream,
    listChangedFiles,
    readVersion,
    requireNamedBranch,
} from './shared.mjs';

const MAIN_APP_RELEASE_IGNORED_PATH_PREFIXES = ['landing'];

async function main() {
    assertNodeProjectBaseline('Release preflight');
    await assertGitHubCliReady('Release preflight');
    const changedFiles = listChangedFiles({ignoredPathPrefixes: MAIN_APP_RELEASE_IGNORED_PATH_PREFIXES});
    if (changedFiles.length > 0) {
        throw new Error(
            'Release preflight requires a clean worktree before `pnpm run release:cut -- patch` can start. '
            + `Commit or remove these changes first: ${changedFiles.join(', ')}`,
        );
    }
    requireNamedBranch('Release preflight');

    const upstream = getUpstream();
    const currentVersion = readVersion();
    const nextPatchVersion = bumpVersion(currentVersion, 'patch');
    const tag = `v${nextPatchVersion}`;
    await assertTagAbsent(tag, upstream.remote);
    process.stdout.write(
        `Release patch preflight passed: ${currentVersion} -> ${nextPatchVersion} on ${upstream.ref}.\n`,
    );
}

main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
