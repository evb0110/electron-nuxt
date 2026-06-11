import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    compact,
    difference,
} from 'es-toolkit/array';
import { run } from './shared.mjs';

export function getLocalReleaseVerifyCommands() {
    return [
        {
            args: [
                'run',
                'release:verify:checks',
            ],
            command: 'pnpm',
        },
        {
            args: [
                'run',
                'release:verify:package:local',
            ],
            command: 'pnpm',
        },
        {
            args: [
                'run',
                'check:resources:host',
            ],
            command: 'pnpm',
        },
    ];
}

function splitGitOutput(output) {
    return compact(output.split('\n').map(line => line.trim())).sort();
}

export function getReleaseVerifyMutationSnapshot({runCommand = run} = {}) {
    return {
        stagedDiff: runCommand('git', [
            'diff',
            '--cached',
            '--binary',
            '--no-ext-diff',
        ]),
        trackedDiff: runCommand('git', [
            'diff',
            '--binary',
            '--no-ext-diff',
        ]),
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
    runCommand = run,
    snapshotGetter = getReleaseVerifyMutationSnapshot,
} = {}) {
    const before = snapshotGetter({runCommand});

    for (const command of getLocalReleaseVerifyCommands()) {
        runCommand(command.command, command.args, {stdio: 'inherit'});
    }

    const after = snapshotGetter({runCommand});
    assertReleaseVerifyDidNotMutateWorktree(before, after);
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    runLocalReleaseVerify();
}
