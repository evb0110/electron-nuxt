import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    parseReplayActions,
    planReplaySteps,
} from '@scripts/stress/stressReplayDriver';
import type { IStressActionRecord } from '@scripts/stress/stressTypes';

function record(overrides: Partial<IStressActionRecord>): IStressActionRecord {
    return {
        seq: 1,
        turn: 1,
        batchIndex: 0,
        runId: 'r',
        scenarioId: 's',
        toolUseId: 'tu',
        toolsetName: 'computer',
        tool: 'left_click',
        input: {coordinate: [
            1,
            2,
        ]},
        status: 'succeeded',
        startedAt: '2026-09-04T00:00:00.000Z',
        completedAt: null,
        durationMs: 1,
        tOffsetMs: 0,
        error: null,
        evidence: null,
        ...overrides,
    };
}

describe('stress replay planning', () => {
    it('lets the final line per seq win and sorts by seq', () => {
        const raw = [
            JSON.stringify(record({
                seq: 2,
                status: 'running',
            })),
            JSON.stringify(record({
                seq: 1,
                status: 'running',
            })),
            JSON.stringify(record({seq: 1})),
            '',
            JSON.stringify(record({seq: 2})),
            JSON.stringify({unrelated: true}),
        ].join('\n');
        const parsed = parseReplayActions(raw);
        expect(parsed.map(item => [
            item.seq,
            item.status,
        ])).toEqual([
            [
                1,
                'succeeded',
            ],
            [
                2,
                'succeeded',
            ],
        ]);
    });

    it('rejects records whose input is not an object or whose toolset name has the wrong type', () => {
        const raw = [
            JSON.stringify(record({seq: 1})),
            JSON.stringify({
                ...record({seq: 2}),
                input: 'left_click',
            }),
            JSON.stringify({
                ...record({seq: 3}),
                toolsetName: 7,
            }),
        ].join('\n');
        expect(parseReplayActions(raw).map(item => item.seq)).toEqual([1]);
    });

    it('ignores a truncated trailing line instead of failing the whole replay', () => {
        const raw = [
            JSON.stringify(record({seq: 1})),
            JSON.stringify(record({seq: 2})).slice(0, 40),
        ].join('\n');
        expect(parseReplayActions(raw).map(item => item.seq)).toEqual([1]);
    });

    it('drops interrupted, still-running, not-executed and report actions', () => {
        const steps = planReplaySteps([
            record({seq: 1}),
            record({
                seq: 2,
                status: 'interrupted',
            }),
            record({
                seq: 3,
                status: 'running',
            }),
            record({
                seq: 4,
                status: 'failed',
                error: 'Not executed: an earlier computer action in this turn failed.',
            }),
            record({
                seq: 5,
                status: 'failed',
                error: 'coordinate outside screen',
            }),
            record({
                seq: 6,
                tool: 'report',
                toolsetName: null,
            }),
            record({
                seq: 7,
                evidence: {
                    screenshotSha256: null,
                    screenshotPath: null,
                    width: null,
                    height: null,
                    appStateSha256: 'state-7',
                    appState: null,
                    consoleErrorCount: 0,
                    pageErrorCount: 0,
                    rendererCrashed: false,
                    rssBytes: null,
                    jsHeapUsedBytes: null,
                    maxFrameGapMs: null,
                },
            }),
        ]);
        expect(steps.map(step => step.seq)).toEqual([
            1,
            5,
            7,
        ]);
        expect(steps[2]?.expectedAppStateSha256).toBe('state-7');
        expect(steps[0]?.expectedAppStateSha256).toBeNull();
    });
});
