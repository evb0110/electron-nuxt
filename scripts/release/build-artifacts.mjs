import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatArtifactGroupList } from './artifact-groups.mjs';
import {
    getRunArtifactsUrl,
    waitForWorkflowRunStart,
} from './github-workflow-run.mjs';
import {
    assertCleanWorktree,
    assertGitHubCliReady,
    assertNodeProjectBaseline,
    getUpstream,
    MAIN_APP_RELEASE_IGNORED_PATH_PREFIXES,
    pushReleaseBranch,
    requireNamedBranch,
    run,
} from './shared.mjs';

const RELEASE_ARTIFACTS_WORKFLOW_FILE = 'release-artifacts.yml';
const RELEASE_ARTIFACTS_WORKFLOW_NAME = 'Build Release Artifacts';

export function getReleaseArtifactsWorkflowDispatchArgs({
    branch,
    targetSha,
}) {
    return [
        'workflow',
        'run',
        RELEASE_ARTIFACTS_WORKFLOW_FILE,
        '--ref',
        branch,
        '--field',
        `target_ref=${targetSha}`,
    ];
}

function dispatchReleaseArtifactsWorkflow({
    branch,
    targetSha,
}, runCommand = run) {
    const dispatchOutput = runCommand('gh', getReleaseArtifactsWorkflowDispatchArgs({
        branch,
        targetSha,
    }));
    if (dispatchOutput.length > 0) {
        process.stdout.write(`${dispatchOutput}\n`);
    }
}

function getReleaseArtifactsWorkflowDisplayTitles(targetSha) {
    return [`${RELEASE_ARTIFACTS_WORKFLOW_NAME} ${targetSha}`];
}

async function printReleaseArtifactsWorkflowHandoff({
    dispatchStartedAt,
    targetSha,
}) {
    const runInfo = await waitForWorkflowRunStart({
        createdAfter: dispatchStartedAt,
        displayTitles: getReleaseArtifactsWorkflowDisplayTitles(targetSha),
        label: `release artifact workflow for ${targetSha}`,
        targetSha,
        workflow: RELEASE_ARTIFACTS_WORKFLOW_NAME,
    });

    process.stdout.write(`Release artifact build queued for commit ${targetSha}.\n`);
    process.stdout.write(`GitHub Actions run: ${runInfo.url}\n`);
    process.stdout.write(`Actions artifacts, as they upload: ${getRunArtifactsUrl(runInfo.url)}\n`);
    process.stdout.write(`Expected artifact groups: ${formatArtifactGroupList()}\n`);
}

/**
 * Publishes the branch and dispatches the artifact workflow against exactly the
 * SHA that was pushed. `release:artifacts` runs with `HUSKY=0`, so the pre-push
 * hook never sees this push; `pushReleaseBranch` runs the same publication policy
 * scan as part of the same command before the push and throws on a violation,
 * leaving both the push and the dispatch undone.
 */
export async function publishReleaseArtifactsCommit({upstream}, {
    dispatchWorkflow = dispatchReleaseArtifactsWorkflow,
    printHandoff = printReleaseArtifactsWorkflowHandoff,
    runCommand = run,
} = {}) {
    const targetSha = pushReleaseBranch({upstream}, {runCommand});

    const dispatchStartedAt = new Date().toISOString();
    dispatchWorkflow({
        branch: upstream.branch,
        targetSha,
    }, runCommand);
    await printHandoff({
        dispatchStartedAt,
        targetSha,
    });

    return targetSha;
}

export async function buildReleaseArtifacts() {
    assertNodeProjectBaseline('Release artifact build');
    await assertGitHubCliReady('Release artifact build');
    assertCleanWorktree({ ignoredPathPrefixes: MAIN_APP_RELEASE_IGNORED_PATH_PREFIXES });
    requireNamedBranch('Release artifact build');

    await publishReleaseArtifactsCommit({upstream: getUpstream('Release artifact build')});
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    buildReleaseArtifacts().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exit(1);
    });
}
