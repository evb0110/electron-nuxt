import {
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { runStress } from '@scripts/stress/runStress';
import type * as TStressAppState from '@scripts/stress/stressAppState';
import type * as TStressCalibration from '@scripts/stress/stressCalibration';
import type * as TStressFixtures from '@scripts/stress/stressFixtures';
import type * as TStressOracles from '@scripts/stress/stressOracles';
import type * as TStressReport from '@scripts/stress/stressReport';
import {
    DEFAULT_STRESS_RUN_BUDGET,
    STRESS_SCENARIOS,
} from '@scripts/stress/stressScenarioRegistry';
import type {
    IStressBaseline,
    IStressCalibrationRecord,
    IStressMetricsSummary,
    IStressRun,
    TStressScenario,
} from '@scripts/stress/stressTypes';

const mocks = vi.hoisted(() => ({
    ensureStressFixtures: vi.fn(),
    startStressSession: vi.fn(),
    startE2ESharedRenderer: vi.fn(),
    stopRenderer: vi.fn(async () => undefined),
    probeStressCalibration: vi.fn(),
    buildStressCalibrationRecord: vi.fn(),
    startStressMetricsSampler: vi.fn(),
    runStressDeterministicSteps: vi.fn(),
    collectStressAppState: vi.fn(async () => null),
    collectMacOSCrashReports: vi.fn(async () => []),
    listLeakedPdfWorkDirs: vi.fn(async () => []),
    runQpdfIntegrityCheck: vi.fn(),
    runStressOperatorScenario: vi.fn(),
    runExternalStressOperator: vi.fn(),
    stressBaselinePath: vi.fn(),
}));

vi.mock('@scripts/stress/stressFixtures', async importOriginal => ({
    ...await importOriginal<typeof TStressFixtures>(),
    ensureStressFixtures: mocks.ensureStressFixtures,
}));
vi.mock('@scripts/stress/stressSessionLifecycle', () => ({startStressSession: mocks.startStressSession}));
vi.mock('@scripts/electron-run/electronRunE2ESharedRenderer', () => ({startE2ESharedRenderer: mocks.startE2ESharedRenderer}));
vi.mock('@scripts/stress/stressCalibration', async importOriginal => ({
    ...await importOriginal<typeof TStressCalibration>(),
    probeStressCalibration: mocks.probeStressCalibration,
    buildStressCalibrationRecord: mocks.buildStressCalibrationRecord,
}));
vi.mock('@scripts/stress/stressMetricsSampler', () => ({startStressMetricsSampler: mocks.startStressMetricsSampler}));
vi.mock('@scripts/stress/stressDeterministicDriver', () => ({runStressDeterministicSteps: mocks.runStressDeterministicSteps}));
vi.mock('@scripts/stress/stressAppState', async importOriginal => ({
    ...await importOriginal<typeof TStressAppState>(),
    collectStressAppState: mocks.collectStressAppState,
}));
vi.mock('@scripts/stress/stressOracles', async importOriginal => ({
    ...await importOriginal<typeof TStressOracles>(),
    collectMacOSCrashReports: mocks.collectMacOSCrashReports,
    listLeakedPdfWorkDirs: mocks.listLeakedPdfWorkDirs,
    runQpdfIntegrityCheck: mocks.runQpdfIntegrityCheck,
}));
vi.mock('@scripts/stress/runExternalStressOperator', () => ({runExternalStressOperator: mocks.runExternalStressOperator}));
vi.mock('@scripts/stress/runStressOperatorScenario', () => ({runStressOperatorScenario: mocks.runStressOperatorScenario}));
vi.mock('@scripts/stress/stressReport', async importOriginal => ({
    ...await importOriginal<typeof TStressReport>(),
    stressBaselinePath: mocks.stressBaselinePath,
}));

const WORKING_COPY_SCENARIO = 'annotate-save-loop';
function requireOperatorScenario(): TStressScenario {
    const found = STRESS_SCENARIOS.find(candidate => candidate.kind === 'operator');
    if (!found) {
        throw new Error('registry has no operator scenario');
    }
    return found;
}

const operatorScenario = requireOperatorScenario();

function metricsSummary(): IStressMetricsSummary {
    return {
        sampleCount: 4,
        durationMs: 1_000,
        peakRssBytes: 100 * 1024 * 1024,
        peakRssPid: null,
        peakJsHeapUsedBytes: 10 * 1024 * 1024,
        firstJsHeapUsedBytes: 8 * 1024 * 1024,
        lastJsHeapUsedBytes: 9 * 1024 * 1024,
        heartbeatMaxGapMs: 20,
        workerHeartbeatMaxGapMs: 20,
        longTaskCount: 0,
        longTaskP95Ms: 0,
        longTaskMaxMs: 0,
        frameGapP95Ms: 16,
        frameGapMaxMs: 20,
        droppedFrameRatio: 0,
        consoleErrors: [],
        pageErrors: [],
        rendererCrashed: false,
        crashReason: null,
    };
}

function calibrationRecord(): IStressCalibrationRecord {
    const probe = {
        mainThreadLoopMs: 10,
        workerLoopMs: 10,
        rafP50Ms: 16,
        rafP95Ms: 17,
        jsHeapSizeLimitBytes: 4 * 1024 * 1024 * 1024,
        diskRead64MiBMs: 100,
        detectedTier: null,
    };
    return {
        profileId: 'baseline',
        unthrottled: probe,
        throttled: probe,
        checks: [],
        hostConstraint: {
            verified: true,
            detail: 'test',
        },
    };
}

function createHandle() {
    return {
        session: {page: {}},
        profile: {cpuThrottlingRate: 1},
        applied: {cdpSession: {send: vi.fn(async () => ({}))}},
        electronPid: null,
        userDataDir: '/sessions/test',
        startedAtEpochMs: Date.now(),
        stop: vi.fn(async () => ({leakedPids: []})),
    };
}

let workDir = '';
let runDir = '';
let baselinePath = '';
let signalListenerCounts: Record<'SIGINT' | 'SIGTERM', number> = {
    SIGINT: 0,
    SIGTERM: 0,
};

async function readRun() {
    return JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as IStressRun;
}

describe('runStress main', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        signalListenerCounts = {
            SIGINT: process.listenerCount('SIGINT'),
            SIGTERM: process.listenerCount('SIGTERM'),
        };
        workDir = await mkdtemp(join(tmpdir(), 'stress-run-'));
        runDir = join(workDir, 'run');
        baselinePath = join(workDir, 'baseline.json');
        const fixturePath = join(workDir, 'fixture.pdf');
        await writeFile(fixturePath, '%PDF-1.4\n', 'utf8');
        mocks.ensureStressFixtures.mockImplementation(async (ids: string[]) => new Map(ids.map(id => [
            id,
            {
                id,
                path: fixturePath,
                bytes: 9,
                specHash: 'h',
                generatedAt: '2026-09-04T00:00:00.000Z',
                available: true,
                reason: null,
            },
        ])));
        mocks.startStressSession.mockImplementation(async () => createHandle());
        mocks.startE2ESharedRenderer.mockResolvedValue({
            sessionName: 'e2e-unit-shared-renderer',
            port: 43210,
            stop: mocks.stopRenderer,
        });
        mocks.probeStressCalibration.mockResolvedValue(calibrationRecord().throttled);
        mocks.buildStressCalibrationRecord.mockReturnValue(calibrationRecord());
        mocks.startStressMetricsSampler.mockResolvedValue({
            sample: vi.fn(),
            counters: () => ({
                consoleErrorCount: 0,
                pageErrorCount: 0,
                rendererCrashed: false,
            }),
            lastSample: () => null,
            stop: vi.fn(async () => metricsSummary()),
        });
        mocks.runStressDeterministicSteps.mockResolvedValue([]);
        mocks.runQpdfIntegrityCheck.mockImplementation(async (path: string) => ({
            path,
            status: 'skipped',
            detail: 'qpdf not installed in the unit test',
        }));
        mocks.runStressOperatorScenario.mockResolvedValue({
            turns: 2,
            actions: 2,
            costUsd: 0.05,
            report: {
                outcome: 'completed',
                stepsDone: ['done'],
                problem: null,
                slowestAction: null,
                finalPage: 1,
            },
            stopReason: 'report: completed',
            frozenScreenshotStreak: 0,
            actionRecords: [],
            artifacts: {},
        });
        mocks.runExternalStressOperator.mockImplementation(mocks.runStressOperatorScenario);
        mocks.collectStressAppState.mockReset().mockResolvedValue(null);
        mocks.stressBaselinePath.mockReturnValue(baselinePath);
    });

    afterEach(async () => {
        for (const signal of [
            'SIGINT',
            'SIGTERM',
        ] as const) {
            const listeners = process.listeners(signal);
            for (const listener of listeners.slice(signalListenerCounts[signal])) {
                process.off(signal, listener);
            }
        }
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        await rm(workDir, {
            recursive: true,
            force: true,
        });
    });

    it('prints usage and the scenario list without touching fixtures', async () => {
        expect(await runStress(['--help'])).toBe(0);
        expect(await runStress(['--list'])).toBe(0);
        expect(mocks.ensureStressFixtures).not.toHaveBeenCalled();
        const printed = vi.mocked(console.log).mock.calls.map(([line]) => String(line)).join('\n');
        expect(printed).toContain('--update-baseline');
        expect(printed).toContain(WORKING_COPY_SCENARIO);
    });

    it('generates fixtures only and reports whether every fixture is available', async () => {
        expect(await runStress(['--fixtures-only'])).toBe(0);
        mocks.ensureStressFixtures.mockResolvedValueOnce(new Map([[
            'text-small-12',
            {
                id: 'text-small-12',
                path: '',
                bytes: 0,
                specHash: 'h',
                generatedAt: '',
                available: false,
                reason: 'generator failed',
            },
        ]]));
        expect(await runStress(['--fixtures-only'])).toBe(1);
        expect(mocks.startStressSession).not.toHaveBeenCalled();
    });

    it('resolves a dry run plan without launching Electron', async () => {
        const code = await runStress([
            '--dry-run',
            '--scenario',
            `${WORKING_COPY_SCENARIO},${operatorScenario.id}`,
            '--out',
            runDir,
        ]);
        expect(code).toBe(0);
        expect(mocks.startStressSession).not.toHaveBeenCalled();
        expect(await readFile(join(runDir, 'run.log'), 'utf8')).toContain('dry run: plan resolved');
    });

    it('rejects an empty selection and operator runs that cannot work', async () => {
        await expect(runStress([
            '--tag',
            'no-such-tag',
        ])).rejects.toThrow('no scenarios matched');
        await expect(runStress([
            '--scenario',
            operatorScenario.id,
            '--operator',
            'pixel',
            '--model',
            'claude-haiku-4-5-20251001',
        ])).rejects.toThrow('no computer-use support');
        vi.stubEnv('ANTHROPIC_API_KEY', '');
        await expect(runStress([
            '--scenario',
            operatorScenario.id,
            '--operator',
            'pixel',
        ])).rejects.toThrow('ANTHROPIC_API_KEY is not set');
    });

    it('runs a deterministic scenario end to end and writes the run artifacts', async () => {
        const code = await runStress([
            '--scenario',
            WORKING_COPY_SCENARIO,
            '--out',
            runDir,
            '--update-baseline',
        ]);

        expect(code).toBe(0);
        expect(process.listenerCount('SIGINT')).toBe(signalListenerCounts.SIGINT);
        expect(process.listenerCount('SIGTERM')).toBe(signalListenerCounts.SIGTERM);
        const run = await readRun();
        expect(run.verdict).toBe('passed');
        expect(run.calibration?.profileId).toBe('baseline');
        expect(run.scenarios.map(scenario => [
            scenario.id,
            scenario.status,
        ])).toEqual([[
            WORKING_COPY_SCENARIO,
            'passed',
        ]]);
        expect(run.scenarios[0]?.findings.some(finding => finding.oracle === 'saved-file-integrity-skipped')).toBe(true);
        expect(mocks.runQpdfIntegrityCheck).toHaveBeenCalledWith(join(runDir, WORKING_COPY_SCENARIO, 'working', 'fixture.pdf'));
        expect(mocks.startStressSession).toHaveBeenCalledTimes(2);
        await expect(stat(join(runDir, 'summary.md'))).resolves.toBeTruthy();
        await expect(stat(join(runDir, WORKING_COPY_SCENARIO, 'manifest.json'))).resolves.toBeTruthy();
        await expect(stat(join(runDir, WORKING_COPY_SCENARIO, 'result.json'))).resolves.toBeTruthy();
        const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as IStressBaseline;
        expect(Object.keys(baseline.scenarios)).toEqual([WORKING_COPY_SCENARIO]);
    });

    it('runs an API operator scenario through the driver and records its report', async () => {
        vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
        const code = await runStress([
            '--operator',
            'pixel',
            '--scenario',
            operatorScenario.id,
            '--out',
            runDir,
        ]);

        expect(code).toBe(0);
        expect(mocks.runStressOperatorScenario).toHaveBeenCalledTimes(1);
        const run = await readRun();
        expect(run.scenarios[0]?.operator?.report?.outcome).toBe('completed');
        expect(run.totals.costUsd).toBeCloseTo(0.05);
    });

    it.each([
        'completed',
        'blocked',
        'missing',
    ] as const)('runs the default external operator without a key and fails closed for %s', async outcome => {
        vi.stubEnv('ANTHROPIC_API_KEY', '');
        mocks.runExternalStressOperator.mockResolvedValue({
            turns: 0,
            actions: 0,
            costUsd: null,
            report: outcome === 'missing' ? null : {
                outcome,
                stepsDone: ['opened file'],
                problem: outcome === 'blocked' ? 'cannot operate' : null,
                slowestAction: null,
                finalPage: 1,
            },
            stopReason: outcome === 'missing' ? 'external operator deadline exceeded' : `report: ${outcome}`,
            frozenScreenshotStreak: 0,
            actionRecords: [],
            artifacts: {},
        });
        expect(await runStress([
            '--scenario',
            operatorScenario.id,
            '--out',
            runDir,
        ])).toBe(outcome === 'completed' ? 0 : 1);
        expect(mocks.runStressOperatorScenario).not.toHaveBeenCalled();
        expect(mocks.startStressSession).toHaveBeenLastCalledWith(operatorScenario.id, expect.anything(), expect.any(Function), true);
        const run = await readRun();
        expect(run.scenarios[0]?.status).toBe(outcome === 'completed' ? 'passed' : 'infra-failed');
        expect(run.scenarios[0]?.operator?.model).toBe('external-agent');
    });

    it('classifies a renderer crash as an app failure even when the external operator cannot report', async () => {
        vi.stubEnv('ANTHROPIC_API_KEY', '');
        const sampler = await mocks.startStressMetricsSampler();
        sampler.stop.mockResolvedValue({
            ...metricsSummary(),
            rendererCrashed: true,
            crashReason: 'crashed',
        });
        mocks.runExternalStressOperator.mockResolvedValue({
            turns: 0,
            actions: 0,
            costUsd: null,
            report: null,
            stopReason: 'renderer crashed',
            frozenScreenshotStreak: 0,
            actionRecords: [],
            artifacts: {},
        });
        expect(await runStress([
            '--scenario',
            operatorScenario.id,
            '--out',
            runDir,
        ])).toBe(1);
        const result = (await readRun()).scenarios[0];
        expect(result?.status).toBe('failed');
        expect(result?.infraError).toBeNull();
        expect(result?.findings.some(finding => finding.oracle === 'renderer-crash')).toBe(true);
    });

    it('caps an external scenario to the whole-run time remaining after calibration', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const startedAt = Date.now();
        const stop = vi.fn(async () => ({ leakedPids: [] }));
        mocks.startStressSession.mockImplementation(async () => {
            vi.setSystemTime(startedAt + DEFAULT_STRESS_RUN_BUDGET.deadlineMs - 100);
            return {
                ...createHandle(),
                stop,
            };
        });
        mocks.runExternalStressOperator.mockImplementation(() => new Promise<never>(() => {}));
        expect(await runStress([
            '--scenario',
            operatorScenario.id,
            '--out',
            runDir,
        ])).toBe(1);
        expect(mocks.runExternalStressOperator).toHaveBeenCalledWith(expect.objectContaining({
            deadlineAt: startedAt + DEFAULT_STRESS_RUN_BUDGET.deadlineMs,
            budgets: expect.objectContaining({ deadlineMs: 100 }),
        }));
        expect(stop).toHaveBeenCalledTimes(2);
        expect((await readRun()).scenarios[0]?.infraError).toContain('timed out');
    });

    it('still closes the session when the final renderer state read hangs', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const startedAt = Date.now();
        const stop = vi.fn(async () => ({ leakedPids: [] }));
        mocks.startStressSession.mockImplementation(async () => {
            vi.setSystemTime(startedAt + DEFAULT_STRESS_RUN_BUDGET.deadlineMs - 20);
            return {
                ...createHandle(),
                stop,
            };
        });
        mocks.collectStressAppState.mockImplementationOnce(() => new Promise<never>(() => {}));
        await runStress([
            '--scenario',
            operatorScenario.id,
            '--out',
            runDir,
        ]);
        expect(mocks.collectStressAppState).toHaveBeenCalledOnce();
        expect(stop).toHaveBeenCalledTimes(2);
        expect((await readRun()).scenarios).toHaveLength(1);
    });

    it('stops before scenarios when calibration cannot complete', async () => {
        mocks.startStressSession.mockRejectedValueOnce(new Error('electron did not start'));
        const code = await runStress([
            '--scenario',
            WORKING_COPY_SCENARIO,
            '--out',
            runDir,
        ]);

        expect(code).toBe(1);
        const run = await readRun();
        expect(run.verdict).toBe('failed');
        expect(run.scenarios).toEqual([]);
        expect(mocks.runStressDeterministicSteps).not.toHaveBeenCalled();
        expect(mocks.startE2ESharedRenderer).toHaveBeenCalledOnce();
        expect(mocks.stopRenderer).toHaveBeenCalledOnce();
    });

    it('exits 0 after a calibrate-only run and refuses to update the baseline after an infra failure', async () => {
        expect(await runStress([
            '--calibrate-only',
            '--out',
            runDir,
        ])).toBe(0);
        expect((await readRun()).verdict).toBe('passed');

        mocks.runStressDeterministicSteps.mockRejectedValueOnce(new Error('driver crashed'));
        const failedRunDir = join(workDir, 'failed-run');
        const code = await runStress([
            '--scenario',
            WORKING_COPY_SCENARIO,
            '--out',
            failedRunDir,
            '--update-baseline',
        ]);

        expect(code).toBe(1);
        const run = JSON.parse(await readFile(join(failedRunDir, 'run.json'), 'utf8')) as IStressRun;
        expect(run.scenarios[0]?.status).toBe('infra-failed');
        expect(run.scenarios[0]?.infraError).toContain('driver crashed');
        await expect(stat(baselinePath)).rejects.toThrow();
    });
});
