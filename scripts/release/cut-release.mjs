import {
    assertCleanWorktree,
    assertChangedFilesMatch,
    assertGitHubCliReady,
    assertNodeProjectBaseline,
    assertTagAbsent,
    bumpVersion,
    getHeadSha,
    getUpstream,
    readVersion,
    requireNamedBranch,
    restoreVersionIfChanged,
    run,
    shouldSkipGitHubReleaseWait,
    stageFiles,
    VALID_RELEASE_LEVELS,
    writeVersion,
} from './shared.mjs';

const MAIN_APP_RELEASE_IGNORED_PATH_PREFIXES = ['landing'];

async function main() {
    const level = process.argv[2];
    if (!VALID_RELEASE_LEVELS.has(level)) {
        throw new Error(
            `Expected release level to be one of: ${Array.from(VALID_RELEASE_LEVELS).join(', ')}`,
        );
    }

    assertNodeProjectBaseline();
    assertGitHubCliReady();
    assertCleanWorktree({ ignoredPathPrefixes: MAIN_APP_RELEASE_IGNORED_PATH_PREFIXES });
    requireNamedBranch();
    const upstream = getUpstream();
    const currentVersion = readVersion();
    const nextVersion = bumpVersion(currentVersion, level);
    const tag = `v${nextVersion}`;
    let committed = false;

    assertTagAbsent(tag, upstream.remote);

    writeVersion(nextVersion);

    try {
        const version = readVersion();
        if (version !== nextVersion) {
            throw new Error(`Expected bumped version to be ${nextVersion}, received ${version}`);
        }

        run('pnpm', [
            'run',
            'release:verify',
        ], {stdio: 'inherit'});

        restoreVersionIfChanged(nextVersion);

        // Release verification should not generate any tracked diffs besides the
        // intentional version bump. If it does, fail here instead of silently
        // folding those changes into the release commit.
        assertChangedFilesMatch([ 'package.json' ], { ignoredPathPrefixes: MAIN_APP_RELEASE_IGNORED_PATH_PREFIXES });
        stageFiles([ 'package.json' ]);
        run('git', [
            'commit',
            '-m',
            `release: ${version} [skip ci]`,
            '--',
            'package.json',
        ], {stdio: 'inherit'});
        committed = true;
        const targetSha = getHeadSha();
        run('git', [
            'push',
            upstream.remote,
            `HEAD:${upstream.branch}`,
        ], {stdio: 'inherit'});
        const dispatchStartedAt = new Date().toISOString();
        const dispatchOutput = run('gh', [
            'workflow',
            'run',
            'release.yml',
            '--ref',
            upstream.branch,
            '--field',
            `tag=${tag}`,
            '--field',
            `target_ref=${targetSha}`,
        ]);
        if (dispatchOutput.length > 0) {
            process.stdout.write(`${dispatchOutput}\n`);
        }

        if (shouldSkipGitHubReleaseWait()) {
            process.stdout.write(
                `Release ${tag} queued for commit ${targetSha}. GitHub will rerun release checks, build, and publish it from the dispatched Release workflow.\n`,
            );
            return;
        }

        run('node', [
            'scripts/release/wait-for-github-release.mjs',
            tag,
            targetSha,
            dispatchStartedAt,
        ], {stdio: 'inherit'});
    } catch (error) {
        if (!committed) {
            writeVersion(currentVersion);
            process.stderr.write(
                `Restored package.json version to ${currentVersion} after release failure.\n`,
            );
        }
        throw error;
    }
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
});
