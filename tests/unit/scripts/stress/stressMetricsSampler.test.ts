import {
    describe,
    expect,
    it,
} from 'vitest';
import { summarizeStressMetricSamples } from '@scripts/stress/stressMetricsSampler';
import type {
    IStressMetricSample,
    IStressProbeTotals,
} from '@scripts/stress/stressTypes';

function probe(overrides: Partial<IStressProbeTotals> = {}): IStressProbeTotals {
    return {
        timerMaxGapMs: 20,
        channelMaxGapMs: 20,
        workerMaxGapMs: 20,
        longTaskCount: 0,
        longTaskMaxMs: 0,
        longTaskTotalMs: 0,
        longTaskDurationsMs: [],
        frameCount: 0,
        frameMaxGapMs: 0,
        frameGapsMs: [],
        ...overrides,
    };
}

function sample(tOffsetMs: number, overrides: Partial<IStressMetricSample> = {}): IStressMetricSample {
    return {
        tOffsetMs,
        epochMs: 1_700_000_000_000 + tOffsetMs,
        rssBytesTotal: 100,
        rssBytesByPid: {
            '1': 60,
            '2': 40,
        },
        jsHeapUsedBytes: 10,
        jsHeapTotalBytes: 20,
        probe: probe(),
        consoleErrorCount: 0,
        pageErrorCount: 0,
        ...overrides,
    };
}

const counters = {
    consoleErrors: [],
    pageErrors: [],
    rendererCrashed: false,
    crashReason: null,
};

describe('summarizeStressMetricSamples', () => {
    it('returns zeros for an empty sample set', () => {
        const summary = summarizeStressMetricSamples([], counters);
        expect(summary.sampleCount).toBe(0);
        expect(summary.durationMs).toBe(0);
        expect(summary.peakRssBytes).toBe(0);
        expect(summary.peakJsHeapUsedBytes).toBeNull();
        expect(summary.firstJsHeapUsedBytes).toBeNull();
    });

    it('tracks peak RSS with the heaviest pid and first/last heap', () => {
        const summary = summarizeStressMetricSamples([
            sample(0, {jsHeapUsedBytes: 10}),
            sample(1000, {
                rssBytesTotal: 500,
                rssBytesByPid: {
                    '1': 100,
                    '7': 400,
                },
                jsHeapUsedBytes: 30,
            }),
            sample(2000, {jsHeapUsedBytes: 25}),
        ], counters);
        expect(summary.sampleCount).toBe(3);
        expect(summary.durationMs).toBe(2000);
        expect(summary.peakRssBytes).toBe(500);
        expect(summary.peakRssPid).toBe('7');
        expect(summary.peakJsHeapUsedBytes).toBe(30);
        expect(summary.firstJsHeapUsedBytes).toBe(10);
        expect(summary.lastJsHeapUsedBytes).toBe(25);
    });

    it('takes the smaller of the timer and channel gaps so one starved probe does not fake a stall', () => {
        const summary = summarizeStressMetricSamples([
            sample(0, {probe: probe({
                timerMaxGapMs: 5000,
                channelMaxGapMs: 40,
            })}),
            sample(1000, {probe: probe({
                timerMaxGapMs: 300,
                channelMaxGapMs: 250,
                workerMaxGapMs: 90,
            })}),
        ], counters);
        expect(summary.heartbeatMaxGapMs).toBe(250);
        expect(summary.workerHeartbeatMaxGapMs).toBe(90);
    });

    it('keeps worker and long-task gaps null when no sample could install those probes', () => {
        const summary = summarizeStressMetricSamples([
            sample(0, {probe: probe({
                workerMaxGapMs: null,
                longTaskMaxMs: null,
            })}),
            sample(1000, {probe: probe({
                workerMaxGapMs: null,
                longTaskMaxMs: null,
            })}),
        ], counters);
        expect(summary.workerHeartbeatMaxGapMs).toBeNull();
        expect(summary.longTaskMaxMs).toBeNull();
        expect(summarizeStressMetricSamples([
            sample(0, {probe: probe({workerMaxGapMs: null})}),
            sample(1000, {probe: probe({workerMaxGapMs: 70})}),
        ], counters).workerHeartbeatMaxGapMs).toBe(70);
    });

    it('aggregates long tasks and frame gaps into p95 and dropped-frame ratio', () => {
        const summary = summarizeStressMetricSamples([
            sample(0, {probe: probe({
                longTaskCount: 2,
                longTaskMaxMs: 120,
                longTaskDurationsMs: [
                    60,
                    120,
                ],
                frameCount: 4,
                frameMaxGapMs: 50,
                frameGapsMs: [
                    16,
                    16,
                    16,
                    50,
                ],
            })}),
            sample(1000, {probe: null}),
        ], {
            ...counters,
            rendererCrashed: true,
            crashReason: 'oom',
        });
        expect(summary.longTaskCount).toBe(2);
        expect(summary.longTaskMaxMs).toBe(120);
        expect(summary.longTaskP95Ms).toBe(120);
        expect(summary.frameGapMaxMs).toBe(50);
        expect(summary.droppedFrameRatio).toBeCloseTo(0.25);
        expect(summary.rendererCrashed).toBe(true);
        expect(summary.crashReason).toBe('oom');
    });
});
