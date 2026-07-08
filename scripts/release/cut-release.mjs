import {fileURLToPath} from 'node:url';
import path from 'node:path';
import { formatArtifactGroupList } from './artifact-groups.mjs';
import {
    getRepositoryUrlFromRunUrl,
    getRunArtifactsUrl,
    waitForWorkflowRunStart,
} from './github-workflow-run.mjs';
import {
    assertCleanWorktree,
    assertChangedFilesMatch,
    assertGitHubCliReady,
    assertNodeProjectBaseline,
    assertTagAbsent,
    bumpVersion,
    getHeadSha,
    getUpstream,
    MAIN_APP_RELEASE_IGNORED_PATH_PREFIXES,
    readVersion,
    requireNamedBranch,
    restoreVersionIfChanged,
    run,
    stageFiles,
    VALID_RELEASE_LEVELS,
    writeVersion,
} from './shared.mjs';

export function parseCutReleaseArgs(argv) {
    const unknownFlags = argv.filter(arg => arg.startsWith('--') && arg !== '--resume');
    if (unknownFlags.length > 0) {
        throw new Error(`Unknown release option(s): ${unknownFlags.join(', ')}`);
    }

    const resume = argv.includes('--resume');
    const positional = argv.filter(arg => !arg.startsWith('--'));

    if (resume) {
        if (positional.length > 0) {
            throw new Error('Release resume does not accept a release level. Run `pnpm run release:resume`.');
        }

        return {
            level: null,
            resume,
        };
    }

    const [
        level,
        ...extraArgs
    ] = positional;

    if (extraArgs.length > 0) {
        throw new Error(`Unexpected release argument(s): ${extraArgs.join(', ')}`);
    }

    if (!VALID_RELEASE_LEVELS.has(level)) {
        throw new Error(
            `Expected release level to be one of: ${Array.from(VALID_RELEASE_LEVELS).join(', ')}`,
        );
    }

    return {
        level,
        resume,
    };
}

function getReleaseWorkflowDisplayTitles(tag) {
    return [
        `Release ${tag}`,
        `Release (${tag})`,
    ];
}

export function getReleaseWorkflowDispatchArgs({
    branch,
    tag,
    targetSha,
}) {
    return [
        'workflow',
        'run',
        'release.yml',
        '--ref',
        branch,
        '--field',
        `tag=${tag}`,
        '--field',
        `target_ref=${targetSha}`,
    ];
}

function dispatchReleaseWorkflow({
    branch,
    tag,
    targetSha,
}) {
    const dispatchOutput = run('gh', getReleaseWorkflowDispatchArgs({
        branch,
        tag,
        targetSha,
    }));
    if (dispatchOutput.length > 0) {
        process.stdout.write(`${dispatchOutput}\n`);
    }
}

function getReleaseUrl({
    runUrl,
    tag,
}) {
    const repositoryUrl = getRepositoryUrlFromRunUrl(runUrl);

    if (!repositoryUrl) {
        return '';
    }

    return `${repositoryUrl}/releases/tag/${encodeURIComponent(tag)}`;
}

async function printReleaseWorkflowHandoff({
    dispatchStartedAt,
    tag,
    targetSha,
}) {
    const runInfo = await waitForWorkflowRunStart({
        createdAfter: dispatchStartedAt,
        displayTitles: getReleaseWorkflowDisplayTitles(tag),
        label: `Release workflow for ${tag}`,
        targetSha,
        workflow: 'Release',
    });
    const releaseUrl = getReleaseUrl({
        runUrl: runInfo.url,
        tag,
    });

    process.stdout.write(`Release ${tag} queued for commit ${targetSha}.\n`);
    process.stdout.write(`GitHub Actions run: ${runInfo.url}\n`);
    process.stdout.write(`Actions artifacts, as they upload: ${getRunArtifactsUrl(runInfo.url)}\n`);
    if (releaseUrl) {
        process.stdout.write(`GitHub Release, after publish: ${releaseUrl}\n`);
    }
    process.stdout.write(`Expected artifact groups: ${formatArtifactGroupList()}\n`);
}

async function resumeRelease() {
    assertNodeProjectBaseline();
    await assertGitHubCliReady();
    assertCleanWorktree({ ignoredPathPrefixes: MAIN_APP_RELEASE_IGNORED_PATH_PREFIXES });
    requireNamedBranch();
    const upstream = getUpstream();
    const currentVersion = readVersion();
    const tag = `v${currentVersion}`;

    await assertTagAbsent(tag, upstream.remote);
    const targetSha = getHeadSha();
    run('git', [
        'push',
        upstream.remote,
        `HEAD:${upstream.branch}`,
    ], {stdio: 'inherit'});
    const dispatchStartedAt = new Date().toISOString();
    dispatchReleaseWorkflow({
        branch: upstream.branch,
        tag,
        targetSha,
    });
    await printReleaseWorkflowHandoff({
        dispatchStartedAt,
        tag,
        targetSha,
    });
}

async function cutRelease(level) {
    assertNodeProjectBaseline();
    await assertGitHubCliReady();
    assertCleanWorktree({ ignoredPathPrefixes: MAIN_APP_RELEASE_IGNORED_PATH_PREFIXES });
    requireNamedBranch();
    const upstream = getUpstream();
    const currentVersion = readVersion();
    const nextVersion = bumpVersion(currentVersion, level);
    const tag = `v${nextVersion}`;
    let committed = false;

    await assertTagAbsent(tag, upstream.remote);

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
        dispatchReleaseWorkflow({
            branch: upstream.branch,
            tag,
            targetSha,
        });
        await printReleaseWorkflowHandoff({
            dispatchStartedAt,
            tag,
            targetSha,
        });
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

async function main() {
    const args = parseCutReleaseArgs(process.argv.slice(2));
    if (args.resume) {
        await resumeRelease();
        return;
    }

    await cutRelease(args.level);
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    main().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exit(1);
    });
}
