import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    defaultCommandRunner,
    EXACT_SHA_CI_COMPLETION_TIMEOUT_MS,
    waitForExactShaCiGates,
} from '@scripts/release/wait-for-exact-sha-ci.mjs';

const TARGET_SHA = 'a'.repeat(40);
const RUN_URL = 'https://github.com/evb0110/evb-viewer/actions/runs/424242';
// The stale budget that failed release run 32691744074 three seconds before
// its gates_ok completed (issue #109). The regression scenario below crosses
// it deliberately.
const OLD_STALE_BUDGET_MS = 45 * 60_000;

interface IScriptedMinute {
    status: 'in_progress' | 'completed' | 'absent';
    conclusion?: string;
    gatesOk?: string;
}

// Deterministic virtual-clock harness: each poll advances the clock by the
// poll interval; the scripted timeline decides what the CI API reports at
// each minute. No real sleeping, no network.
function createHarness(timeline: (elapsedMs: number) => IScriptedMinute) {
    let now = 0;
    const pollTimes: number[] = [];
    const nowFn = () => now;
    const sleepFn = async (ms?: number) => {
        now += ms ?? 0;
    };
    const runCommand = (_command: string, args: string[]) => {
        const spec = args.join(' ');
        const frame = timeline(now);
        if (spec.includes('/runs?head_sha=')) {
            pollTimes.push(now);
            if (frame.status === 'absent') {
                return JSON.stringify({workflow_runs: []});
            }
            return JSON.stringify({workflow_runs: [{
                conclusion: frame.status === 'completed' ? frame.conclusion ?? 'success' : null,
                head_branch: 'main',
                head_sha: TARGET_SHA,
                html_url: RUN_URL,
                id: 424242,
                run_number: 7,
                status: frame.status,
            }]});
        }
        if (spec.includes('/jobs?per_page=100')) {
            return frame.gatesOk ?? '';
        }
        throw new Error(`Unexpected command in harness: ${spec}`);
    };
    return {
        nowFn,
        pollTimes,
        runCommand,
        sleepFn,
        stderr: {write: () => true},
    };
}

describe('waitForExactShaCiGates', () => {
    it('waits past the old stale budget for a run that finishes late and green', async () => {
        // Regression pin for issue #109: the run stays in progress beyond the
        // old 45-minute cutoff and turns green afterwards. The old inline
        // loop failed here; the wait must succeed as long as the run finishes
        // inside the policy budget.
        const lateSuccessAtMs = OLD_STALE_BUDGET_MS + 60_000;
        expect(EXACT_SHA_CI_COMPLETION_TIMEOUT_MS).toBeGreaterThan(lateSuccessAtMs);
        const harness = createHarness(elapsedMs => (elapsedMs < lateSuccessAtMs
            ? {status: 'in_progress'}
            : {
                conclusion: 'success',
                gatesOk: 'success',
                status: 'completed',
            }));

        await expect(waitForExactShaCiGates(TARGET_SHA, harness)).resolves.toEqual({
            id: 424242,
            url: RUN_URL,
        });
        expect(Math.max(...harness.pollTimes)).toBeGreaterThanOrEqual(lateSuccessAtMs);
    });

    it('fails promptly with the actual conclusion when the run turns terminal red', async () => {
        const harness = createHarness(elapsedMs => (elapsedMs < 5 * 60_000
            ? {status: 'in_progress'}
            : {
                conclusion: 'failure',
                status: 'completed',
            }));

        await expect(waitForExactShaCiGates(TARGET_SHA, harness))
            .rejects.toThrow(/run 424242 .*concluded 'failure'/u);
        // Prompt: the wait ended at the failing poll, not at any deadline.
        expect(Math.max(...harness.pollTimes)).toBeLessThan(7 * 60_000);
    });

    it('reports a missing run distinctly after the appearance budget', async () => {
        const harness = createHarness(() => ({status: 'absent'}));

        await expect(waitForExactShaCiGates(TARGET_SHA, harness))
            .rejects.toThrow(`No push CI run appeared for exact target ${TARGET_SHA} within 10 minutes.`);
    });

    it('reports a known run that exceeded the deadline, polling at the boundary', async () => {
        const harness = createHarness(() => ({status: 'in_progress'}));

        await expect(waitForExactShaCiGates(TARGET_SHA, harness))
            .rejects.toThrow(/run 424242 .*did not reach a terminal state within 75 minutes/u);
        // The final decision must follow a poll at or beyond the deadline, so
        // a run turning terminal at the boundary is still observed.
        expect(Math.max(...harness.pollTimes)).toBeGreaterThanOrEqual(EXACT_SHA_CI_COMPLETION_TIMEOUT_MS);
    });

    it('reports a successful run whose gates_ok aggregate is not green', async () => {
        const harness = createHarness(() => ({
            conclusion: 'success',
            gatesOk: 'failure',
            status: 'completed',
        }));

        await expect(waitForExactShaCiGates(TARGET_SHA, harness))
            .rejects.toThrow(/did not contain a successful gates_ok aggregate \(saw 'failure'\)/u);
    });

    it('keeps waiting through transient CI lookup failures', async () => {
        let calls = 0;
        const base = createHarness(elapsedMs => (elapsedMs < 2 * 60_000
            ? {status: 'in_progress'}
            : {
                conclusion: 'success',
                gatesOk: 'success',
                status: 'completed',
            }));
        const flakyRunCommand = (command: string, args: string[]) => {
            calls += 1;
            if (calls === 1) {
                throw new Error('api unavailable');
            }
            return base.runCommand(command, args);
        };

        await expect(waitForExactShaCiGates(TARGET_SHA, {
            ...base,
            runCommand: flakyRunCommand,
        })).resolves.toMatchObject({id: 424242});
    });

    it('binds the default command runner to the same (command, args) contract as the harness', () => {
        // Regression pin: the production adapter once took only (args) while
        // every call site passed (command, args), so real runs executed the
        // literal string 'gh' as the argument list while mocked harnesses
        // stayed green.
        expect(defaultCommandRunner('node', [
            '-e',
            'process.stdout.write("runner-contract-ok")',
        ])).toBe('runner-contract-ok');
    });
});
