import { randomUUID } from 'node:crypto';
import {
    errorMessage,
    getHeadSha,
    requireNamedBranch,
    run,
    sleep,
} from './shared.mjs';

const DISCOVERY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 5_000;
const WATCH_TIMEOUT_MS = 60 * 60 * 1000;
const TRANSIENT_ERROR_PATTERNS = [
    'can\'t assign requested address',
    'connection reset',
    'connection refused',
    'context deadline exceeded',
    'econnreset',
    'econnrefused',
    'ehostunreach',
    'enetunreach',
    'failed to get run',
    'i/o timeout',
    'internal server error',
    'read tcp',
    'service unavailable',
    'tls handshake timeout',
];

const RELEASE_PHASES = {
    preflight: {
        displayName: 'release preflight',
        workflowFile: 'release-preflight.yml',
    },
    publish: {
        displayName: 'release publish',
        workflowFile: 'publish.yml',
    },
};

export class HostedWorkflowFailure extends Error {
    constructor(message) {
        super(message);
        this.name = 'HostedWorkflowFailure';
    }
}

export class HostedWorkflowCancelled extends Error {
    constructor(message) {
        super(message);
        this.name = 'HostedWorkflowCancelled';
    }
}

function isTransientGhError(error) {
    const message = errorMessage(error).toLowerCase();
    return TRANSIENT_ERROR_PATTERNS.some(pattern => message.includes(pattern));
}

async function runGhJsonWithRetry(args, {
    context,
    timeoutMs,
}) {
    const deadline = Date.now() + timeoutMs;

    while (true) {
        try {
            const raw = run('gh', args);
            return JSON.parse(raw);
        } catch (error) {
            if (!isTransientGhError(error) || Date.now() >= deadline) {
                throw error;
            }

            process.stderr.write(
                `Transient GitHub CLI error while ${context}; retrying in ${POLL_INTERVAL_MS / 1000}s.\n`,
            );
            await sleep(POLL_INTERVAL_MS);
        }
    }
}

function findMatchingRun(runs, {
    headSha,
    releaseId,
    refName,
    startedAt,
}) {
    const startedAtFloor = startedAt - 60_000;

    const matchingRuns = runs
        .filter(runInfo => (
            runInfo.headSha === headSha
            && runInfo.event === 'workflow_dispatch'
            && Date.parse(runInfo.createdAt) >= startedAtFloor
            && (!releaseId || runInfo.displayTitle?.includes(releaseId))
        ))
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));

    if (refName) {
        const exactRefMatch = matchingRuns.find(runInfo => runInfo.headBranch === refName);
        if (exactRefMatch) {
            return exactRefMatch;
        }
    }

    return matchingRuns[0];
}

async function waitForWorkflowRun({
    headSha,
    phaseName,
    releaseId,
    refName,
    startedAt,
}) {
    const phase = RELEASE_PHASES[phaseName];
    const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;

    while (Date.now() < deadline) {
        const runs = await runGhJsonWithRetry([
            'run',
            'list',
            '--workflow',
            phase.workflowFile,
            '--limit',
            '20',
            '--json',
            'databaseId,displayTitle,headBranch,headSha,event,status,createdAt,url',
        ], {
            context: `discovering ${phase.displayName} run for ${headSha}`,
            timeoutMs: DISCOVERY_TIMEOUT_MS,
        });

        const matchingRun = findMatchingRun(runs, {
            headSha,
            releaseId,
            refName,
            startedAt,
        });
        if (matchingRun) {
            return matchingRun;
        }

        await sleep(POLL_INTERVAL_MS);
    }

    throw new Error(`Timed out waiting for ${phase.displayName} run for ${headSha}`);
}

async function waitForWorkflowCompletion({
    phaseName,
    runId,
}) {
    const phase = RELEASE_PHASES[phaseName];
    const deadline = Date.now() + WATCH_TIMEOUT_MS;

    while (Date.now() < deadline) {
        const workflowRun = await runGhJsonWithRetry([
            'run',
            'view',
            String(runId),
            '--json',
            'status,conclusion,url',
        ], {
            context: `monitoring ${phase.displayName} run ${runId}`,
            timeoutMs: WATCH_TIMEOUT_MS,
        });

        if (workflowRun.status === 'completed') {
            if (workflowRun.conclusion === 'success') {
                return workflowRun;
            }

            if (workflowRun.conclusion === 'cancelled') {
                throw new HostedWorkflowCancelled(
                    `${phase.displayName} was cancelled (${workflowRun.url})`,
                );
            }

            throw new HostedWorkflowFailure(
                `${phase.displayName} concluded with status ${workflowRun.conclusion || 'unknown'} (${workflowRun.url})`,
            );
        }

        await sleep(POLL_INTERVAL_MS);
    }

    throw new Error(`Timed out waiting for ${phase.displayName} run ${runId} to complete`);
}

async function runPhase({
    headSha,
    phaseName,
    releaseId,
    refName,
    inputs = {},
}) {
    const phase = RELEASE_PHASES[phaseName];
    const startedAt = Date.now();
    const dispatchArgs = [
        'workflow',
        'run',
        phase.workflowFile,
        '--ref',
        refName,
    ];

    for (const [
        key,
        value,
    ] of Object.entries(inputs)) {
        if (value == null || value === '') {
            continue;
        }

        dispatchArgs.push('-f', `${key}=${value}`);
    }

    run('gh', dispatchArgs, {stdio: 'inherit'});

    const workflowRun = await waitForWorkflowRun({
        headSha,
        phaseName,
        releaseId,
        refName,
        startedAt,
    });
    process.stdout.write(`${phase.displayName} run: ${workflowRun.url}\n`);
    const completedRun = await waitForWorkflowCompletion({
        phaseName,
        runId: workflowRun.databaseId,
    });

    return {
        ...workflowRun,
        ...completedRun,
    };
}

export async function runPreflightPhase({
    branch = requireNamedBranch('Release preflight'),
    headSha = getHeadSha(),
} = {}) {
    const releaseId = `preflight-${headSha.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
    return runPhase({
        headSha,
        phaseName: 'preflight',
        releaseId,
        refName: branch,
        inputs: {
            ref: headSha,
            release_id: releaseId,
        },
    });
}

export async function runPublishPhase({
    headSha,
    tag,
    preflightRunId,
}) {
    if (!tag) {
        throw new Error('Release publish requires a tag name');
    }

    return runPhase({
        headSha: headSha || getHeadSha(`${tag}^{commit}`),
        phaseName: 'publish',
        refName: tag,
        inputs: {
            tag,
            preflight_run_id: preflightRunId ? String(preflightRunId) : undefined,
        },
    });
}

export async function runPhaseFromCli(argv = process.argv.slice(2)) {
    const phaseName = argv[0];
    if (phaseName === 'preflight') {
        await runPreflightPhase();
        return;
    }

    if (phaseName === 'publish') {
        await runPublishPhase({
            tag: argv[1],
            preflightRunId: argv[2],
        });
        return;
    }

    throw new Error('Expected phase to be one of: preflight, publish');
}
