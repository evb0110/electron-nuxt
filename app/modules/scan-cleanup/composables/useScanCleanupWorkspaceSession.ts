import type {TDocumentRef} from '@contracts/documentRef';
import type {TScanCleanupPageOutputMapping} from '@contracts/scan-cleanup/domain';
import {isScanCleanupSourceSha256} from '@contracts/scanCleanupSettings';
import {isScanCleanupRunning} from '@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator';
import {useScanCleanupSelection} from '@app/modules/scan-cleanup/composables/useScanCleanupSelection';
import {useScanCleanupDocumentSettings} from '@app/modules/scan-cleanup/composables/useScanCleanupDocumentSettings';
import {useScanCleanupDetectionSession} from '@app/modules/scan-cleanup/composables/useScanCleanupDetectionSession';
import {useScanCleanupPreviewSession} from '@app/modules/scan-cleanup/composables/useScanCleanupPreviewSession';
import {useScanCleanupRunSession} from '@app/modules/scan-cleanup/composables/useScanCleanupRunSession';
import {toPlainScanCleanupOptions} from '@app/modules/scan-cleanup/persistence/preferencesRepository';

interface IUseScanCleanupWorkspaceSessionOptions {
    active: () => boolean;
    beforeRun?: () => Promise<void> | void;
    sourcePath: () => TDocumentRef | null;
    documentKey: () => string | null;
    sourceSha256?: () => string | null;
    documentRevision?: () => string | null;
    ownerId?: () => string | undefined;
    currentPage: () => number;
    totalPages: () => number;
    initialPreviewPage?: () => number | undefined;
    initialPreviewViewMode?: () => 'original' | 'cleaned' | undefined;
    pageMapping?: () => TScanCleanupPageOutputMapping | null | undefined;
}

