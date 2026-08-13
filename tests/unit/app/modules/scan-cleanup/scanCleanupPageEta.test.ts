import {
    describe,
    expect,
    it,
} from 'vitest';
import {createScanCleanupPageEtaEstimator} from '@app/modules/scan-cleanup/composables/useScanCleanupPageEta';

describe('scan cleanup page ETA estimator', () => {
    it('keeps the ETA pending until three page durations are available', () => {
        const estimator = createScanCleanupPageEtaEstimator();
        estimator.reset(0, 0);

        expect(estimator.record({
            completedAtMs: 1_000,
            completedUnits: 1,
            totalUnits: 10,
        })).toBeNull();
        expect(estimator.record({
            completedAtMs: 2_000,
            completedUnits: 2,
            totalUnits: 10,
        })).toBeNull();
    });

    it('estimates remaining work from a steady per-page rate', () => {
        const estimator = createScanCleanupPageEtaEstimator();
        estimator.reset(0, 0);

        estimator.record({
            completedAtMs: 1_000,
            completedUnits: 1,
            totalUnits: 10,
        });
        estimator.record({
            completedAtMs: 2_000,
            completedUnits: 2,
            totalUnits: 10,
        });

        expect(estimator.record({
            completedAtMs: 3_000,
            completedUnits: 3,
            totalUnits: 10,
        })).toBe(7_000);
    });

    it('adapts to a newer page rate as the rolling window advances', () => {
        const estimator = createScanCleanupPageEtaEstimator(5);
        estimator.reset(0, 0);
        for (let completedUnits = 1; completedUnits <= 5; completedUnits += 1) {
            estimator.record({
                completedAtMs: completedUnits * 1_000,
                completedUnits,
                totalUnits: 10,
            });
        }

        estimator.record({
            completedAtMs: 5_100,
            completedUnits: 6,
            totalUnits: 10,
        });
        estimator.record({
            completedAtMs: 5_200,
            completedUnits: 7,
            totalUnits: 10,
        });

        expect(estimator.record({
            completedAtMs: 5_300,
            completedUnits: 8,
            totalUnits: 10,
        })).toBe(200);
    });
});
