import type {ComputedRef} from 'vue';

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

/**
 * Pages are analyzed several at a time, so completions do not arrive one per
 * tick: a batch lands within a few milliseconds of itself and is then followed
 * by a gap while the next batch runs. Timing individual gaps between adjacent
 * completions therefore measures batch structure rather than speed — most gaps
 * inside a batch are near zero — and any estimator built on those gaps reads a
 * throughput the machine never had. Measuring elapsed time against pages
 * finished since the phase began spans whole batches and their gaps alike, so
 * the rate it reports is the rate the user is actually waiting through.
 */
export function createScanCleanupPageEtaEstimator(): IScanCleanupPageEtaEstimator {
    let anchorCompletedUnits = 0;
    let anchorAtMs: number | null = null;
    let latestCompletedUnits = 0;

    function reset(completedUnits = 0, completedAtMs: number | null = null) {
        anchorCompletedUnits = Math.max(0, Math.trunc(completedUnits));
        latestCompletedUnits = anchorCompletedUnits;
        anchorAtMs = completedAtMs !== null && Number.isFinite(completedAtMs)
            ? completedAtMs
            : null;
    }

    function estimate(completedUnits: number, totalUnits: number, completedAtMs: number) {
        if (anchorAtMs === null || completedUnits >= totalUnits) {
            return null;
        }
        const measuredUnits = completedUnits - anchorCompletedUnits;
        const elapsedMs = completedAtMs - anchorAtMs;
        if (measuredUnits < MINIMUM_SAMPLE_COUNT || elapsedMs <= 0) {
            return null;
        }
        const msPerUnit = elapsedMs / measuredUnits;
        return Math.max(0, Math.round(msPerUnit * (totalUnits - completedUnits)));
    }

    function record(progress: Omit<IScanCleanupPageEtaProgress, 'phaseKey' | 'runKey'>) {
        const completedUnits = Math.max(0, Math.trunc(progress.completedUnits));
        const totalUnits = Math.max(completedUnits, Math.trunc(progress.totalUnits));
        const completedAtMs = progress.completedAtMs;
        if (!Number.isFinite(completedAtMs)) {
            return null;
        }
        // A counter that moves backward is a different unit of work being
        // counted, not progress undone, so nothing measured before it can be
        // extrapolated past it.
        if (completedUnits < latestCompletedUnits) {
            reset(completedUnits, completedAtMs);
            return null;
        }
        if (anchorAtMs === null) {
            reset(completedUnits, completedAtMs);
            return null;
        }
        // Nothing has finished since measurement began, so the time spent so
        // far is queueing and warm-up rather than page work. Carrying it into
        // the average would charge every remaining page for a cost paid once.
        if (completedUnits === anchorCompletedUnits && completedAtMs > anchorAtMs) {
            anchorAtMs = completedAtMs;
            return null;
        }
        latestCompletedUnits = completedUnits;
        return estimate(completedUnits, totalUnits, completedAtMs);
    }

    return {
        record,
        reset,
    };
}

/**
 * `finishingText` names the tail of a phase whose unit counter has already
 * reached its total while the phase itself is still running. No page rate
 * remains to extrapolate there, so without it the caption falls back to the
 * pending sentence and claims to be estimating a time that already elapsed.
 */
export const useScanCleanupPageEta = (
    progress: ComputedRef<IScanCleanupPageEtaProgress | null>,
    finishingText: ComputedRef<string>,
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
    const countersAreComplete = computed(() => {
        const current = progress.value;
        return current !== null
            && current.totalUnits > 0
            && current.completedUnits >= current.totalUnits;
    });
    const progressEtaText = computed(() => {
        if (countersAreComplete.value) {
            return finishingText.value;
        }
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
        finishingText.value,
        t('scanCleanup.etaMinutes', {minutes: 999}),
        t('scanCleanup.etaSeconds', {seconds: 999}),
    ].reduce((widest, candidate) => candidate.length > widest.length ? candidate : widest));

    return {
        estimatedRemainingMs,
        progressEtaText,
        progressEtaWidestText,
    };
};
