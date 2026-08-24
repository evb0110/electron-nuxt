// Waits for the exact-SHA push CI run of a release target to reach a
// successful terminal state with a green gates_ok aggregate.
//
// Dependency-free on purpose: the release workflow's prepare job runs this
// before any dependency install, from the trusted dispatch-ref checkout.
// Issue #109: the previous inline loop gave CI a fixed 45-minute budget that
// was calibrated to a ~33-minute CI and silently fell behind as blocking
// lanes grew, failing releases seconds before gates_ok completed and
// reporting real late CI failures as timeouts. The budgets here are policy:
// tests/unit/scripts/waitForExactShaCi.test.ts asserts the completion budget
// stays ahead of the blocking CI job timeouts declared in ci.yml.
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// A push CI run is created within seconds of the push that precedes the
// dispatch; ten minutes tolerates API lag without masking a missing run.
export const EXACT_SHA_CI_APPEARANCE_TIMEOUT_MS = 10 * 60_000;
// Must cover the slowest blocking CI job's declared timeout (currently 60
// minutes) plus runner queueing and the gates_ok aggregation tail.
export const EXACT_SHA_CI_COMPLETION_TIMEOUT_MS = 75 * 60_000;
export const EXACT_SHA_CI_POLL_INTERVAL_MS = 30_000;

// Exported for its own contract test: every caller in this module invokes
// the runner as (command, args), so the default adapter must too.
export function defaultCommandRunner(command, args) {
    return execFileSync(command, args, {
        encoding: 'utf8',
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    }).trim();
}

function findLatestMatchingRun(targetSha, runCommand) {
    const payload = runCommand('gh', [
        'api',
        '-H',
        'Accept: application/vnd.github+json',
        `repos/{owner}/{repo}/actions/workflows/ci.yml/runs?head_sha=${targetSha}&event=push&branch=main&per_page=20`,
    ]);
    const workflowRuns = JSON.parse(payload)?.workflow_runs;
    if (!Array.isArray(workflowRuns)) {
        return null;
    }
    return workflowRuns
        // ci.yml's push trigger is main-only, but require it explicitly so a
        // future trigger change cannot widen what a release trusts.
        .filter(runInfo => runInfo && runInfo.head_sha === targetSha && runInfo.head_branch === 'main')
        .sort((left, right) => (left.run_number ?? 0) - (right.run_number ?? 0))
        .at(-1) ?? null;
}

function readGatesOkConclusion(runId, runCommand) {
    return runCommand('gh', [
        'api',
        '--paginate',
        '-H',
        'Accept: application/vnd.github+json',
        `repos/{owner}/{repo}/actions/runs/${runId}/jobs?per_page=100`,
        '--jq',
        '.jobs[] | select(.name == "gates_ok") | .conclusion',
    ]).split('\n').filter(Boolean).at(-1);
}

function describeRun(runInfo) {
    return `run ${runInfo.id} (${runInfo.html_url ?? 'no url'})`;
}

/**
 * Resolves with {id, url} once the exact-SHA push CI run concludes
 * successfully with a green gates_ok. Throws distinct errors for: no run
 * appearing, a known run exceeding the completion deadline, a failed run
 * (with its actual conclusion, promptly), and a missing/failed gates_ok.
 * A poll always immediately precedes a deadline decision, so a run that
 * turns terminal at the boundary is still observed.
 */
export async function waitForExactShaCiGates(targetSha, {
    appearanceTimeoutMs = EXACT_SHA_CI_APPEARANCE_TIMEOUT_MS,
    completionTimeoutMs = EXACT_SHA_CI_COMPLETION_TIMEOUT_MS,
    pollIntervalMs = EXACT_SHA_CI_POLL_INTERVAL_MS,
    nowFn = Date.now,
    sleepFn = milliseconds => delay(milliseconds),
    runCommand = defaultCommandRunner,
    // Only .write is part of the contract; keep the option narrow so test
    // harnesses can satisfy it without impersonating process.stderr.
    stderr = {write: chunk => process.stderr.write(chunk)},
} = {}) {
    const startedAt = nowFn();
    let knownRun = null;

    while (true) {
        try {
            const latestRun = findLatestMatchingRun(targetSha, runCommand);
            if (latestRun) {
                knownRun = latestRun;
            }
        } catch (error) {
            // Transient API failures must not abort the wait; the deadlines
            // below keep the loop bounded and fail-closed.
            stderr.write(`Transient CI lookup failure for ${targetSha}; retrying: ${
                error instanceof Error ? error.message.split('\n')[0] : String(error)}\n`);
        }

        if (knownRun && knownRun.status === 'completed') {
            if (knownRun.conclusion !== 'success') {
                throw new Error(
                    `Exact-SHA CI ${describeRun(knownRun)} for ${targetSha} concluded '${knownRun.conclusion}'.`,
                );
            }
            let gatesConclusion;
            try {
                gatesConclusion = readGatesOkConclusion(knownRun.id, runCommand);
            } catch (error) {
                throw new Error(
                    `Exact-SHA CI ${describeRun(knownRun)} succeeded but the gates_ok lookup failed: ${
                        error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
                );
            }
            if (gatesConclusion !== 'success') {
                throw new Error(
                    `Exact-SHA CI ${describeRun(knownRun)} did not contain a successful gates_ok aggregate `
                    + `(saw '${gatesConclusion ?? 'no gates_ok job'}').`,
                );
            }
            return {
                id: knownRun.id,
                url: knownRun.html_url ?? '',
            };
        }

        const elapsedMs = nowFn() - startedAt;
        if (!knownRun && elapsedMs >= appearanceTimeoutMs) {
            throw new Error(
                `No push CI run appeared for exact target ${targetSha} within `
                + `${Math.round(appearanceTimeoutMs / 60_000)} minutes.`,
            );
        }
        if (knownRun && elapsedMs >= completionTimeoutMs) {
            throw new Error(
                `Exact-SHA CI ${describeRun(knownRun)} did not reach a terminal state within `
                + `${Math.round(completionTimeoutMs / 60_000)} minutes; the wait budget must stay `
                + 'ahead of the blocking CI job timeouts (see issue #109).',
            );
        }

        stderr.write(knownRun
            ? `Waiting for exact-SHA push CI ${describeRun(knownRun)} (status: ${knownRun.status}, `
                + `${Math.round(elapsedMs / 60_000)}m elapsed).\n`
            : `Waiting for a push CI run to appear for ${targetSha} (${Math.round(elapsedMs / 1_000)}s elapsed).\n`);
        await sleepFn(pollIntervalMs);
    }
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    const targetSha = process.argv[2];
    if (!/^[0-9a-f]{40}$/u.test(targetSha ?? '')) {
        process.stderr.write('Usage: wait-for-exact-sha-ci.mjs <40-char target sha>\n');
        process.exit(1);
    }
    waitForExactShaCiGates(targetSha)
        .then(({id}) => {
            process.stdout.write(`::notice::Release target ${targetSha} passed exact-SHA CI run ${id}.\n`);
        })
        .catch((error) => {
            process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
            process.exit(1);
        });
}
