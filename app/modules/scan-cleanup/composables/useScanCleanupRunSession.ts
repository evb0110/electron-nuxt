import type {
    IScanCleanupOptions,
    TScanCleanupLayoutClassification,
} from '@contracts/electronApiScanCleanup';
import type {TDocumentRef} from '@contracts/documentRef';
import type {ComputedRef} from 'vue';
import {
    getScanCleanupPageOverride,
    toScanCleanupLayoutByPage,
} from '@contracts/scanCleanupPageOverrides';
import {
    beginScanCleanupAttempt,
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
import {formatScanCleanupProgress} from '@app/modules/scan-cleanup/runtime/formatScanCleanupProgress';
import {toPlainScanCleanupOptions} from '@app/modules/scan-cleanup/persistence/preferencesRepository';
import {getScanCleanupCapability} from '@app/utils/getScanCleanupCapability';

interface IUseScanCleanupRunSessionOptions {
    active: () => boolean;
    /**
     * How each page is expected to be cut. The run measures its matched canvas
     * over the pages it produces, so it needs the same layouts the preview the
     * user has been looking at was measured against.
     */
    authoritativeLayoutByPage: ComputedRef<ReadonlyMap<number, TScanCleanupLayoutClassification>>;
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
    const transition = ref<'idle' | 'canceling-detection' | 'starting-cleanup'>('idle');
    // The user asked to stop an attempt that has no job to cancel yet: cleanup
    // is still cancelling detection, or its start is still crossing the bridge.
    // The ask outlives that window, so the attempt either never starts or is
    // cancelled the moment it has an id. Dropping it let a run the user had
    // already stopped finish and replace their document with its output.
    const stopRequested = ref(false);
    // A run is under way from the click, not from the job id: everything the
    // click set in motion — cancelling detection, the start request itself — is
    // work the user must be able to stop.
    const isRunning = computed(() => isScanCleanupRunning.value || transition.value !== 'idle');
    const cancelRequested = computed(() => (stopRequested.value && isRunning.value)
        || (scanCleanupRun.ownerId === options.ownerId
            && scanCleanupRun.jobState?.status === 'canceling'));
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
        && hasIncludedPage.value
        && marginsAreValid.value
        && getScanCleanupCapability() !== null);
    const transitionText = computed(() => transition.value === 'canceling-detection'
        ? t('scanCleanup.cancelingDetection')
        : transition.value === 'starting-cleanup'
            ? t('scanCleanup.startingCleanup')
            : '');
    // Only ever read on the run affordance, which an engaged run replaces with
    // the cancel affordance, so the transition explains itself in the meter
    // rather than here.
    const runDisabledReason = computed(() => {
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
    const progressParts = computed(() => formatScanCleanupProgress(progress.value, t));
    const progressPhaseText = computed(() => progressParts.value.phase);
    const progressCountText = computed(() => progressParts.value.count);
    const progressText = computed(() => progressParts.value.text);
    const progressPercentText = computed(() => t('scanCleanup.runPercent', {percent: Math.round(Math.min(100, Math.max(0, progress.value.percent)))}));
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
            layoutByPage: toScanCleanupLayoutByPage(options.authoritativeLayoutByPage.value),
        };
        stopRequested.value = false;
        beginScanCleanupAttempt();
        try {
            if (options.detectionPending.value) {
                transition.value = 'canceling-detection';
                await options.cancelDetectionBeforeRun();
            }
            if (stopRequested.value) {
                return;
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
            if (stopRequested.value) {
                return;
            }
            const result = await startScanCleanup(request);
            if (stopRequested.value) {
                // The stop arrived while the start was in flight. The job it
                // came back with is the one the user already asked to stop.
                if (result.started) await cancelScanCleanup();
                return;
            }
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
        if (cancelRequested.value || !isRunning.value) {
            return;
        }
        if (!scanCleanupRun.activeJobId) {
            stopRequested.value = true;
            return;
        }
        await cancelScanCleanup();
    }

    watch(options.active, active => setScanCleanupWorkspaceOwnerOpen(options.ownerId, active), {immediate: true});
    watch(isScanCleanupRunning, running => {
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
        progressCountText,
        progressPercentText,
        progressPhaseText,
        progressText,
        runLabel,
        runDisabledReason,
        run,
        transitionText,
    };
};
