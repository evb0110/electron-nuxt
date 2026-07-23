import type {IScanCleanupOptions} from '@contracts/electronApiScanCleanup';
import type {TDocumentRef} from '@contracts/documentRef';
import type {ComputedRef} from 'vue';
import {getScanCleanupPageOverride} from '@contracts/scanCleanupPageOverrides';
import {
    cancelScanCleanup,
    getScanCleanupRunError,
    isScanCleanupRunning,
    reportScanCleanupRunError,
    resolveScanCleanupProcessedPages,
    scanCleanupRun,
    setScanCleanupWorkspaceOwnerOpen,
    setScanCleanupRunError,
    startScanCleanup,
} from '@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator';
import {toPlainScanCleanupOptions} from '@app/modules/scan-cleanup/persistence/preferencesRepository';
import {getScanCleanupCapability} from '@app/utils/getScanCleanupCapability';

interface IUseScanCleanupRunSessionOptions {
    active: () => boolean;
    beforeRun: () => void;
    cancelDetectionBeforeRun: () => Promise<void>;
    detectionPending: ComputedRef<boolean>;
    documentRevision: ComputedRef<string>;
    onCompleted: () => void;
    ownerId: string;
    previewTotalPages: () => number;
    sourcePageNumbers: ComputedRef<number[] | null>;
    settings: IScanCleanupOptions;
    recommendedOutputModeByPage: ReadonlyMap<number, 'bw' | 'mixed' | 'grayscale' | 'color'>;
    sourcePath: ComputedRef<TDocumentRef | null>;
    totalPages: ComputedRef<number>;
}

export const useScanCleanupRunSession = (options: IUseScanCleanupRunSessionOptions) => {
    const {t} = useTypedI18n();
    const isRunning = isScanCleanupRunning;
    const transition = ref<'idle' | 'canceling-detection' | 'starting-cleanup'>('idle');
    const cancelRequested = computed(() => scanCleanupRun.ownerId === options.ownerId
        && scanCleanupRun.jobState?.status === 'canceling');
    const inlineError = computed(() => options.active() ? getScanCleanupRunError(options.ownerId) : '');
    const runPageNumbers = computed(() => options.sourcePageNumbers.value
        ?? Array.from(
            {length: Math.max(1, options.totalPages.value)},
            (_, index) => index + 1,
        ));
    const hasIncludedPage = computed(() => runPageNumbers.value
        .some(page => !getScanCleanupPageOverride(options.settings.pageOverrides, page).excluded));
    const marginsAreValid = computed(() => Object.values(options.settings.marginsMm).every(margin => (
        Number.isFinite(margin)
        && margin >= 0
        && margin <= 25
    )));
    const progress = computed(() => scanCleanupRun.jobState?.progress ?? {
        stage: 'queued' as const,
        completedUnits: 0,
        totalUnits: runPageNumbers.value.length,
        percent: 0,
        completedPageNumbers: [],
    });
    const processedPages = computed(() => resolveScanCleanupProcessedPages(
        scanCleanupRun.jobState,
        scanCleanupRun.ownerDocumentRef,
        options.sourcePath.value,
        options.previewTotalPages(),
    ));
    const canRun = computed(() => Boolean(options.sourcePath.value)
        && !isRunning.value
        && transition.value === 'idle'
        && hasIncludedPage.value
        && marginsAreValid.value
        && getScanCleanupCapability() !== null);
    const transitionText = computed(() => transition.value === 'canceling-detection'
        ? t('scanCleanup.cancelingDetection')
        : transition.value === 'starting-cleanup'
            ? t('scanCleanup.startingCleanup')
            : '');
    const runDisabledReason = computed(() => {
        if (transition.value !== 'idle') {
            return transitionText.value;
        }
        if (!options.sourcePath.value) {
            return t('scanCleanup.runDisabled.noSource');
        }
        if (!hasIncludedPage.value) {
            return t('scanCleanup.runDisabled.noIncludedPages');
        }
        if (!marginsAreValid.value) {
            return t('scanCleanup.runDisabled.invalidMargins');
        }
        if (getScanCleanupCapability() === null) {
            return t('scanCleanup.runDisabled.unavailable');
        }
        return '';
    });
    const progressText = computed(() => t(`scanCleanup.runProgress.${progress.value.stage}`, {
        completed: progress.value.completedUnits,
        total: progress.value.totalUnits,
    }));
    const runLabel = computed(() => options.sourcePageNumbers.value === null
        ? t('scanCleanup.cleanUp')
        : options.sourcePageNumbers.value.length === 1
            ? t('scanCleanup.cleanUpPage', {page: options.sourcePageNumbers.value[0] ?? 1})
            : t('scanCleanup.cleanUpPages', {count: options.sourcePageNumbers.value.length}));

    async function run() {
        if (!options.sourcePath.value || !canRun.value) {
            return;
        }
        const request = {
            sourcePdfPath: options.sourcePath.value,
            ownerId: options.ownerId,
            documentRevision: options.documentRevision.value,
            options: toPlainScanCleanupOptions(options.settings),
            ...(options.sourcePageNumbers.value === null
                ? {}
                : {sourcePageNumbers: [...options.sourcePageNumbers.value]}),
            ...(options.recommendedOutputModeByPage.size === 0 ? {} : {outputModeRecommendations: Object.fromEntries(
                options.recommendedOutputModeByPage,
            )}),
        };
        try {
            if (options.detectionPending.value) {
                transition.value = 'canceling-detection';
                await options.cancelDetectionBeforeRun();
            }
            if (
                request.sourcePdfPath !== options.sourcePath.value
                || request.documentRevision !== options.documentRevision.value
            ) {
                reportScanCleanupRunError(
                    options.ownerId,
                    t('scanCleanup.documentChangedBeforeRun'),
                    request.sourcePdfPath,
                );
                return;
            }
            transition.value = 'starting-cleanup';
            await nextTick();
            options.beforeRun();
            setScanCleanupRunError(options.ownerId, '');
            const result = await startScanCleanup(request);
            if (!result.started) {
                reportScanCleanupRunError(
                    options.ownerId,
                    result.error ?? t('scanCleanup.failed'),
                    request.sourcePdfPath,
                );
            }
        } catch (caught) {
            reportScanCleanupRunError(
                options.ownerId,
                caught instanceof Error && caught.message ? caught.message : t('scanCleanup.failed'),
                request.sourcePdfPath,
            );
        } finally {
            transition.value = 'idle';
        }
    }

    async function cancel() {
        if (!cancelRequested.value) await cancelScanCleanup();
    }

    watch(options.active, active => setScanCleanupWorkspaceOwnerOpen(options.ownerId, active), {immediate: true});
    watch(isRunning, running => {
        if (!running && scanCleanupRun.jobState?.status === 'completed') options.onCompleted();
    });
    onBeforeUnmount(() => setScanCleanupWorkspaceOwnerOpen(options.ownerId, false));

    return {
        cancel,
        cancelRequested,
        canRun,
        inlineError,
        isRunning,
        processedPages,
        progress,
        progressText,
        runLabel,
        runDisabledReason,
        run,
        transitionText,
    };
};
