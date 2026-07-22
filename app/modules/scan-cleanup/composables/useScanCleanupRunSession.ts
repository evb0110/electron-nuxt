import type {IScanCleanupOptions} from '@contracts/electronApiScanCleanup';
import type {TDocumentRef} from '@contracts/documentRef';
import type {
    ComputedRef,
    Ref,
} from 'vue';
import {getScanCleanupPageOverride} from '@contracts/scanCleanupPageOverrides';
import {
    cancelScanCleanup,
    getScanCleanupRunError,
    isScanCleanupRunning,
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
    detectionPending: ComputedRef<boolean>;
    documentRevision: ComputedRef<string>;
    onCompleted: () => void;
    ownerId: string;
    previewTotalPages: () => number;
    runOcrAfterCleanup: ComputedRef<boolean> | Ref<boolean>;
    settings: IScanCleanupOptions;
    sourcePath: ComputedRef<TDocumentRef | null>;
    totalPages: ComputedRef<number>;
}

export const useScanCleanupRunSession = (options: IUseScanCleanupRunSessionOptions) => {
    const {t} = useTypedI18n();
    const isRunning = isScanCleanupRunning;
    const cancelRequested = computed(() => scanCleanupRun.ownerId === options.ownerId
        && scanCleanupRun.jobState?.status === 'canceling');
    const inlineError = computed(() => options.active() ? getScanCleanupRunError(options.ownerId) : '');
    const hasIncludedPage = computed(() => Array.from(
        {length: Math.max(1, options.totalPages.value)},
        (_, index) => index + 1,
    ).some(page => !getScanCleanupPageOverride(options.settings.pageOverrides, page).excluded));
    const progress = computed(() => scanCleanupRun.jobState?.progress ?? {
        stage: 'queued' as const,
        completedUnits: 0,
        totalUnits: Math.max(1, options.totalPages.value),
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
        && !options.detectionPending.value
        && hasIncludedPage.value
        && Object.values(options.settings.marginsMm).every(margin => (
            Number.isFinite(margin)
            && margin >= 0
            && margin <= 25
        ))
        && getScanCleanupCapability() !== null);
    const progressText = computed(() => t('scanCleanup.progress', {
        processed: progress.value.completedUnits,
        total: Math.max(progress.value.totalUnits, options.previewTotalPages()),
    }));

    async function run() {
        if (!options.sourcePath.value || !canRun.value) {
            return;
        }
        options.beforeRun();
        setScanCleanupRunError(options.ownerId, '');
        const result = await startScanCleanup({
            sourcePdfPath: options.sourcePath.value,
            ownerId: options.ownerId,
            documentRevision: options.documentRevision.value,
            options: toPlainScanCleanupOptions(options.settings),
            runOcrAfterCleanup: options.runOcrAfterCleanup.value,
        });
        if (!result.started) setScanCleanupRunError(options.ownerId, result.error ?? t('scanCleanup.failed'));
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
        run,
    };
};
