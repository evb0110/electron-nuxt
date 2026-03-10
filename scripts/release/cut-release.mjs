import {
    assertCleanWorktree,
    assertTagAbsent,
    bumpVersion,
    getHeadSha,
    getUpstream,
    listChangedFiles,
    readVersion,
    requireNamedBranch,
    run,
    stageFiles,
    VALID_RELEASE_LEVELS,
    writeVersion,
} from './shared.mjs';
import {
    runPreflightPhase,
    runPublishPhase,
} from './workflow-phase.mjs';

async function main() {
    const level = process.argv[2];
    if (!VALID_RELEASE_LEVELS.has(level)) {
        throw new Error(
            `Expected release level to be one of: ${Array.from(VALID_RELEASE_LEVELS).join(', ')}`,
        );
    }

    assertCleanWorktree();
    requireNamedBranch();
    const upstream = getUpstream();
    const currentVersion = readVersion();
    const nextVersion = bumpVersion(currentVersion, level);
    const tag = `v${nextVersion}`;

    assertTagAbsent(tag, upstream.remote);

    run('pnpm', [
        'run',
        'release:verify',
    ], {stdio: 'inherit'});
    run('pnpm', [
        'run',
        'check:resources:matrix',
    ], {stdio: 'inherit'});
    writeVersion(nextVersion);

    const version = readVersion();
    if (version !== nextVersion) {
        throw new Error(`Expected bumped version to be ${nextVersion}, received ${version}`);
    }

    stageFiles(listChangedFiles());
    run('git', [
        'commit',
        '-m',
        version,
    ], {stdio: 'inherit'});
    run('git', [
        'push',
        upstream.remote,
        `HEAD:${upstream.branch}`,
    ], {stdio: 'inherit'});

    const preflightRun = await runPreflightPhase({
        branch: upstream.branch,
        headSha: getHeadSha(),
    });

    run('git', [
        'tag',
        tag,
    ], {stdio: 'inherit'});
    run('git', [
        'push',
        upstream.remote,
        `refs/tags/${tag}`,
    ], {stdio: 'inherit'});

    await runPublishPhase({
        tag,
        preflightRunId: preflightRun.databaseId,
    });
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
});
