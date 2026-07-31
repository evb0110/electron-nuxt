import type {TDocumentRef} from '@contracts/documentRef';
import {isScanCleanupRunning} from '@app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator';
import {useScanCleanupSelection} from '@app/modules/scan-cleanup/composables/useScanCleanupSelection';
import {useScanCleanupDocumentSettings} from '@app/modules/scan-cleanup/composables/useScanCleanupDocumentSettings';
import {useScanCleanupDetectionSession} from '@app/modules/scan-cleanup/composables/useScanCleanupDetectionSession';
import {useScanCleanupPreviewSession} from '@app/modules/scan-cleanup/composables/useScanCleanupPreviewSession';
import {useScanCleanupRunSession} from '@app/modules/scan-cleanup/composables/useScanCleanupRunSession';

interface IUseScanCleanupWorkspaceSessionOptions {
    active: () => boolean;
    sourcePath: () => TDocumentRef | null;
    documentKey: () => string | null;
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
    const preferenceDocumentKey = computed(() => options.documentKey() ?? sourcePath.value);
    const documentRevision = computed(() => options.documentRevision?.()
        ?? preferenceDocumentKey.value
        ?? sourcePath.value
        ?? 'unavailable');
    const lifecycleDocumentKey = computed(() => preferenceDocumentKey.value === null
        ? null
        : `${preferenceDocumentKey.value}\u0000${documentRevision.value}`);

    const settings = useScanCleanupDocumentSettings({
        documentLifecycleKey: lifecycleDocumentKey,
        preferenceDocumentKey,
    });
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
        softAlphaForegroundRecommendationByPage:
            detection.softAlphaForegroundRecommendationByPage,
        selectPage: selection.selectPage,
        settings: settings.values,
        sourcePath,
        totalPages,
    });
    function resolvePagePlanEvidence(pageNumbers: readonly number[]) {
        const evidence = new Map(
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
        for (const [
            pageNumber,
            previewEvidence,
        ] of previewResult?.resolvePagePlanEvidence(pageNumbers) ?? []) {
            evidence.set(pageNumber, previewEvidence);
        }
        return evidence;
    }
    const run = useScanCleanupRunSession({
        active: options.active,
        authoritativeLayoutByPage: detection.authoritativeLayoutByPage,
        beforeRun: () => previewResult?.cancel(false),
        cancelDetectionBeforeRun: detection.cancelAndWaitForTerminal,
        detectionError: detection.error,
        detectionPending: detection.pending,
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
