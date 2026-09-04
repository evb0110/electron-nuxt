import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    buildStressCalibrationRecord,
    calibrationBlocksStressRun,
    evaluateCgroupConstraint,
    evaluateStressCalibration,
    parseCgroupLimits,
    readOwnCgroupConstraint,
} from '@scripts/stress/stressCalibration';
import { STRESS_HOST_PROFILES } from '@scripts/stress/stressHostProfiles';
import type {
    IStressCalibrationProbe,
    IStressCalibrationRecord,
    IStressHostProfile,
} from '@scripts/stress/stressTypes';

function probe(overrides: Partial<IStressCalibrationProbe> = {}): IStressCalibrationProbe {
    return {
        mainThreadLoopMs: 100,
        workerLoopMs: 100,
        rafP50Ms: 16,
        rafP95Ms: 20,
        jsHeapSizeLimitBytes: 4 * 1024 * 1024 * 1024,
        diskRead64MiBMs: 50,
        detectedTier: null,
        ...overrides,
    };
}

function verdictOf(profile: IStressHostProfile, unthrottled: IStressCalibrationProbe | null, throttled: IStressCalibrationProbe, check: string) {
    return evaluateStressCalibration(profile, unthrottled, throttled).find(item => item.check === check)?.verdict ?? null;
}

describe('stress calibration verdicts', () => {
    const slow = STRESS_HOST_PROFILES['slow-a'];

    it('reports met when the throttled loop lands inside the expected slowdown band', () => {
        expect(verdictOf(slow, probe(), probe({mainThreadLoopMs: 400}), 'renderer-slowdown')).toBe('met');
    });

    it('reports constraint-not-effective when throttling did not slow the renderer', () => {
        expect(verdictOf(slow, probe(), probe({mainThreadLoopMs: 110}), 'renderer-slowdown')).toBe('constraint-not-effective');
    });

    it('reports constraint-excessive when the host is far slower than the profile expects', () => {
        expect(verdictOf(slow, probe(), probe({mainThreadLoopMs: 900}), 'renderer-slowdown')).toBe('constraint-excessive');
    });

    it('cannot verify the slowdown without an unthrottled probe', () => {
        expect(verdictOf(slow, null, probe({mainThreadLoopMs: 400}), 'renderer-slowdown')).toBe('unverifiable');
    });

    it('flags a worker that slowed down with the main thread', () => {
        expect(verdictOf(slow, probe(), probe({
            mainThreadLoopMs: 400,
            workerLoopMs: 380,
        }), 'worker-unthrottled')).toBe('constraint-excessive');
        expect(verdictOf(slow, probe(), probe({
            mainThreadLoopMs: 400,
            workerLoopMs: 110,
        }), 'worker-unthrottled')).toBe('met');
    });

    it('checks the V8 heap cap only for profiles that declare one', () => {
        expect(verdictOf(slow, probe(), probe({
            mainThreadLoopMs: 400,
            jsHeapSizeLimitBytes: 1024 * 1024 * 1024,
        }), 'js-heap-limit')).toBe('met');
        expect(verdictOf(slow, probe(), probe({mainThreadLoopMs: 400}), 'js-heap-limit')).toBe('constraint-not-effective');
        expect(verdictOf(slow, probe(), probe({
            mainThreadLoopMs: 400,
            jsHeapSizeLimitBytes: null,
        }), 'js-heap-limit')).toBe('unverifiable');
        expect(verdictOf(STRESS_HOST_PROFILES.baseline, probe(), probe(), 'js-heap-limit')).toBeNull();
    });

    it('produces no renderer checks for the unthrottled baseline', () => {
        expect(evaluateStressCalibration(STRESS_HOST_PROFILES.baseline, probe(), probe())).toEqual([]);
    });
});

