import type {ComputedRef} from 'vue';

const DEFAULT_SAMPLE_WINDOW = 7;
const MINIMUM_SAMPLE_COUNT = 3;

interface IScanCleanupPageEtaProgress {
    completedAtMs: number;
    completedUnits: number;
    phaseKey: string;
    runKey: string;
    totalUnits: number;
}

interface IScanCleanupPageEtaEstimator {
    record: (progress: Omit<IScanCleanupPageEtaProgress, 'phaseKey' | 'runKey'>) => number | null;
    reset: (completedUnits?: number, completedAtMs?: number | null) => void;
}

export function createScanCleanupPageEtaEstimator(
    sampleWindow = DEFAULT_SAMPLE_WINDOW,
): IScanCleanupPageEtaEstimator {
    const durationsMs: number[] = [];
    const normalizedWindow = Math.max(MINIMUM_SAMPLE_COUNT, Math.trunc(sampleWindow));
    let previousCompletedUnits = 0;
    let previousCompletedAtMs: number | null = null;

    function reset(completedUnits = 0, completedAtMs: number | null = null) {
        durationsMs.length = 0;
        previousCompletedUnits = Math.max(0, Math.trunc(completedUnits));
        previousCompletedAtMs = completedAtMs !== null && Number.isFinite(completedAtMs)
            ? completedAtMs
            : null;
    }

    function estimate(completedUnits: number, totalUnits: number) {
        if (durationsMs.length < MINIMUM_SAMPLE_COUNT || completedUnits >= totalUnits) {
            return null;
        }
        const sortedDurations = [...durationsMs].sort((left, right) => left - right);
        const middle = Math.floor(sortedDurations.length / 2);
        const medianDurationMs = sortedDurations.length % 2 === 0
            ? ((sortedDurations[middle - 1] ?? 0) + (sortedDurations[middle] ?? 0)) / 2
            : sortedDurations[middle] ?? 0;
        return Math.max(0, Math.round(medianDurationMs * (totalUnits - completedUnits)));
    }

    function record(progress: Omit<IScanCleanupPageEtaProgress, 'phaseKey' | 'runKey'>) {
        const completedUnits = Math.max(0, Math.trunc(progress.completedUnits));
        const totalUnits = Math.max(completedUnits, Math.trunc(progress.totalUnits));
        const completedAtMs = progress.completedAtMs;
        if (!Number.isFinite(completedAtMs)) {
            return estimate(completedUnits, totalUnits);
        }
        if (completedUnits < previousCompletedUnits) {
            reset(completedUnits, completedAtMs);
            return null;
        }
        if (previousCompletedAtMs === null) {
            previousCompletedUnits = completedUnits;
            previousCompletedAtMs = completedAtMs;
            return null;
        }
        if (completedUnits === previousCompletedUnits) {
            if (completedUnits === 0 && completedAtMs > previousCompletedAtMs) {
                previousCompletedAtMs = completedAtMs;
            }
            return estimate(completedUnits, totalUnits);
        }
        if (completedAtMs <= previousCompletedAtMs) {
            return estimate(completedUnits, totalUnits);
        }

        const completedDelta = completedUnits - previousCompletedUnits;
        const durationPerPageMs = (completedAtMs - previousCompletedAtMs) / completedDelta;
        for (let index = 0; index < completedDelta; index += 1) {
            durationsMs.push(durationPerPageMs);
        }
        if (durationsMs.length > normalizedWindow) {
            durationsMs.splice(0, durationsMs.length - normalizedWindow);
        }
        previousCompletedUnits = completedUnits;
        previousCompletedAtMs = completedAtMs;
        return estimate(completedUnits, totalUnits);
    }

    return {
        record,
        reset,
    };
}

export const useScanCleanupPageEta = (
    progress: ComputedRef<IScanCleanupPageEtaProgress | null>,
) => {
    const {t} = useTypedI18n();
    const estimator = createScanCleanupPageEtaEstimator();
    const estimatedRemainingMs = ref<number | null>(null);
    let activeProgressKey: string | null = null;

    watch(progress, (current) => {
        if (current === null) {
            activeProgressKey = null;
            estimator.reset();
            estimatedRemainingMs.value = null;
            return;
        }
        const progressKey = `${current.runKey}\u0000${current.phaseKey}`;
        if (progressKey !== activeProgressKey) {
            activeProgressKey = progressKey;
            estimator.reset(current.completedUnits, current.completedAtMs);
            estimatedRemainingMs.value = null;
            return;
        }
        estimatedRemainingMs.value = estimator.record(current);
    }, {
        flush: 'sync',
        immediate: true,
    });

    const progressEtaPendingText = computed(() => t('scanCleanup.etaPending'));
    const progressEtaText = computed(() => {
        const remainingMs = estimatedRemainingMs.value;
        if (remainingMs === null) {
            return progressEtaPendingText.value;
        }
        if (remainingMs >= 60_000) {
            return t('scanCleanup.etaMinutes', {minutes: Math.max(1, Math.ceil(remainingMs / 60_000))});
        }
        return t('scanCleanup.etaSeconds', {seconds: Math.max(1, Math.ceil(remainingMs / 1_000))});
    });
    const progressEtaWidestText = computed(() => [
        progressEtaPendingText.value,
        t('scanCleanup.etaMinutes', {minutes: 999}),
        t('scanCleanup.etaSeconds', {seconds: 999}),
    ].reduce((widest, candidate) => candidate.length > widest.length ? candidate : widest));

    return {
        estimatedRemainingMs,
        progressEtaText,
        progressEtaWidestText,
    };
};
