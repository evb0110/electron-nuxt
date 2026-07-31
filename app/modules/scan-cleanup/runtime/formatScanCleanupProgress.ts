import type {TScanCleanupProgressStage} from '@contracts/electronApiScanCleanup';
import type {TTranslateFn} from '@i18n-app';

interface IScanCleanupProgressCounts {
    stage: TScanCleanupProgressStage;
    completedUnits: number;
    totalUnits: number;
}

interface IScanCleanupPageProgressCounts {
    completedUnits: number;
    totalUnits: number;
}

const COUNTED_STAGES: ReadonlySet<TScanCleanupProgressStage> = new Set([
    'probing',
    'extracting',
    'rasterizing',
    'classifying',
    'rendering',
    'collecting',
    'assembling',
    'detecting',
]);

export const formatScanCleanupProgress = (progress: IScanCleanupProgressCounts, t: TTranslateFn) => {
    const phase = t(`scanCleanup.runProgress.${progress.stage}`);
    const count = COUNTED_STAGES.has(progress.stage) && progress.totalUnits > 1
        ? t('scanCleanup.runCount', {
            completed: progress.completedUnits,
            total: progress.totalUnits,
        })
        : '';
    return {
        phase,
        count,
        text: count === '' ? phase : t('scanCleanup.runStatus', {
            phase,
            counter: count,
        }),
    };
};

export const formatScanCleanupPreAnalysisProgress = (
    progress: IScanCleanupPageProgressCounts,
    t: TTranslateFn,
) => {
    const phase = t('scanCleanup.detectAll.preAnalyzing');
    const count = t('scanCleanup.runCount', {
        completed: progress.completedUnits,
        total: progress.totalUnits,
    });
    return {
        phase,
        count,
        text: t('scanCleanup.runStatus', {
            phase,
            counter: count,
        }),
    };
};
