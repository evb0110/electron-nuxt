import {
    describe,
    expect,
    it,
} from 'vitest';
import type {TScanCleanupProgress} from '@contracts/electronApiScanCleanup';
import {createScanCleanupProgressReporter} from '@scan-cleanup-core/createScanCleanupProgressReporter';

describe('scan cleanup progress reporter', () => {
    it('uses one monotonic rendering band for a streaming raster pipeline', () => {
        const reports: TScanCleanupProgress[] = [];
        const emit = createScanCleanupProgressReporter(
            progress => reports.push(progress),
            () => false,
            {
                isRasterStreaming: () => true,
                now: () => 0,
            },
        );

        emit('probing', 3, 10);
        emit('extracting', 10, 10);
        emit('rendering', 0, 392);
        emit('rendering', 196, 392);
        emit('rendering', 392, 392);
        emit('assembling', 1, 2);

        expect(reports.map(report => report.stage)).not.toContain('rasterizing');
        expect(reports.map(report => report.percent)).toEqual(
            [...reports.map(report => report.percent)].sort((left, right) => left - right),
        );
        expect(reports.find(report => report.stage === 'rendering' && report.completedUnits === 0)?.percent)
            .toBe(10);
        expect(reports.find(report => report.stage === 'rendering' && report.completedUnits === 392)?.percent)
            .toBe(88);
        expect(reports.map(report => [
            report.stageIndex,
            report.stageCount,
        ])).toEqual([
            [
                2,
                7,
            ],
            [
                3,
                7,
            ],
            [
                4,
                7,
            ],
            [
                4,
                7,
            ],
            [
                4,
                7,
            ],
            [
                6,
                7,
            ],
        ]);
    });

    it('withholds ETA until sampled and estimates the weighted work still ahead', () => {
        const reports: TScanCleanupProgress[] = [];
        let now = 0;
        const emit = createScanCleanupProgressReporter(
            progress => reports.push(progress),
            () => false,
            {
                isRasterStreaming: () => true,
                now: () => now,
            },
        );

        emit('rendering', 0, 392);
        for (let completed = 1; completed <= 5; completed += 1) {
            now += 2_000;
            emit('rendering', completed, 392);
        }

        expect(reports.at(-2)?.etaSeconds).toBeUndefined();
        // Five pages at two seconds each leaves 774 seconds in this stage. The
        // remaining 12 weighted percent contributes about 121 more seconds.
        expect(reports.at(-1)?.etaSeconds).toBeGreaterThanOrEqual(890);
        expect(reports.at(-1)?.etaSeconds).toBeLessThanOrEqual(900);
    });

    it('never raises a displayed ETA when a slower sample changes the rate estimate', () => {
        const reports: TScanCleanupProgress[] = [];
        let now = 0;
        const emit = createScanCleanupProgressReporter(
            progress => reports.push(progress),
            () => false,
            {
                isRasterStreaming: () => true,
                now: () => now,
            },
        );

        emit('rendering', 0, 392);
        now = 10_000;
        emit('rendering', 5, 392);
        const initialEta = reports.at(-1)?.etaSeconds;
        now = 18_000;
        emit('rendering', 6, 392);

        expect(initialEta).toBeTypeOf('number');
        expect(reports.at(-1)?.etaSeconds).toBe(initialEta);
    });

    it('never rewinds when a matched lossless run switches to raster rendering', () => {
        const reports: TScanCleanupProgress[] = [];
        let lossless = true;
        const emit = createScanCleanupProgressReporter(
            progress => reports.push(progress),
            () => lossless,
            {now: () => 0},
        );

        emit('rasterizing', 8, 10);
        lossless = false;
        emit('rendering', 1, 10);

        expect(reports[1]!.percent).toBeGreaterThanOrEqual(reports[0]!.percent);
        expect(reports[0]).toMatchObject({
            stageIndex: 4,
            stageCount: 8,
        });
        expect(reports[1]).toMatchObject({
            stageIndex: 5,
            stageCount: 8,
        });
    });
});
