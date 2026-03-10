import { execFileSync } from 'node:child_process';

const WORKFLOW_NAME = 'build.yml';
const DISCOVERY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 5_000;

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

async function waitForWorkflowRunId({
    headSha,
    branch,
    startedAt,
}) {
    const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;

    while (Date.now() < deadline) {
        const raw = run('gh', [
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
        ]);
        const runs = JSON.parse(raw);

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

    run('gh', [
        'run',
        'watch',
        String(workflowRun.databaseId),
        '--exit-status',
    ], {stdio: 'inherit'});
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
});
