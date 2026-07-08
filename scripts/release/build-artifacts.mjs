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
    getHeadSha,
    getUpstream,
    MAIN_APP_RELEASE_IGNORED_PATH_PREFIXES,
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
}) {
    const dispatchOutput = run('gh', getReleaseArtifactsWorkflowDispatchArgs({
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

export async function buildReleaseArtifacts() {
    assertNodeProjectBaseline('Release artifact build');
    await assertGitHubCliReady('Release artifact build');
    assertCleanWorktree({ ignoredPathPrefixes: MAIN_APP_RELEASE_IGNORED_PATH_PREFIXES });
    requireNamedBranch('Release artifact build');
    const upstream = getUpstream('Release artifact build');
    const targetSha = getHeadSha();

    run('git', [
        'push',
        upstream.remote,
        `HEAD:${upstream.branch}`,
    ], {stdio: 'inherit'});

    const dispatchStartedAt = new Date().toISOString();
    dispatchReleaseArtifactsWorkflow({
        branch: upstream.branch,
        targetSha,
    });
    await printReleaseArtifactsWorkflowHandoff({
        dispatchStartedAt,
        targetSha,
    });
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
