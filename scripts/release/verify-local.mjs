import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    compact,
    difference,
} from 'es-toolkit/array';
import { run } from './shared.mjs';
import { RELEASE_BUILD_RECEIPT_ENV_VAR } from './build-receipt.mjs';
import { getLocalReleaseVerifyGateCommands } from './policy.mjs';

const RELEASE_VERIFY_DIFF_BUFFER_BYTES = 128 * 1024 * 1024;

export function getLocalReleaseVerifyCommands() {
    return getLocalReleaseVerifyGateCommands();
}

function splitGitOutput(output) {
    return compact(output.split('\n').map(line => line.trim())).sort();
}

export function getReleaseVerifyMutationSnapshot({runCommand = run} = {}) {
    const diffOptions = {maxBuffer: RELEASE_VERIFY_DIFF_BUFFER_BYTES};

    return {
        stagedDiff: runCommand('git', [
            'diff',
            '--cached',
            '--binary',
            '--no-ext-diff',
        ], diffOptions),
        trackedDiff: runCommand('git', [
            'diff',
            '--binary',
            '--no-ext-diff',
        ], diffOptions),
        untrackedFiles: splitGitOutput(runCommand('git', [
            'ls-files',
            '--others',
            '--exclude-standard',
        ])),
    };
}

function changedSnapshotSections(before, after) {
    const changedSections = [];

    if (before.trackedDiff !== after.trackedDiff) {
        changedSections.push('tracked diff');
    }

    if (before.stagedDiff !== after.stagedDiff) {
        changedSections.push('staged diff');
    }

    if (
        difference(before.untrackedFiles, after.untrackedFiles).length > 0
        || difference(after.untrackedFiles, before.untrackedFiles).length > 0
    ) {
        changedSections.push('untracked files');
    }

    return changedSections;
}

export function assertReleaseVerifyDidNotMutateWorktree(before, after) {
    const changedSections = changedSnapshotSections(before, after);

    if (changedSections.length === 0) {
        return;
    }

    throw new Error(
        'release:verify completed but changed the working tree snapshot: '
        + changedSections.join(', '),
    );
}

export function runLocalReleaseVerify({
    env = process.env,
    receiptPath = path.resolve('.devkit/analysis/release-build-receipt.json'),
    runCommand = run,
    snapshotGetter = getReleaseVerifyMutationSnapshot,
} = {}) {
    const before = snapshotGetter({runCommand});
    rmSync(receiptPath, {force: true});
    const releaseEnv = {
        ...env,
        [RELEASE_BUILD_RECEIPT_ENV_VAR]: receiptPath,
    };

    for (const command of getLocalReleaseVerifyCommands()) {
        runCommand(command.command, command.args, {
            env: releaseEnv,
            stdio: 'inherit',
        });
    }

    const after = snapshotGetter({runCommand});
    assertReleaseVerifyDidNotMutateWorktree(before, after);
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    runLocalReleaseVerify();
}
