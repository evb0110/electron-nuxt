import type {TDocumentRef} from '@contracts/documentRef';
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
    sourcePath: () => TDocumentRef | null;
    documentKey: () => string | null;
    sourceSha256?: () => string | null;
    documentRevision?: () => string | null;
    ownerId?: () => string | undefined;
    currentPage: () => number;
    totalPages: () => number;
    initialPreviewPage?: () => number | undefined;
    initialPreviewViewMode?: () => 'original' | 'cleaned' | undefined;
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
        documentRevision,
        documentPriorByPage: detection.documentPriorByPage,
        initialViewMode: options.initialPreviewViewMode?.(),
        lifecycleDocumentKey,
        ownerId,
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
        beforeRun: () => previewResult?.cancel(false),
        detectionError: detection.error,
        detectionErrorCode: detection.errorCode,
        detectionPending: detection.pending,
        detectionStatus: detection.terminalStatus,
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
