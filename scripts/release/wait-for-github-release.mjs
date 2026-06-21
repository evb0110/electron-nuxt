import {
    errorMessage,
    run,
    sleep,
} from './shared.mjs';
import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;
const POLL_INTERVAL_MS = 10 * 1000;
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

function readTag() {
    const tag = process.argv[2]?.trim();
    if (!tag) {
        throw new Error('Expected a release tag argument, for example `v1.2.3`');
    }

    return tag;
}

function readTargetSha() {
    return process.argv[3]?.trim() || '';
}

function readCreatedAfter() {
    return process.argv[4]?.trim() || '';
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

export function isTransientGitHubCliError(error) {
    const message = errorMessage(error);

    return TRANSIENT_GITHUB_CLI_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

function briefErrorMessage(error) {
    return errorMessage(error).split('\n')[0] ?? String(error);
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
        'createdAt,databaseId,displayTitle,headBranch,headSha,status,conclusion,url',
    ]);
    const parsed = JSON.parse(payload);
    if (!Array.isArray(parsed)) {
        throw new Error('Unexpected GitHub CLI response while listing release runs');
    }

    return parsed;
}

function isAtOrAfterCreatedAfter(runInfo, createdAfter) {
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

function findReleaseRun(tag, targetSha = '', createdAfter = '') {
    const targetTitles = new Set([
        `Release ${tag}`,
        `Release (${tag})`,
    ]);

    return listReleaseRuns().find(runInfo => {
        if (!runInfo || typeof runInfo !== 'object') {
            return false;
        }

        const matchesRelease = runInfo.headBranch === tag
            || targetTitles.has(runInfo.displayTitle);
        const matchesTarget = !targetSha
            || !runInfo.headSha
            || runInfo.headSha === targetSha;

        return matchesRelease
            && matchesTarget
            && isAtOrAfterCreatedAfter(runInfo, createdAfter);
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

function writeTransientPollingFailure({
    error,
    stderr,
    tag,
    transientPollFailures,
}) {
    stderr.write(
        `Transient GitHub polling failure while waiting for ${tag} `
        + `(attempt ${transientPollFailures}); retrying: ${briefErrorMessage(error)}\n`,
    );
}

export async function waitForRelease(tag, {
    createdAfter = '',
    findReleaseRunFn = findReleaseRun,
    nowFn = Date.now,
    readFailedJobSummaryFn = readFailedJobSummary,
    readWaitTimeoutMsFn = readWaitTimeoutMs,
    sleepFn = sleep,
    stderr = process.stderr,
    stdout = process.stdout,
    targetSha = '',
} = {}) {
    const deadline = nowFn() + readWaitTimeoutMsFn();
    let announcedUrl = '';
    let transientPollFailures = 0;

    while (nowFn() < deadline) {
        let runInfo;

        try {
            runInfo = findReleaseRunFn(tag, targetSha, createdAfter);
            transientPollFailures = 0;
        } catch (error) {
            if (!isTransientGitHubCliError(error)) {
                throw error;
            }

            // The release workflow keeps running when a single GitHub API poll hits
            // a network/TLS blip, so keep waiting instead of failing the release command.
            transientPollFailures += 1;
            writeTransientPollingFailure({
                error,
                stderr,
                tag,
                transientPollFailures,
            });
            await sleepFn(POLL_INTERVAL_MS);
            continue;
        }

        if (!runInfo) {
            await sleepFn(POLL_INTERVAL_MS);
            continue;
        }

        if (runInfo.url && runInfo.url !== announcedUrl) {
            stdout.write(`Waiting for ${tag} release workflow: ${runInfo.url}\n`);
            announcedUrl = runInfo.url;
        }

        if (runInfo.status !== 'completed') {
            await sleepFn(POLL_INTERVAL_MS);
            continue;
        }

        if (runInfo.conclusion === 'success') {
            stdout.write(`Release workflow succeeded for ${tag}: ${runInfo.url}\n`);
            return;
        }

        let failureSummary;

        try {
            failureSummary = readFailedJobSummaryFn(runInfo.databaseId);
        } catch (error) {
            if (!isTransientGitHubCliError(error)) {
                throw error;
            }

            transientPollFailures += 1;
            writeTransientPollingFailure({
                error,
                stderr,
                tag,
                transientPollFailures,
            });
            await sleepFn(POLL_INTERVAL_MS);
            continue;
        }

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
    await waitForRelease(tag, {
        createdAfter: readCreatedAfter(),
        targetSha: readTargetSha(),
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        process.stderr.write(`${errorMessage(error)}\n`);
        process.exit(1);
    });
}
