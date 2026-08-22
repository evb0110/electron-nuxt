import {fileURLToPath} from 'node:url';
import path from 'node:path';
import { formatArtifactGroupList } from './artifact-groups.mjs';
import {
    findSuccessfulExactShaCiRun,
    getRepositoryUrlFromRunUrl,
    getRunArtifactsUrl,
    readWorkflowStartTimeoutMs,
    waitForWorkflowRunStart,
} from './github-workflow-run.mjs';
import {
    assertCleanWorktree,
    assertChangedFilesMatch,
    assertGitHubCliReady,
    assertNodeProjectBaseline,
    assertTagAbsent,
    bumpVersion,
    getReleaseMainUpstream,
    MAIN_APP_RELEASE_IGNORED_PATH_PREFIXES,
    pushReleaseBranch,
    readVersion,
    restoreVersionIfChanged,
    run,
    sleep,
    stageFiles,
    VALID_RELEASE_LEVELS,
    writeVersion,
} from './shared.mjs';

const WORKFLOW_HANDOFF_POLL_INTERVAL_MS = 5_000;

export function parseCutReleaseArgs(argv) {
    const knownFlags = new Set([
        '--resume',
        '--full-verify',
    ]);
    const unknownFlags = argv.filter(arg => arg.startsWith('--') && !knownFlags.has(arg));
    if (unknownFlags.length > 0) {
        throw new Error(`Unknown release option(s): ${unknownFlags.join(', ')}`);
    }

    const resume = argv.includes('--resume');
    const fullVerify = argv.includes('--full-verify');
    const positional = argv.filter(arg => !arg.startsWith('--'));

    if (resume) {
        if (positional.length > 0) {
            throw new Error('Release resume does not accept a release level. Run `pnpm run release:resume`.');
        }
        if (fullVerify) {
            throw new Error('Release resume never verifies locally; --full-verify only applies to a fresh cut.');
        }

        return {
            fullVerify: false,
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
        fullVerify,
        level,
        resume,
    };
}

/**
 * Decides whether the local `release:verify` gate can be skipped. It can only
 * when the pre-bump HEAD is exactly what the remote already advertises for
 * main AND that SHA has a successful push-CI run with a green `gates_ok`
 * aggregate — the same authority the release workflow's `prepare` enforces
 * before any release job runs. Everything the fast path skips is then a
 * literal re-execution of what that CI run (and the release build matrix)
 * already performs; the version bump itself only touches package.json.
 */
export function resolveLocalVerificationPlan({
    fullVerify,
    headSha,
    upstream,
}, {
    findCiRun = findSuccessfulExactShaCiRun,
    runCommand = run,
} = {}) {
    if (fullVerify) {
        return {
            reason: '--full-verify was requested',
            skipLocalVerify: false,
        };
    }

    let remoteSha = '';
    try {
        remoteSha = runCommand('git', [
            'ls-remote',
            upstream.remote,
            `refs/heads/${upstream.branch}`,
        ]).split('\n')[0]?.split(/\s+/u)[0]?.trim() ?? '';
    } catch {
        // Fail closed into the full local gate on any remote-lookup error.
    }
    if (!remoteSha || remoteSha !== headSha) {
        return {
            reason: `HEAD ${headSha} is not the advertised ${upstream.ref} tip (${remoteSha || 'unknown'})`,
            skipLocalVerify: false,
        };
    }

    let ciRun = null;
    try {
        ciRun = findCiRun(headSha, {runCommand});
    } catch {
        // Fail closed into the full local gate on any CI-lookup error.
    }
    if (!ciRun) {
        return {
            reason: `no successful exact-SHA push CI run with green gates_ok covers ${headSha}`,
            skipLocalVerify: false,
        };
    }

    return {
        ciRun,
        reason: `exact-SHA push CI already passed gates_ok for ${headSha}: ${ciRun.url}`,
        skipLocalVerify: true,
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
}, runCommand = run) {
    const dispatchOutput = runCommand('gh', getReleaseWorkflowDispatchArgs({
        branch,
        tag,
        targetSha,
    }));
    if (dispatchOutput.length > 0) {
        process.stdout.write(`${dispatchOutput}\n`);
    }
}

/**
 * Publishes the release commit and dispatches the release workflow against
 * exactly the SHA that was pushed. `pushReleaseBranch` runs the publication
 * policy scan first and throws on a violation, so a failing scan leaves both the
 * push and the dispatch undone.
 */
export async function publishReleaseCommit({
    tag,
    upstream,
}, {
    dispatchWorkflow = dispatchReleaseWorkflow,
    printHandoff = printReleaseWorkflowHandoff,
    runCommand = run,
} = {}) {
    const targetSha = pushReleaseBranch({upstream}, {runCommand});

    const dispatchStartedAt = new Date().toISOString();
    dispatchWorkflow({
        branch: upstream.branch,
        tag,
        targetSha,
    }, runCommand);
    await printHandoff({
        dispatchStartedAt,
        tag,
        targetSha,
    });

    return targetSha;
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

export async function printReleaseWorkflowHandoff({
    dispatchStartedAt,
    tag,
    targetSha,
}, {
    nowFn = Date.now,
    readHandoffTimeoutMs = readWorkflowStartTimeoutMs,
    sleepFn = sleep,
    stdout = process.stdout,
    waitForRun = waitForWorkflowRunStart,
} = {}) {
    const handoffDeadline = nowFn() + readHandoffTimeoutMs();
    let runInfo;

    while (true) {
        runInfo = await waitForRun({
            createdAfter: dispatchStartedAt,
            displayTitles: getReleaseWorkflowDisplayTitles(tag),
            label: `Release workflow for ${tag}`,
            targetSha,
            workflow: 'Release',
        });
        if (runInfo.status === 'completed' && runInfo.conclusion != null) {
            if (runInfo.conclusion !== 'success') {
                throw new Error(
                    `Release workflow for ${tag} concluded as ${runInfo.conclusion} before handoff: ${runInfo.url}`,
                );
            }

            break;
        }
        if (runInfo.status === 'in_progress') {
            break;
        }
        if (nowFn() >= handoffDeadline) {
            throw new Error(
                `Timed out while waiting for release workflow ${tag} to start or conclude.`,
            );
        }

        await sleepFn(WORKFLOW_HANDOFF_POLL_INTERVAL_MS);
    }

    const releaseUrl = getReleaseUrl({
        runUrl: runInfo.url,
        tag,
    });

    stdout.write(`Release ${tag} queued for commit ${targetSha}.\n`);
    stdout.write(`GitHub Actions run: ${runInfo.url}\n`);
    stdout.write(`Actions artifacts, as they upload: ${getRunArtifactsUrl(runInfo.url)}\n`);
    if (releaseUrl) {
        stdout.write(`GitHub Release, after publish: ${releaseUrl}\n`);
    }
    stdout.write(`Expected artifact groups: ${formatArtifactGroupList()}\n`);
}

async function resumeRelease() {
    const upstream = getReleaseMainUpstream();
    assertNodeProjectBaseline();
    await assertGitHubCliReady();
    assertCleanWorktree({ ignoredPathPrefixes: MAIN_APP_RELEASE_IGNORED_PATH_PREFIXES });
    const currentVersion = readVersion();
    const tag = `v${currentVersion}`;

    await assertTagAbsent(tag, upstream.remote);
    await publishReleaseCommit({
        tag,
        upstream,
    });
}

async function cutRelease(level, {fullVerify = false} = {}) {
    const upstream = getReleaseMainUpstream();
    assertNodeProjectBaseline();
    await assertGitHubCliReady();
    assertCleanWorktree({ ignoredPathPrefixes: MAIN_APP_RELEASE_IGNORED_PATH_PREFIXES });
    const currentVersion = readVersion();
    const nextVersion = bumpVersion(currentVersion, level);
    const tag = `v${nextVersion}`;
    let committed = false;

    await assertTagAbsent(tag, upstream.remote);

    // HEAD is the pre-bump tree by construction: writeVersion below only
    // edits package.json in the worktree, and the release commit is created
    // much later, so this SHA is exactly the commit the remote advertises
    // whenever the fast path is legal. Resolve the plan before touching
    // anything so a failed lookup leaves the worktree untouched.
    const headSha = run('git', [
        'rev-parse',
        'HEAD',
    ]);
    const verificationPlan = resolveLocalVerificationPlan({
        fullVerify,
        headSha,
        upstream,
    });

    writeVersion(nextVersion);

    try {
        const version = readVersion();
        if (version !== nextVersion) {
            throw new Error(`Expected bumped version to be ${nextVersion}, received ${version}`);
        }

        if (verificationPlan.skipLocalVerify) {
            process.stdout.write(
                `Skipping the local release gate: ${verificationPlan.reason}.\n`
                + 'CI packages and verifies every release target; pass --full-verify to force the local gate.\n',
            );
        } else {
            process.stdout.write(`Running the full local release gate: ${verificationPlan.reason}.\n`);
            run('pnpm', [
                'run',
                'release:verify',
            ], {stdio: 'inherit'});
        }

        restoreVersionIfChanged(nextVersion);

        // Release verification should not generate any tracked diffs besides the
        // intentional version bump. If it does, fail here instead of silently
        // folding those changes into the release commit.
        assertChangedFilesMatch([ 'package.json' ], { ignoredPathPrefixes: MAIN_APP_RELEASE_IGNORED_PATH_PREFIXES });
        stageFiles([ 'package.json' ]);
        run('git', [
            'commit',
            '-m',
            `release: ${version}`,
            '--',
            'package.json',
        ], {stdio: 'inherit'});
        committed = true;
        await publishReleaseCommit({
            tag,
            upstream,
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

    await cutRelease(args.level, {fullVerify: args.fullVerify});
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
