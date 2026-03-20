import {
    assertCleanWorktree,
    assertChangedFilesMatch,
    assertGitHubCliReady,
    assertGitHubSecretsPresent,
    assertNodeMajor,
    assertTagAbsent,
    bumpVersion,
    getUpstream,
    readVersion,
    requireNamedBranch,
    run,
    shouldSkipGitHubReleaseWait,
    stageFiles,
    VALID_RELEASE_LEVELS,
    writeVersion,
} from './shared.mjs';

async function main() {
    const level = process.argv[2];
    if (!VALID_RELEASE_LEVELS.has(level)) {
        throw new Error(
            `Expected release level to be one of: ${Array.from(VALID_RELEASE_LEVELS).join(', ')}`,
        );
    }

    assertNodeMajor(24);
    assertGitHubCliReady();
    assertGitHubSecretsPresent([
        'CSC_LINK',
        'CSC_KEY_PASSWORD',
    ]);
    assertCleanWorktree();
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

        // Release verification should not generate any tracked diffs besides the
        // intentional version bump. If it does, fail here instead of silently
        // folding those changes into the release commit.
        assertChangedFilesMatch([ 'package.json' ]);
        stageFiles([ 'package.json' ]);
        run('git', [
            'commit',
            '-m',
            `release: ${version}`,
        ], {stdio: 'inherit'});
        committed = true;
        run('git', [
            'tag',
            tag,
        ], {stdio: 'inherit'});
        run('git', [
            'push',
            '--atomic',
            upstream.remote,
            `HEAD:${upstream.branch}`,
            `refs/tags/${tag}`,
        ], {stdio: 'inherit'});

        if (shouldSkipGitHubReleaseWait()) {
            process.stdout.write(
                `Release ${tag} queued. GitHub will validate, build, and publish it from the tag-triggered Release workflow.\n`,
            );
            return;
        }

        run('node', [
            'scripts/release/wait-for-github-release.mjs',
            tag,
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
