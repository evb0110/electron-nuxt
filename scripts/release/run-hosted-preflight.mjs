import { execFileSync } from 'node:child_process';

const WORKFLOW_NAME = 'build.yml';
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

class HostedWorkflowFailure extends Error {
    constructor(message) {
        super(message);
        this.name = 'HostedWorkflowFailure';
    }
}

function run(command, args, options = {}) {
    const output = execFileSync(command, args, {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
        ...options,
    });

    if (output == null) {
        return '';
    }

    return String(output).trim();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function errorMessage(error) {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

function isTransientGhError(error) {
    const message = errorMessage(error).toLowerCase();
    return TRANSIENT_ERROR_PATTERNS.some(pattern => message.includes(pattern));
}

async function runGhJsonWithRetry(args, {
    timeoutMs,
    context,
} = {}) {
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

async function waitForWorkflowRunId({
    headSha,
    branch,
    startedAt,
}) {
    const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;

    while (Date.now() < deadline) {
        const runs = await runGhJsonWithRetry([
            'run',
            'list',
            '--workflow',
            WORKFLOW_NAME,
            '--branch',
            branch,
            '--limit',
            '20',
            '--json',
            'databaseId,headSha,event,status,createdAt,url',
        ], {
            timeoutMs: DISCOVERY_TIMEOUT_MS,
            context: `discovering hosted preflight run for ${headSha}`,
        });

        const matchingRun = runs.find(runInfo => (
            runInfo.headSha === headSha
            && runInfo.event === 'workflow_dispatch'
            && Date.parse(runInfo.createdAt) >= (startedAt - 60_000)
        ));

        if (matchingRun) {
            return matchingRun;
        }

        await sleep(POLL_INTERVAL_MS);
    }

    throw new Error(`Timed out waiting for hosted preflight run for ${headSha}`);
}

async function waitForWorkflowCompletion(runId) {
    const deadline = Date.now() + WATCH_TIMEOUT_MS;

    while (Date.now() < deadline) {
        const workflowRun = await runGhJsonWithRetry([
            'run',
            'view',
            String(runId),
            '--json',
            'status,conclusion,url',
        ], {
            timeoutMs: WATCH_TIMEOUT_MS,
            context: `monitoring hosted preflight run ${runId}`,
        });

        if (workflowRun.status === 'completed') {
            if (workflowRun.conclusion === 'success') {
                return;
            }

            throw new HostedWorkflowFailure(
                `Hosted preflight concluded with status ${workflowRun.conclusion || 'unknown'} (${workflowRun.url})`,
            );
        }

        await sleep(POLL_INTERVAL_MS);
    }

    throw new Error(`Timed out waiting for hosted preflight run ${runId} to complete`);
}

async function main() {
    const branch = run('git', [
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
    ]);
    if (branch === 'HEAD') {
        throw new Error('Hosted preflight requires a named branch, not detached HEAD');
    }

    const headSha = run('git', [
        'rev-parse',
        'HEAD',
    ]);
    const startedAt = Date.now();

    run('gh', [
        'workflow',
        'run',
        WORKFLOW_NAME,
        '--ref',
        branch,
        '-f',
        'run_release=false',
    ], {stdio: 'inherit'});

    const workflowRun = await waitForWorkflowRunId({
        headSha,
        branch,
        startedAt,
    });
    process.stdout.write(`Hosted preflight run: ${workflowRun.url}\n`);
    await waitForWorkflowCompletion(workflowRun.databaseId);
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    if (error instanceof HostedWorkflowFailure) {
        process.exit(1);
    }
    process.exit(2);
});
