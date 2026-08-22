import {
    errorMessage,
    run,
    sleep,
} from './shared.mjs';

const DEFAULT_START_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5 * 1000;
const TRANSIENT_GITHUB_CLI_ERROR_PATTERNS = [
    /TLS handshake timeout/i,
    /context deadline exceeded/i,
    /connection reset/i,
    /ECONNRESET/i,
    /ETIMEDOUT/i,
    /EAI_AGAIN/i,
    /502 Bad Gateway/i,
    /503 Service Unavailable/i,
    /504 Gateway Timeout/i,
];

export function readWorkflowStartTimeoutMs(env = process.env) {
    const raw = env.EVB_GITHUB_WORKFLOW_START_TIMEOUT_MS?.trim();
    if (!raw) {
        return DEFAULT_START_TIMEOUT_MS;
    }

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(
            `EVB_GITHUB_WORKFLOW_START_TIMEOUT_MS must be a positive integer, received "${raw}"`,
        );
    }

    return parsed;
}

export function isTransientGitHubCliError(error) {
    const message = errorMessage(error);

    return TRANSIENT_GITHUB_CLI_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

export function briefErrorMessage(error) {
    return errorMessage(error).split('\n')[0] ?? String(error);
}

export function listWorkflowRuns(workflow, {runCommand = run} = {}) {
    const payload = runCommand('gh', [
        'run',
        'list',
        '--workflow',
        workflow,
        '--limit',
        '20',
        '--json',
        'createdAt,databaseId,displayTitle,headBranch,headSha,status,conclusion,url',
    ]);
    const parsed = JSON.parse(payload);
    if (!Array.isArray(parsed)) {
        throw new Error(`Unexpected GitHub CLI response while listing ${workflow} runs`);
    }

    return parsed;
}

export function isAtOrAfterCreatedAfter(runInfo, createdAfter) {
    if (!createdAfter) {
        return true;
    }

    const createdAtMs = Date.parse(String(runInfo.createdAt ?? ''));
    const createdAfterMs = Date.parse(createdAfter);

    if (!Number.isFinite(createdAtMs) || !Number.isFinite(createdAfterMs)) {
        return true;
    }

    // Allow a little clock skew between the local machine and GitHub's event timestamp.
    return createdAtMs >= createdAfterMs - 60_000;
}

function matchesDisplayTitle(runInfo, displayTitles) {
    if (displayTitles.length === 0) {
        return true;
    }

    return displayTitles.includes(String(runInfo.displayTitle ?? ''));
}

export function findWorkflowRun({
    createdAfter = '',
    displayTitles = [],
    runCommand = run,
    targetSha = '',
    workflow,
}) {
    return listWorkflowRuns(workflow, {runCommand}).find(runInfo => {
        if (!runInfo || typeof runInfo !== 'object') {
            return false;
        }

        const matchesTarget = !targetSha
            || !runInfo.headSha
            || runInfo.headSha === targetSha;

        return matchesDisplayTitle(runInfo, displayTitles)
            && matchesTarget
            && isAtOrAfterCreatedAfter(runInfo, createdAfter);
    }) ?? null;
}

function writeTransientPollingFailure({
    error,
    label,
    stderr,
    transientPollFailures,
}) {
    stderr.write(
        `Transient GitHub polling failure while locating ${label} `
        + `(attempt ${transientPollFailures}); retrying: ${briefErrorMessage(error)}\n`,
    );
}

export async function waitForWorkflowRunStart({
    createdAfter = '',
    displayTitles = [],
    findWorkflowRunFn = findWorkflowRun,
    label = '',
    nowFn = Date.now,
    readStartTimeoutMsFn = readWorkflowStartTimeoutMs,
    sleepFn = sleep,
    stderr = process.stderr,
    targetSha = '',
    workflow,
} = {}) {
    const deadline = nowFn() + readStartTimeoutMsFn();
    const workflowLabel = label || workflow;
    let transientPollFailures = 0;

    while (nowFn() < deadline) {
        try {
            const runInfo = findWorkflowRunFn({
                createdAfter,
                displayTitles,
                targetSha,
                workflow,
            });
            transientPollFailures = 0;

            if (runInfo) {
                return runInfo;
            }
        } catch (error) {
            if (!isTransientGitHubCliError(error)) {
                throw error;
            }

            transientPollFailures += 1;
            writeTransientPollingFailure({
                error,
                label: workflowLabel,
                stderr,
                transientPollFailures,
            });
        }

        await sleepFn(POLL_INTERVAL_MS);
    }

    throw new Error(
        `Timed out while locating ${workflowLabel}. `
        + 'Set EVB_GITHUB_WORKFLOW_START_TIMEOUT_MS to a larger value if needed.',
    );
}

/**
 * Finds the most recent completed, successful push-CI run for exactly this
 * SHA whose `gates_ok` aggregate also succeeded — the same authority the
 * release workflow's `prepare` job enforces remotely. Returns `null` when no
 * such run exists (including on API errors the caller treats as "not green").
 */
export function findSuccessfulExactShaCiRun(targetSha, {runCommand = run} = {}) {
    let workflowRuns;
    try {
        const runsPayload = runCommand('gh', [
            'api',
            '-H',
            'Accept: application/vnd.github+json',
            `repos/{owner}/{repo}/actions/workflows/ci.yml/runs?head_sha=${targetSha}&event=push&per_page=20`,
        ]);
        workflowRuns = JSON.parse(runsPayload)?.workflow_runs;
    } catch {
        return null;
    }
    if (!Array.isArray(workflowRuns)) {
        return null;
    }

    // The runs query already filters on event=push, so only exactness,
    // completion, and success need re-checking here.
    const successfulRun = workflowRuns
        .filter(runInfo => runInfo
            && runInfo.head_sha === targetSha
            && runInfo.status === 'completed'
            && runInfo.conclusion === 'success')
        .sort((left, right) => (left.run_number ?? 0) - (right.run_number ?? 0))
        .at(-1);
    if (!successfulRun) {
        return null;
    }

    let gatesConclusion;
    try {
        gatesConclusion = runCommand('gh', [
            'api',
            '--paginate',
            '-H',
            'Accept: application/vnd.github+json',
            `repos/{owner}/{repo}/actions/runs/${successfulRun.id}/jobs?per_page=100`,
            '--jq',
            '.jobs[] | select(.name == "gates_ok") | .conclusion',
        ]).split('\n').filter(Boolean).at(-1);
    } catch {
        return null;
    }
    if (gatesConclusion !== 'success') {
        return null;
    }

    return {
        id: successfulRun.id,
        url: successfulRun.html_url ?? '',
    };
}

export function getRunArtifactsUrl(runUrl) {
    return `${runUrl}#artifacts`;
}

export function getRepositoryUrlFromRunUrl(runUrl) {
    const match = String(runUrl).match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/actions\/runs\/\d+/u);

    return match?.[1] ?? '';
}