export const useScanCleanupWorkspaceSession = (options: IUseScanCleanupWorkspaceSessionOptions) => {
    const initialPreviewPage = Math.max(1, Math.trunc(options.initialPreviewPage?.() ?? options.currentPage()));
    const ownerId = options.ownerId?.()
        ?? globalThis.crypto?.randomUUID?.()
        ?? `scan-cleanup-owner-${Date.now()}-${Math.random()}`;
    const sourcePath = computed(options.sourcePath);
    const totalPages = computed(options.totalPages);
    const legacyDocumentKey = computed(() => options.documentKey() ?? sourcePath.value);
    const sourceSha256 = computed(() => {
        const supplied = options.sourceSha256?.() ?? options.documentKey();
        return isScanCleanupSourceSha256(supplied) ? supplied.toLowerCase() : null;
    });
    const documentRevision = computed(() => options.documentRevision?.()
        ?? legacyDocumentKey.value
        ?? sourcePath.value
        ?? 'unavailable');
    const lifecycleDocumentKey = computed(() => legacyDocumentKey.value === null
        ? null
        : `${sourceSha256.value ?? legacyDocumentKey.value}\u0000${documentRevision.value}`);

    const settings = useScanCleanupDocumentSettings({
        documentLifecycleKey: lifecycleDocumentKey,
        sourceSha256,
        legacyDocumentKey,
    });
    const resolvedOptions = computed(() => toPlainScanCleanupOptions(settings.values));
    let previewResult = null as ReturnType<typeof useScanCleanupPreviewSession> | null;
    const selection = useScanCleanupSelection({
        initialPage: initialPreviewPage,
        previewResult: () => previewResult?.result.value ?? null,
        previewTotalPages: () => previewResult?.totalPages.value ?? Math.max(1, totalPages.value),
        settings: settings.values,
    });
    watch(options.active, active => {
        if (active) selection.resetToLeader(previewResult?.totalPages.value ?? Math.max(1, totalPages.value));
    }, {immediate: true});
    const detection = useScanCleanupDetectionSession({
        active: options.active,
        documentRevision,
        isRunning: isScanCleanupRunning,
        lifecycleDocumentKey,
        ownerId,
        settings: settings.values,
        sourcePath,
        totalPages,
    });
    previewResult = useScanCleanupPreviewSession({
        active: options.active,
        authoritativeLayoutByPage: detection.authoritativeLayoutByPage,
        documentCanvasSignature: detection.documentCanvasSignature,
        documentRevision,
        documentPriorByPage: detection.documentPriorByPage,
        initialViewMode: options.initialPreviewViewMode?.(),
        layoutDetectionComplete: detection.layoutDetectionComplete,
        lifecycleDocumentKey,
        ownerId,
        pagePlanEvidenceByPage: detection.pagePlanEvidenceByPage,
        previewPage: selection.leader,
        recommendedOutputModeByPage: detection.recommendedOutputModeByPage,
        resolvedOptions,
        softAlphaForegroundRecommendationByPage:
            detection.softAlphaForegroundRecommendationByPage,
        selectPage: selection.selectPage,
        settings: settings.values,
        sourcePath,
        totalPages,
    });
    const documentIdentity = computed(() => `${sourcePath.value ?? ''}\u0000${documentRevision.value}`);
    watch([
        documentIdentity,
        totalPages,
    ], (
        [
            identity,
            pageCount,
        ],
        [previousIdentity],
    ) => {
        const normalizedPageCount = Math.max(1, Math.trunc(pageCount));
        if (identity !== previousIdentity) {
            const pageMapping = options.pageMapping?.();
            selection.reconcileDocumentReplacement({
                defaultPage: options.currentPage(),
                pageCount: normalizedPageCount,
                ...(pageMapping === undefined ? {} : {pageMapping}),
            });
            return;
        }
        selection.reconcilePageCount(normalizedPageCount, options.currentPage());
    });
    function resolvePagePlanEvidence(pageNumbers: readonly number[]) {
        return new Map(
            pageNumbers.flatMap(pageNumber => {
                const detected = detection.pagePlanEvidenceByPage.get(pageNumber);
                return detected === undefined
                    ? []
                    : [[
                        pageNumber,
                        detected,
                    ] as const];
            }),
        );
    }
    const run = useScanCleanupRunSession({
        active: options.active,
        authoritativeLayoutByPage: detection.authoritativeLayoutByPage,
        beforeRun: async () => {
            await previewResult?.pauseForRun();
            await options.beforeRun?.();
        },
        detectionError: detection.error,
        detectionErrorCode: detection.errorCode,
        detectionPending: detection.pending,
        detectionStatus: detection.terminalStatus,
        documentPriorByPage: detection.documentPriorByPage,
        documentRevision,
        onCompleted: settings.dismissFirstRunGuidance,
        ownerId,
        previewTotalPages: () => previewResult?.totalPages.value ?? Math.max(1, totalPages.value),
        resolvePagePlanEvidence,
        sourcePageNumbers: computed(() => {
            if (selection.settingsScope.value === 'all') {
                return null;
            }
            if (selection.settingsScope.value === 'page') {
                return [selection.leader.value];
            }
            return [...selection.selectedPages.value].sort((left, right) => left - right);
        }),
        sourcePageMetadataByPage: detection.sourcePageMetadataByPage,
        recommendedOutputModeByPage: detection.recommendedOutputModeByPage,
        resolvedOptions,
        softAlphaForegroundRecommendationByPage:
            detection.softAlphaForegroundRecommendationByPage,
        settings: settings.values,
        sourcePath,
        totalPages,
        waitForDetectionBeforeRun: detection.waitForTerminal,
    });
    // The final renderer reports a source page only after every output leaf
    // for that page has been published. Use that same durable boundary to
    // refresh a preview whose provisional document plan changed during
    // detection. The previous completed frame remains visible while this one
    // is built, and the retained raw-raster cache makes the refresh a single
    // preview sidecar pass rather than another PDF rasterization.
    const runPreviewRefreshPages = new Set<number>();
    watch(run.isRunning, (running, wasRunning) => {
        if (wasRunning && !running) {
            previewResult?.schedule();
        }
    });
    watch([
        run.isRunning,
        selection.leader,
        () => run.processedPages.value.has(selection.leader.value),
    ], ([
        running,
        pageNumber,
        pageCompleted,
    ]) => {
        if (!running) {
            runPreviewRefreshPages.clear();
            return;
        }
        if (!pageCompleted || runPreviewRefreshPages.has(pageNumber)) {
            return;
        }
        runPreviewRefreshPages.add(pageNumber);
        if (!previewResult?.resultCurrent.value) {
            previewResult?.schedule();
        }
    });
    // Preview has its own immediate activity watcher. Detection is a main-side
    // job, so ordinarily cancel it and wait for its terminal snapshot when the
    // tab becomes inactive. Once Clean Up owns that pass, however, detection is
    // part of the user's engaged run: keep it alive across tab switches so the
    // run can start instead of misreporting its deliberate cancellation as
    // missing evidence. If an ordinary hidden tab returns while cancellation
    // is crossing the bridge, resume only after that old job has settled.
    watch(options.active, active => {
        if (active || run.waitingForDetection.value) {
            return;
        }
        void detection.cancelAndWaitForTerminal()
            .catch(() => undefined)
            .then(() => {
                if (options.active()) {
                    void detection.maybeAutoDetect();
                }
            });
    });

    return {
        selection,
        settings,
        detection,
        preview: previewResult,
        run: {
            ...run,
            ownerId,
        },
    };
};