describe('stress calibration host constraint', () => {
    const hint = {
        platform: 'linux' as const,
        commandPrefix: [],
        description: '',
        expectedCpus: 1,
        expectedMemoryBytes: 3 * 1024 * 1024 * 1024,
    };

    it('cannot verify a cgroup wrapper outside linux', () => {
        const result = readOwnCgroupConstraint('darwin', hint);
        expect(result.verified).toBe(false);
        expect(result.detail).toContain('linux');
    });

    it('parses cgroup v2 cpu.max and memory.max including the unlimited marker', () => {
        expect(parseCgroupLimits('100000 100000', '3221225472')).toEqual({
            cpus: 1,
            memoryBytes: 3221225472,
        });
        expect(parseCgroupLimits('50000 100000', 'max')).toEqual({
            cpus: 0.5,
            memoryBytes: null,
        });
        expect(parseCgroupLimits('max 100000', 'garbage')).toEqual({
            cpus: null,
            memoryBytes: null,
        });
    });

    it('verifies only limits that match what the profile declared', () => {
        expect(evaluateCgroupConstraint({
            cpus: 1,
            memoryBytes: 3 * 1024 * 1024 * 1024,
        }, hint).verified).toBe(true);
        const unlimited = evaluateCgroupConstraint({
            cpus: null,
            memoryBytes: null,
        }, hint);
        expect(unlimited.verified).toBe(false);
        expect(unlimited.detail).toContain('cpu.max is unlimited');
        expect(unlimited.detail).toContain('memory.max is unlimited');
        const wrongCpu = evaluateCgroupConstraint({
            cpus: 4,
            memoryBytes: 3 * 1024 * 1024 * 1024,
        }, hint);
        expect(wrongCpu.verified).toBe(false);
        expect(wrongCpu.detail).toContain('profile expects 1');
    });

    it('declares the cpu and memory ceilings the slow-b wrapper must impose', () => {
        const slowB = STRESS_HOST_PROFILES['slow-b'];
        expect(slowB.hostConstraint?.expectedCpus).toBe(1);
        expect(slowB.hostConstraint?.expectedMemoryBytes).toBe(3 * 1024 * 1024 * 1024);
        expect(slowB.hostConstraint?.commandPrefix).toContain('CPUQuota=100%');
        expect(slowB.hostConstraint?.commandPrefix).toContain('MemoryMax=3G');
    });

    it('adds a host-wrapper finding when a profile expects a wrapper the host cannot confirm', () => {
        const wrapped = Object.values(STRESS_HOST_PROFILES).find(profile => profile.hostConstraint !== null);
        expect(wrapped).toBeDefined();
        if (!wrapped) {
            return;
        }
        const record = buildStressCalibrationRecord(wrapped, probe(), probe({mainThreadLoopMs: 100 * wrapped.cpuThrottlingRate}), 'darwin');
        expect(record.hostConstraint.verified).toBe(false);
        expect(record.checks.some(check => check.check === 'host-wrapper' && check.verdict === 'constraint-not-effective')).toBe(true);
    });

    it('treats profiles without a wrapper as verified', () => {
        const record = buildStressCalibrationRecord(STRESS_HOST_PROFILES.baseline, probe(), probe(), 'darwin');
        expect(record.hostConstraint.verified).toBe(true);
        expect(record.profileId).toBe('baseline');
    });
});

describe('calibrationBlocksStressRun', () => {
    function record(checks: IStressCalibrationRecord['checks']): IStressCalibrationRecord {
        return {
            profileId: 'slow-a',
            unthrottled: probe(),
            throttled: probe(),
            checks,
            hostConstraint: {
                verified: true,
                detail: 'none',
            },
        };
    }

    it('blocks when the probe crashed or a floor was missed, and only warns on unverifiable checks', () => {
        expect(calibrationBlocksStressRun(null)).toMatch(/did not complete/u);
        expect(calibrationBlocksStressRun(record([]))).toBeNull();
        expect(calibrationBlocksStressRun(record([
            {
                check: 'worker-unthrottled',
                verdict: 'unverifiable',
                detail: 'no worker probe',
            },
            {
                check: 'renderer-slowdown',
                verdict: 'met',
                detail: 'ratio 4.0',
            },
        ]))).toBeNull();
        expect(calibrationBlocksStressRun(record([{
            check: 'renderer-slowdown',
            verdict: 'constraint-not-effective',
            detail: 'ratio 1.1',
        }]))).toContain('renderer-slowdown: constraint-not-effective');
        expect(calibrationBlocksStressRun(record([{
            check: 'renderer-slowdown',
            verdict: 'constraint-excessive',
            detail: 'ratio 9',
        }]))).toContain('constraint-excessive');
    });
});
