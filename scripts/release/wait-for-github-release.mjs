import {
    errorMessage,
    run,
    sleep,
} from './shared.mjs';
import {
    briefErrorMessage,
    findWorkflowRun,
    isTransientGitHubCliError,
} from './github-workflow-run.mjs';
import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;
const POLL_INTERVAL_MS = 10 * 1000;

/** @typedef {{databaseId?: number, status?: string, conclusion?: string | null, url: string}} IReleaseWorkflowRun */
/** @typedef {{conclusion?: string, name?: string}} IReleaseJob */
/** @typedef {{failedJobs: string[], url: string}} IFailureSummary */
/** @typedef {{createdAfter?: string, findReleaseRunFn?: (tag: string, targetSha: string, createdAfter: string) => IReleaseWorkflowRun | null, nowFn?: () => number, readFailedJobSummaryFn?: (runId: number) => IFailureSummary, readWaitTimeoutMsFn?: () => number, sleepFn?: (milliseconds: number) => Promise<unknown>, stderr?: {write: (chunk: string) => unknown}, stdout?: {write: (chunk: string) => unknown}, targetSha?: string}} IWaitForReleaseOptions */

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

export { isTransientGitHubCliError };

/** @param {string} tag @param {string} [targetSha] @param {string} [createdAfter] @returns {IReleaseWorkflowRun | null} */
function findReleaseRun(tag, targetSha = '', createdAfter = '') {
    const targetTitles = new Set([
        `Release ${tag}`,
        `Release (${tag})`,
    ]);

    return findWorkflowRun({
        createdAfter,
        displayTitles: Array.from(targetTitles),
        targetSha,
        workflow: 'Release',
    });
}

/** @param {number} runId @returns {IFailureSummary} */
function readFailedJobSummary(runId) {
    const payload = run('gh', [
        'run',
        'view',
        String(runId),
        '--json',
        'jobs,url',
    ]);
    /** @type {{jobs?: IReleaseJob[], url?: unknown}} */
    const parsed = JSON.parse(payload);
    const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];

    const failedJobs = jobs
        .filter(job => job?.conclusion === 'failure')
        .flatMap(job => typeof job.name === 'string' && job.name.length > 0 ? [job.name] : []);

    return {
        failedJobs,
        url: typeof parsed.url === 'string' ? parsed.url : '',
    };
}

/** @param {{error: unknown, stderr: {write: (chunk: string) => unknown}, tag: string, transientPollFailures: number}} options */
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

/** @param {string} tag @param {IWaitForReleaseOptions} [options] @returns {Promise<void>} */
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

        if (runInfo.databaseId === undefined) {
            throw new Error(`Release workflow ${tag} did not report a database ID.`);
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
