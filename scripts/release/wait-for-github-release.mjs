import {
    errorMessage,
    run,
    sleep,
} from './shared.mjs';

const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;
const POLL_INTERVAL_MS = 10 * 1000;

function readTag() {
    const tag = process.argv[2]?.trim();
    if (!tag) {
        throw new Error('Expected a release tag argument, for example `v1.2.3`');
    }

    return tag;
}

function readWaitTimeoutMs() {
    const raw = process.env.EVB_RELEASE_WAIT_TIMEOUT_MS?.trim();
    if (!raw) {
        return DEFAULT_TIMEOUT_MS;
    }

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(
            `EVB_RELEASE_WAIT_TIMEOUT_MS must be a positive integer, received "${raw}"`,
        );
    }

    return parsed;
}

function listReleaseRuns() {
    const payload = run('gh', [
        'run',
        'list',
        '--workflow',
        'Release',
        '--limit',
        '20',
        '--json',
        'databaseId,displayTitle,headBranch,status,conclusion,url',
    ]);
    const parsed = JSON.parse(payload);
    if (!Array.isArray(parsed)) {
        throw new Error('Unexpected GitHub CLI response while listing release runs');
    }

    return parsed;
}

function findReleaseRun(tag) {
    const targetTitle = `Release (${tag})`;

    return listReleaseRuns().find(runInfo => {
        if (!runInfo || typeof runInfo !== 'object') {
            return false;
        }

        return runInfo.headBranch === tag
            || runInfo.displayTitle === targetTitle;
    }) ?? null;
}

function readFailedJobSummary(runId) {
    const payload = run('gh', [
        'run',
        'view',
        String(runId),
        '--json',
        'jobs,url',
    ]);
    const parsed = JSON.parse(payload);
    const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];

    const failedJobs = jobs
        .filter(job => job?.conclusion === 'failure')
        .map(job => job.name)
        .filter(name => typeof name === 'string' && name.length > 0);

    return {
        failedJobs,
        url: typeof parsed.url === 'string' ? parsed.url : '',
    };
}

async function waitForRelease(tag) {
    const deadline = Date.now() + readWaitTimeoutMs();
    let announcedUrl = '';

    while (Date.now() < deadline) {
        const runInfo = findReleaseRun(tag);
        if (!runInfo) {
            await sleep(POLL_INTERVAL_MS);
            continue;
        }

        if (runInfo.url && runInfo.url !== announcedUrl) {
            process.stdout.write(`Waiting for ${tag} release workflow: ${runInfo.url}\n`);
            announcedUrl = runInfo.url;
        }

        if (runInfo.status !== 'completed') {
            await sleep(POLL_INTERVAL_MS);
            continue;
        }

        if (runInfo.conclusion === 'success') {
            process.stdout.write(`Release workflow succeeded for ${tag}: ${runInfo.url}\n`);
            return;
        }

        const failureSummary = readFailedJobSummary(runInfo.databaseId);
        const failedJobsText = failureSummary.failedJobs.length > 0
            ? ` Failed jobs: ${failureSummary.failedJobs.join(', ')}.`
            : '';
        throw new Error(
            `Release workflow failed for ${tag}.${failedJobsText} `
            + `Inspect: ${failureSummary.url || runInfo.url}`,
        );
    }

    throw new Error(
        `Timed out while waiting for release workflow ${tag}. `
        + 'Set EVB_RELEASE_WAIT_TIMEOUT_MS to a larger value if needed.',
    );
}

async function main() {
    const tag = readTag();
    await waitForRelease(tag);
}

main().catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exit(1);
});
