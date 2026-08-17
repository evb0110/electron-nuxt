import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    ref,
} from 'vue';
import {
    createScanCleanupPageEtaEstimator,
    useScanCleanupPageEta,
} from '@app/modules/scan-cleanup/composables/useScanCleanupPageEta';

vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (
    key: string,
    parameters?: Record<string, string | number>,
) => Object.entries(parameters ?? {}).reduce(
    (value, [
        parameter,
        replacement,
    ]) => `${value} ${parameter}=${String(replacement)}`,
    key,
)})}));

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

describe('scan cleanup page ETA caption', () => {
    function createCaption() {
        const progress = ref({
            completedAtMs: 0,
            completedUnits: 0,
            phaseKey: 'analysis',
            runKey: 'job-1',
            totalUnits: 10,
        });
        const {
            progressEtaText,
            progressEtaWidestText,
        } = useScanCleanupPageEta(
            computed(() => progress.value),
            computed(() => 'scanCleanup.detectAll.reconciling'),
        );
        return {
            progress,
            progressEtaText,
            progressEtaWidestText,
        };
    }

    it('reports the phase as finishing once the counter reaches its total', () => {
        const {
            progress,
            progressEtaText,
        } = createCaption();

        for (let completedUnits = 1; completedUnits <= 9; completedUnits += 1) {
            progress.value = {
                ...progress.value,
                completedAtMs: completedUnits * 1_000,
                completedUnits,
            };
        }
        expect(progressEtaText.value).toBe('scanCleanup.etaSeconds seconds=1');

        progress.value = {
            ...progress.value,
            completedAtMs: 10_000,
            completedUnits: 10,
        };

        expect(progressEtaText.value).toBe('scanCleanup.detectAll.reconciling');
    });

    it('never falls back to the pending sentence after the counter completes', () => {
        const {
            progress,
            progressEtaText,
        } = createCaption();

        progress.value = {
            ...progress.value,
            completedAtMs: 1_000,
            completedUnits: 10,
        };

        expect(progressEtaText.value).toBe('scanCleanup.detectAll.reconciling');
    });

    it('reserves width for the finishing caption', () => {
        const {progressEtaWidestText} = createCaption();

        expect([
            'scanCleanup.etaPending',
            'scanCleanup.detectAll.reconciling',
            'scanCleanup.etaMinutes minutes=999',
            'scanCleanup.etaSeconds seconds=999',
        ]).toContain(progressEtaWidestText.value);
        expect(progressEtaWidestText.value.length).toBeGreaterThanOrEqual(
            'scanCleanup.detectAll.reconciling'.length,
        );
    });
});
