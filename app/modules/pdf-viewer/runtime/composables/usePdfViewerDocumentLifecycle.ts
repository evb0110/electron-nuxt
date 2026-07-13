import { delay } from 'es-toolkit/promise';
import { runGuardedTask } from '@app/utils/asyncGuard';
import { BrowserLogger } from '@app/utils/browserLogger';
import type {
    IPageRange,
    TPdfSource,
} from '@app/types/pdfUi';
import { tracePdfAnnotationSaveDom } from '@app/modules/pdf-viewer/engine/pdf-annotation-save-trace/tracePdfAnnotationSaveDom';
import { tracePdfAnnotationSaveEvent } from '@app/modules/pdf-viewer/engine/pdf-annotation-save-trace/tracePdfAnnotationSaveEvent';
import {
    usePdfViewerPreservedVisibleContent,
    type IPreservedVisibleContentRequest,
    type IPreservedVisibleContentState,
} from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerPreservedVisibleContent';
import { resolveCustomReloadZoomMultiplier } from '@app/modules/pdf-viewer/runtime/reload-zoom/resolveCustomReloadZoomMultiplier';
import type { IPdfViewerTransactionCancellation } from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';
import { usePdfViewerInitialRenderRecovery } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerInitialRenderRecovery';
import type {
    IUsePdfViewerDocumentLifecycleOptions,
    TReloadTransactionAdvanceState,
} from '@app/modules/pdf-viewer/runtime/composables/pdfViewerDocumentLifecycle.types';

const RELOAD_RECOVERY_PAGE_PIN_MS = 900;

interface IReloadPlan {
    pageToRestore: number;
    resolvedPageToRestore: number;
    displayZoomToRestore: number | null;
    pagesToInvalidate: number[] | null;
    isSelectiveReload: boolean;
    preservedVisibleContent: IPreservedVisibleContentState | null;
    shouldPreserveVisibleContent: boolean;
    shouldPreserveReloadDisplayZoom: boolean;
    shouldPinReloadPage: boolean;
}

interface IVisualReloadTransition {
    token: number | null;
    settle: (reason: string) => void;
}

export const usePdfViewerDocumentLifecycle = (options: IUsePdfViewerDocumentLifecycleOptions) => {
    let documentLoadToken = 0;
    let scheduledLoadToken = 0;
    const isLoadFromSourceActive = ref(false);
    let shouldPreserveNextSourceReloadVisibleContent = false;
    let nextPreservedVisibleContentState: IPreservedVisibleContentState | null = null;
    let activeReloadTransactionId: number | null = null;
    let initialAnnotationSyncGeneration = 0;
    const {
        capturePreservedVisibleContentState,
        releasePreservedVisualSnapshotNow,
        schedulePreservedVisualSnapshotRelease,
    } = usePdfViewerPreservedVisibleContent({
        viewerContainer: options.viewerContainer,
        currentPage: options.currentPage,
    });
    const { scheduleRecoverInitialRender } = usePdfViewerInitialRenderRecovery({
        viewerContainer: options.viewerContainer,
        pdfDocument: options.pdfDocument,
        numPages: options.numPages,
        isLoading: options.isLoading,
        currentPage: options.currentPage,
        computeFitWidthScale: options.computeFitWidthScale,
        getVisibleRange: options.getVisibleRange,
        updateVisibleRange: options.updateVisibleRange,
        renderVisiblePages: options.renderVisiblePages,
        syncCurrentPageFromViewport: options.syncCurrentPageFromViewport,
        transactionController: options.transactionController,
        isInitialCanvasCommitted: options.isInitialCanvasCommitted,
        isInitialVisualCommitted: options.isInitialVisualCommitted,
        onTerminalFailure: error => options.emitLoadError?.(error),
    });
    function beginReloadTransaction(plan: IReloadPlan) {
        const range = {
            start: plan.resolvedPageToRestore,
            end: plan.resolvedPageToRestore,
        };
        const transaction = options.transactionController?.beginTransaction({
            kind: 'reload',
            source: 'reload',
            page: plan.resolvedPageToRestore,
            range,
            anchor: 'top',
            scrollPlan: {
                preferExactDom: true,
                commitCurrentPageOnScroll: true,
                suppressSnapAfterScroll: true,
                holdProgrammaticNavigationMs: RELOAD_RECOVERY_PAGE_PIN_MS,
            },
        });
        activeReloadTransactionId = transaction?.id ?? null;
        return activeReloadTransactionId;
    }

    function isReloadTransactionCurrent(transactionId: number | null) {
        return transactionId === null
            || options.transactionController?.isTransactionCurrent(transactionId) !== false;
    }

    function advanceReloadTransaction(
        transactionId: number | null,
        state: TReloadTransactionAdvanceState,
    ) {
        if (transactionId === null) {
            return true;
        }
        return options.transactionController?.advanceTransaction(transactionId, state) ?? true;
    }

    function settleReloadTransaction(transactionId: number | null) {
        const didAdvance = advanceReloadTransaction(transactionId, 'settled');
        if (activeReloadTransactionId === transactionId) {
            activeReloadTransactionId = null;
        }
        return didAdvance;
    }

    function cancelReloadTransaction(
        transactionId: number | null,
        cancellation: IPdfViewerTransactionCancellation,
    ) {
        if (transactionId === null) {
            return true;
        }
        if (
            options.transactionController
            && !options.transactionController.isTransactionCurrent(transactionId)
        ) {
            if (activeReloadTransactionId === transactionId) {
                activeReloadTransactionId = null;
            }
            return true;
        }
        const didCancel = options.transactionController?.cancelActiveTransaction(
            cancellation,
            transactionId,
        ) ?? true;
        if (activeReloadTransactionId === transactionId) {
            activeReloadTransactionId = null;
        }
        return didCancel;
    }

    function createReloadCancellation(
        reason: IPdfViewerTransactionCancellation['reason'],
        preserveVisualContent: boolean,
    ): IPdfViewerTransactionCancellation {
        return {
            reason,
            cancelInFlightRenders: true,
            bumpRenderVersion: reason === 'document-changed' || reason === 'reload',
            preserveVisualContent,
        };
    }

    function commitReloadCurrentPage(page: number, transactionId: number | null) {
        return transactionId === null
            || options.transactionController?.isTransactionCurrent(transactionId) !== false;
    }

    function commitReloadVisibleRange(range: IPageRange, transactionId: number | null) {
        const didCommit = options.transactionController?.commitVisibleRange(
            range,
            transactionId !== null ? { transactionId } : undefined,
        );
        if (didCommit !== undefined) {
            return didCommit;
        }
        options.visibleRange.value = range;
        return true;
    }

    function commitReloadViewportVisibleRange(transactionId: number | null) {
        const range = options.getVisiblePageRange?.(
            options.viewerContainer.value,
            options.numPages.value,
        );
        if (range) {
            return commitReloadVisibleRange(range, transactionId);
        }
        if (!isReloadTransactionCurrent(transactionId)) {
            return false;
        }
        options.updateVisibleRange(options.viewerContainer.value, options.numPages.value);
        return true;
    }

    function applyReloadViewport(
        pageNumber: number,
        scrollOptions?: Parameters<IUsePdfViewerDocumentLifecycleOptions['scrollToPage']>[1],
    ) {
        const commitViewport = options.commitReloadViewport ?? options.scrollToPage;
        if (scrollOptions === undefined) {
            commitViewport(pageNumber);
            return;
        }
        commitViewport(pageNumber, scrollOptions);
    }

    function logAsyncStageError(stage: string, error: unknown) {
        BrowserLogger.error('pdf-viewer', `Failed to ${stage}`, error);
    }

    async function waitForZoomPropSync(targetZoom: number) {
        if (Math.abs(options.zoom.value - targetZoom) <= 0.001) {
            return true;
        }

        for (let attempt = 0; attempt < 6; attempt += 1) {
            await nextTick();
            if (Math.abs(options.zoom.value - targetZoom) <= 0.001) {
                return true;
            }

            await delay(0);
            if (Math.abs(options.zoom.value - targetZoom) <= 0.001) {
                return true;
            }
        }

        BrowserLogger.diagnostic('pdf-nav', '[load-from-source] zoom restore did not sync before render', {
            currentZoom: options.zoom.value,
            targetZoom,
        });
        return false;
    }

    function clearAnnotationCacheForEmptySource() {
        options.commentSync.incrementSyncToken();
        options.clearAnnotationProjection?.();
        options.activeCommentStableKey.value = null;
        options.emit('annotation-comments', []);
    }

    function releasePlanPreservedVisualSnapshotNow(
        plan: IReloadPlan,
        reason: string,
    ) {
        releasePreservedVisualSnapshotNow(plan.preservedVisibleContent, reason);
    }

    function computeReloadPlan(isReload: boolean): IReloadPlan {
        const preservedVisibleContentRequest = shouldPreserveNextSourceReloadVisibleContent
            ? nextPreservedVisibleContentState
            : null;
        const pageToRestore = isReload
            ? preservedVisibleContentRequest?.pageToRestore ?? options.currentPage.value
            : 1;
        const resolvedPageToRestore = Math.max(1, Math.floor(pageToRestore));
        const displayZoomToRestore = isReload && options.zoomMode.value === 'custom'
            ? options.effectiveScale.value
            : null;
        const pagesToInvalidate = options.consumePendingInvalidation();
        const isSelectiveReload = isReload && pagesToInvalidate !== null;
        const shouldPreserveVisibleContent =
            isReload && !isSelectiveReload && preservedVisibleContentRequest !== null;
        shouldPreserveNextSourceReloadVisibleContent = false;
        nextPreservedVisibleContentState = null;
        if (preservedVisibleContentRequest && !shouldPreserveVisibleContent) {
            releasePreservedVisualSnapshotNow(
                preservedVisibleContentRequest,
                isSelectiveReload ? 'selective-reload' : 'non-reload-load',
            );
        }
        const shouldPreserveReloadDisplayZoom = isReload
            && !isSelectiveReload
            && displayZoomToRestore !== null;
        const shouldPinReloadPage = isReload && resolvedPageToRestore > 1;
        return {
            pageToRestore,
            resolvedPageToRestore,
            displayZoomToRestore,
            pagesToInvalidate,
            isSelectiveReload,
            preservedVisibleContent: shouldPreserveVisibleContent
                ? preservedVisibleContentRequest
                : null,
            shouldPreserveVisibleContent,
            shouldPreserveReloadDisplayZoom,
            shouldPinReloadPage,
        };
    }

    function createVisualReloadTransition(shouldPinReloadPage: boolean): IVisualReloadTransition {
        const token = shouldPinReloadPage
            ? options.beginVisualReloadTransition('reload-recovery')
            : null;
        let settled = false;
        const settle = (reason: string) => {
            if (token === null || settled) {
                return;
            }
            settled = true;
            options.endVisualReloadTransition(token, reason);
        };
        return {
            token,
            settle,
        };
    }

    function applyPreLoadStateReset(
        plan: IReloadPlan,
        isReload: boolean,
        transactionId: number | null,
    ) {
        const shouldPreserveOpeningLayout = !isReload
            && !plan.shouldPreserveVisibleContent
            && options.shouldPreserveOpeningLayout?.() === true;
        if (!plan.shouldPreserveVisibleContent) {
            options.emit('update:document', null);
        }
        if (!isReload) options.emit('update:totalPages', 0);
        options.emit('update:currentPage', plan.pageToRestore);

        if (plan.isSelectiveReload && plan.pagesToInvalidate) {
            options.invalidateRenderedPages(plan.pagesToInvalidate);
        } else if (plan.shouldPreserveVisibleContent) {
            if (isReload || plan.shouldPreserveReloadDisplayZoom) {
                options.invalidateScaleCache();
            }
            commitReloadCurrentPage(plan.pageToRestore, transactionId);
        } else {
            options.cleanupRenderedPages();
            if (isReload || plan.shouldPreserveReloadDisplayZoom || shouldPreserveOpeningLayout) {
                options.invalidateScaleCache();
            } else {
                options.resetScale();
            }
            if (!shouldPreserveOpeningLayout) {
                options.resetInsets();
            }
            commitReloadCurrentPage(plan.pageToRestore, transactionId);
            commitReloadVisibleRange({
                start: plan.pageToRestore,
                end: plan.pageToRestore,
            }, transactionId);
        }
        // `resetScale` and source cleanup run before document metadata is
        // available. Re-join the renderer to the host's prepared page-frame
        // authority here so the first render cannot fall back to scale 1.
        options.seedOpeningFitScale?.();
        if (!plan.shouldPreserveVisibleContent) {
            options.editor.destroyAnnotationEditor();
        }
    }

    function cleanupPreservedVisibleContentAfterLoadFailure(
        plan: IReloadPlan,
        transactionId: number | null,
    ) {
        if (!plan.shouldPreserveVisibleContent) {
            return;
        }

        releasePlanPreservedVisualSnapshotNow(plan, 'preserved-load-failure');
        options.emit('update:document', null);
        options.cleanupRenderedPages();
        options.editor.destroyAnnotationEditor();
        options.resetInsets();
        commitReloadVisibleRange({
            start: plan.pageToRestore,
            end: plan.pageToRestore,
        }, transactionId);
    }

    function restoreSelectiveReloadBaseDimensions(
        plan: IReloadPlan,
        savedBaseWidth: number | null,
        savedBaseHeight: number | null,
    ) {
        if (
            plan.isSelectiveReload &&
            savedBaseWidth !== null &&
            savedBaseHeight !== null
        ) {
            options.basePageWidth.value = savedBaseWidth;
            options.basePageHeight.value = savedBaseHeight;
        }
    }

    function applyPostLoadDocumentMetadata(plan: IReloadPlan, transactionId: number | null) {
        options.emit('update:document', options.pdfDocument.value);
        options.editor.initAnnotationEditor();

        const nextPage = Math.min(plan.resolvedPageToRestore, options.numPages.value);
        const didCommitCurrentPage = commitReloadCurrentPage(nextPage, transactionId);
        options.emit('update:totalPages', options.numPages.value);
        if (didCommitCurrentPage) {
            options.emit('update:currentPage', options.currentPage.value);
        }
        return didCommitCurrentPage;
    }

    function resolveMetricHydrationStartPage(plan: IReloadPlan, isReload: boolean) {
        return isReload && !plan.isSelectiveReload && options.currentPage.value > 1
            ? 1
            : options.currentPage.value;
    }

    function scheduleSkeletonInsetsCompute(documentVersion: number) {
        runGuardedTask(
            async () => {
                const firstPage = await options.getPage(1);
                if (!isLoadedDocumentVersionActive(documentVersion)) {
                    return;
                }
                await options.computeSkeletonInsets(
                    firstPage,
                    documentVersion,
                    options.getRenderVersion,
                );
            },
            {
                category: 'background-diagnostic',
                scope: 'pdf-viewer',
                message: 'Failed to compute PDF skeleton insets',
            },
        );
    }

    function scheduleInitialAnnotationSync(
        activeLoadToken: number,
        documentVersion: number,
    ) {
        cancelInitialAnnotationSync();
        const syncGeneration = initialAnnotationSyncGeneration;
        if (
            syncGeneration === initialAnnotationSyncGeneration
            && isActiveLoadedDocument(activeLoadToken, documentVersion)
        ) options.commentSync.scheduleAnnotationCommentsSync();
    }

    function cancelInitialAnnotationSync() {
        initialAnnotationSyncGeneration += 1;
    }

    function schedulePostInitialLoadWork(
        activeLoadToken: number,
        documentVersion: number,
        optionsToSchedule: {
            computeSkeletonInsets?: boolean;
            initialRenderError?: unknown;
        } = {},
    ) {
        runGuardedTask(
            async () => {
                await nextTick();
                if (!isActiveLoadedDocument(activeLoadToken, documentVersion)) {
                    return;
                }

                if (optionsToSchedule.computeSkeletonInsets) {
                    scheduleSkeletonInsetsCompute(documentVersion);
                }
                options.applySearchHighlights();
                // A complete annotation inventory may touch every page. Require
                // a committed canvas and then use the debounced background lane
                // so it cannot preempt the first visible render.
                scheduleInitialAnnotationSync(activeLoadToken, documentVersion);
                const loadedDocument = options.pdfDocument.value;
                const viewportInteractionEpoch = options.getUserViewportInteractionEpoch?.() ?? 0;
                const isRecoveryContextCurrent = () =>
                    isDocumentLoadActive(activeLoadToken)
                        && options.pdfDocument.value === loadedDocument
                        && (options.getUserViewportInteractionEpoch?.() ?? 0) === viewportInteractionEpoch;
                scheduleRecoverInitialRender({
                    isCurrent: isRecoveryContextCurrent,
                    initialRenderError: optionsToSchedule.initialRenderError,
                });
            },
            {
                category: 'background-diagnostic',
                scope: 'pdf-viewer',
                message: 'Failed to run deferred PDF load work',
            },
        );
    }

    function pinCurrentPageToRestoreTarget(plan: IReloadPlan, transactionId: number | null) {
        const nextPage = Math.min(plan.resolvedPageToRestore, options.numPages.value);
        const didCommitCurrentPage = commitReloadCurrentPage(nextPage, transactionId);
        if (didCommitCurrentPage) {
            options.emit('update:currentPage', options.currentPage.value);
        }
        return didCommitCurrentPage;
    }

    function scheduleWarmBufferedRender(
        plan: IReloadPlan,
        activeLoadToken: number,
        documentVersion: number,
        transactionId: number | null,
        settleVisualReloadTransition: (reason: string) => void,
        settleDocumentLoadAfterRender: boolean,
    ) {
        runGuardedTask(
            async () => {
                try {
                    if (!isActiveLoadedDocument(activeLoadToken, documentVersion)) {
                        return;
                    }
                    if (!isReloadTransactionCurrent(transactionId)) {
                        return;
                    }
                    if (plan.shouldPreserveVisibleContent) {
                        pinCurrentPageToRestoreTarget(plan, transactionId);
                        return;
                    }
                    await options.waitForInitialCanvasCommit?.(options.currentPage.value);
                    if (!isActiveLoadedDocument(activeLoadToken, documentVersion)) {
                        return;
                    }
                    if (!isReloadTransactionCurrent(transactionId)) {
                        return;
                    }
                    advanceReloadTransaction(transactionId, 'render-requested');
                    await options.renderVisiblePages(options.getVisibleRange());
                    if (
                        !isActiveLoadedDocument(activeLoadToken, documentVersion)
                        || !isReloadTransactionCurrent(transactionId)
                    ) {
                        return;
                    }
                    if (plan.shouldPinReloadPage) {
                        pinCurrentPageToRestoreTarget(plan, transactionId);
                        applyReloadViewport(options.currentPage.value);
                        await nextTick();
                        commitReloadViewportVisibleRange(transactionId);
                    }
                } finally {
                    settleVisualReloadTransition('warm-render-complete');
                    settleReloadTransaction(transactionId);
                    if (settleDocumentLoadAfterRender) {
                        settleDocumentLoad(activeLoadToken);
                    }
                }
            },
            {
                category: 'user-visible-operation',
                scope: 'pdf-viewer',
                message: 'Failed to warm buffered PDF pages after initial render',
            },
        );
    }

    function startDocumentLoad() {
        cancelInitialAnnotationSync();
        isLoadFromSourceActive.value = true;
        const token = ++documentLoadToken;
        options.onDocumentLoadStateChange?.({
            token,
            phase: 'started',
        });
        return token;
    }

    function isDocumentLoadActive(token: number) {
        return token === documentLoadToken;
    }

    function isLoadedDocumentVersionActive(documentVersion: number) {
        return options.pdfDocument.value !== null
            && documentVersion === options.getRenderVersion();
    }

    function isActiveLoadedDocument(token: number, documentVersion: number) {
        return isDocumentLoadActive(token)
            && isLoadedDocumentVersionActive(documentVersion);
    }

    function settleDocumentLoad(token: number) {
        if (!isDocumentLoadActive(token)) {
            return;
        }
        isLoadFromSourceActive.value = false;
        options.onDocumentLoadStateChange?.({
            token,
            phase: 'settled',
        });
    }

    function invalidateDocumentLoad() {
        cancelInitialAnnotationSync();
        scheduledLoadToken += 1;
        cancelReloadTransaction(
            activeReloadTransactionId,
            createReloadCancellation('document-changed', false),
        );
        if (isLoadFromSourceActive.value) {
            options.onDocumentLoadStateChange?.({
                token: documentLoadToken,
                phase: 'settled',
            });
        }
        documentLoadToken += 1;
        isLoadFromSourceActive.value = false;
    }

    function pinReloadRecoveryPageIfNeeded(plan: IReloadPlan) {
        if (!plan.shouldPinReloadPage) {
            return;
        }

        // Geometry-changing reloads can briefly report a stale viewport page
        // while placeholders, resize observers, and buffered renders settle.
        options.pinCurrentPageDuringRecovery(plan.resolvedPageToRestore, {
            durationMs: RELOAD_RECOVERY_PAGE_PIN_MS,
            reason: 'reload-recovery',
        });
    }

    function captureSelectiveReloadState(plan: IReloadPlan) {
        return {
            savedBaseWidth: plan.isSelectiveReload ? options.basePageWidth.value : null,
            savedBaseHeight: plan.isSelectiveReload ? options.basePageHeight.value : null,
            savedVisibleRange: plan.isSelectiveReload
                ? { ...options.visibleRange.value }
                : null,
        };
    }

    function resolveLoadSourceForPlan(isReload: boolean) {
        return isReload
            ? options.reloadSrc?.value ?? options.src.value
            : options.src.value;
    }

    function loadPdfForPlan(plan: IReloadPlan, isReload: boolean) {
        return options.loadPdf(
            resolveLoadSourceForPlan(isReload) as TPdfSource,
            {
                ...(options.documentLifecycleKey?.value
                    ? {lifecycleKey: options.documentLifecycleKey.value}
                    : {}),
                ...(plan.isSelectiveReload || plan.shouldPreserveVisibleContent
                    ? {preservePageStructure: true}
                    : {}),
            },
        );
    }

    function resolveCustomReloadZoomToApply(plan: IReloadPlan) {
        if (plan.displayZoomToRestore === null) {
            return null;
        }

        return resolveCustomReloadZoomMultiplier({
            currentZoom: options.zoom.value,
            currentEffectiveScale: options.effectiveScale.value,
            targetDisplayZoom: plan.displayZoomToRestore,
        });
    }

    function finishLoadedSource(
        plan: IReloadPlan,
        activeLoadToken: number,
        documentVersion: number,
        transactionId: number | null,
        visualReload: IVisualReloadTransition,
        settleVisualReloadTransition: (reason: string) => void,
        initialRenderError?: unknown,
    ) {
        if (plan.shouldPreserveVisibleContent) {
            settleVisualReloadTransition('preserved-load-complete');
            settleReloadTransaction(transactionId);
            settleDocumentLoad(activeLoadToken);
            schedulePostInitialLoadWork(activeLoadToken, documentVersion, { initialRenderError });
            return true;
        }

        const visualReloadTransitionHandledByWarmRender = visualReload.token !== null;
        settleDocumentLoad(activeLoadToken);
        scheduleWarmBufferedRender(
            plan,
            activeLoadToken,
            documentVersion,
            transactionId,
            settleVisualReloadTransition,
            false,
        );
        schedulePostInitialLoadWork(
            activeLoadToken,
            documentVersion,
            {
                computeSkeletonInsets: !plan.isSelectiveReload,
                initialRenderError,
            },
        );

        if (!visualReloadTransitionHandledByWarmRender) {
            settleVisualReloadTransition('load-complete');
        }

        return true;
    }

    function restorePreservedPage(plan: IReloadPlan) {
        if (!plan.shouldPreserveVisibleContent) {
            return;
        }
        const anchor = plan.preservedVisibleContent?.semanticAnchor;
        applyReloadViewport(plan.resolvedPageToRestore, {
            navigationSource: 'restore',
            preferExactDom: true,
            ...(anchor
                ? {
                    pageYRatio: anchor.yRatio,
                    markerRect: {
                        left: anchor.xRatio,
                        top: anchor.yRatio,
                        width: 0,
                        height: 0,
                    },
                }
                : {}),
        });
    }

    async function renderInitialLoadedPage(
        plan: IReloadPlan,
        transactionId: number | null,
    ) {
        const initialRange = {
            start: options.currentPage.value,
            end: options.currentPage.value,
        } satisfies IPageRange;

        if (plan.shouldPreserveVisibleContent) {
            const currentPageContainer = options.viewerContainer.value
                ?.querySelector<HTMLElement>(`.page_container[data-page="${options.currentPage.value}"]`);
            tracePdfAnnotationSaveDom(
                'document-lifecycle:preserved-render-visible:start',
                currentPageContainer,
                { pageNumber: options.currentPage.value },
            );
            advanceReloadTransaction(transactionId, 'render-requested');
            await options.renderVisiblePages(initialRange, {
                preserveRenderedPages: true,
                bufferOverride: 0,
                forceRerender: true,
            });
            tracePdfAnnotationSaveDom(
                'document-lifecycle:preserved-render-visible:done',
                currentPageContainer,
                { pageNumber: options.currentPage.value },
            );
            restorePreservedPage(plan);
            schedulePreservedVisualSnapshotRelease(plan, 'preserved-render-visible-done');
            return;
        }

        advanceReloadTransaction(transactionId, 'render-requested');
        await options.renderVisiblePages(initialRange, { bufferOverride: 0 });
    }

    async function reconcileFreshDocumentViewport(
        plan: IReloadPlan,
        activeLoadToken: number,
        loadedVersion: number,
        viewportInteractionEpoch: number,
        transactionId: number | null,
    ) {
        if (
            plan.shouldPreserveVisibleContent
            || plan.isSelectiveReload
        ) {
            return true;
        }

        await nextTick();
        if (!isActiveLoadedDocument(activeLoadToken, loadedVersion)) {
            return false;
        }

        if (
            options.getUserViewportInteractionEpoch
            && options.getUserViewportInteractionEpoch() !== viewportInteractionEpoch
        ) {
            return true;
        }

        applyReloadViewport(plan.resolvedPageToRestore);
        return commitReloadViewportVisibleRange(transactionId);
    }

    async function loadFromSource(isReload = false) {
        if (!options.src.value) {
            releasePreservedVisualSnapshotNow(nextPreservedVisibleContentState, 'empty-source');
            shouldPreserveNextSourceReloadVisibleContent = false;
            nextPreservedVisibleContentState = null;
            cancelReloadTransaction(
                activeReloadTransactionId,
                createReloadCancellation('document-changed', false),
            );
            clearAnnotationCacheForEmptySource();
            return;
        }

        const activeLoadToken = startDocumentLoad();
        const viewportInteractionEpoch = options.getUserViewportInteractionEpoch?.() ?? 0;
        let settleTransferredToFinish = false;
        let activeReloadPlan: IReloadPlan | null = null;
        let reloadTransactionId: number | null = null;
        let reloadCancellation: IPdfViewerTransactionCancellation | null = null;
        let initialRenderError: unknown;

        try {
            const plan = computeReloadPlan(isReload);
            activeReloadPlan = plan;
            reloadTransactionId = beginReloadTransaction(plan);
            tracePdfAnnotationSaveEvent(
                'document-lifecycle:load-from-source:plan',
                {
                    isReload,
                    pageToRestore: plan.pageToRestore,
                    shouldPreserveVisibleContent: plan.shouldPreserveVisibleContent,
                },
            );
            const visualReload = createVisualReloadTransition(plan.shouldPinReloadPage);
            const settleVisualReloadTransition = visualReload.settle;

            pinReloadRecoveryPageIfNeeded(plan);
            const {
                savedBaseWidth,
                savedBaseHeight,
                savedVisibleRange,
            } = captureSelectiveReloadState(plan);

            applyPreLoadStateReset(plan, isReload, reloadTransactionId);

            const loaded = await loadPdfForPlan(plan, isReload);
            if (!isDocumentLoadActive(activeLoadToken)) {
                releasePlanPreservedVisualSnapshotNow(plan, 'load-superseded');
                settleVisualReloadTransition('load-superseded');
                reloadCancellation = createReloadCancellation(
                    'superseded',
                    plan.shouldPreserveVisibleContent,
                );
                return;
            }
            if (!loaded) {
                const loadError = options.loadError?.value ?? null;
                if (loadError) {
                    options.emitLoadError?.(loadError);
                }
                cleanupPreservedVisibleContentAfterLoadFailure(plan, reloadTransactionId);
                settleVisualReloadTransition('load-aborted');
                reloadCancellation = createReloadCancellation(
                    'reload',
                    plan.shouldPreserveVisibleContent,
                );
                return;
            }
            if (!isLoadedDocumentVersionActive(loaded.version)) {
                releasePlanPreservedVisualSnapshotNow(plan, 'load-version-superseded');
                settleVisualReloadTransition('load-version-superseded');
                reloadCancellation = createReloadCancellation(
                    'superseded',
                    plan.shouldPreserveVisibleContent,
                );
                return;
            }

            restoreSelectiveReloadBaseDimensions(plan, savedBaseWidth, savedBaseHeight);
            if (!applyPostLoadDocumentMetadata(plan, reloadTransactionId)) {
                releasePlanPreservedVisualSnapshotNow(plan, 'metadata-commit-superseded');
                settleVisualReloadTransition('metadata-commit-superseded');
                reloadCancellation = createReloadCancellation(
                    'superseded',
                    plan.shouldPreserveVisibleContent,
                );
                return;
            }
            if (!plan.shouldPreserveVisibleContent) {
                await options.ensurePageMetricsInRange(
                    resolveMetricHydrationStartPage(plan, isReload),
                    options.currentPage.value,
                );
                if (!isActiveLoadedDocument(activeLoadToken, loaded.version)) {
                    releasePlanPreservedVisualSnapshotNow(plan, 'metric-prime-superseded');
                    settleVisualReloadTransition('metric-prime-superseded');
                    reloadCancellation = createReloadCancellation(
                        'superseded',
                        plan.shouldPreserveVisibleContent,
                    );
                    return;
                }
                if (!plan.isSelectiveReload) {
                    options.computeFitWidthScale(options.viewerContainer.value);
                }
            }

            if (!plan.isSelectiveReload && !plan.shouldPreserveVisibleContent) {
                const nextZoom = resolveCustomReloadZoomToApply(plan);
                if (nextZoom !== null && Math.abs(nextZoom - options.zoom.value) > 0.001) {
                    options.suppressNextZoomRerender(nextZoom);
                    options.emit('update:zoom', nextZoom);
                    await waitForZoomPropSync(nextZoom);
                    if (!isActiveLoadedDocument(activeLoadToken, loaded.version)) {
                        releasePlanPreservedVisualSnapshotNow(plan, 'zoom-sync-superseded');
                        settleVisualReloadTransition('zoom-sync-superseded');
                        reloadCancellation = createReloadCancellation(
                            'superseded',
                            plan.shouldPreserveVisibleContent,
                        );
                        return;
                    }
                }
            }

            await nextTick();
            if (!isActiveLoadedDocument(activeLoadToken, loaded.version)) {
                releasePlanPreservedVisualSnapshotNow(plan, 'before-initial-render-superseded');
                settleVisualReloadTransition('before-initial-render-superseded');
                reloadCancellation = createReloadCancellation(
                    'superseded',
                    plan.shouldPreserveVisibleContent,
                );
                return;
            }

            if (!plan.isSelectiveReload && !plan.shouldPreserveVisibleContent) {
                options.setupPagePlaceholders();
                if (!isReload) {
                    const reconciled = await reconcileFreshDocumentViewport(
                        plan,
                        activeLoadToken,
                        loaded.version,
                        viewportInteractionEpoch,
                        reloadTransactionId,
                    );
                    if (!reconciled) {
                        releasePlanPreservedVisualSnapshotNow(plan, 'fresh-scroll-superseded');
                        settleVisualReloadTransition('fresh-scroll-superseded');
                        reloadCancellation = createReloadCancellation(
                            'superseded',
                            plan.shouldPreserveVisibleContent,
                        );
                        return;
                    }
                }
                if (isReload && options.currentPage.value > 1) {
                    applyReloadViewport(options.currentPage.value);
                    await nextTick();
                    if (!isActiveLoadedDocument(activeLoadToken, loaded.version)) {
                        releasePlanPreservedVisualSnapshotNow(plan, 'restore-scroll-superseded');
                        settleVisualReloadTransition('restore-scroll-superseded');
                        reloadCancellation = createReloadCancellation(
                            'superseded',
                            plan.shouldPreserveVisibleContent,
                        );
                        return;
                    }
                }
            } else if (savedVisibleRange) {
                commitReloadVisibleRange(savedVisibleRange, reloadTransactionId);
            }

            if (!plan.shouldPreserveVisibleContent) {
                if (!commitReloadViewportVisibleRange(reloadTransactionId)) {
                    releasePlanPreservedVisualSnapshotNow(plan, 'visible-range-commit-superseded');
                    settleVisualReloadTransition('visible-range-commit-superseded');
                    reloadCancellation = createReloadCancellation(
                        'superseded',
                        plan.shouldPreserveVisibleContent,
                    );
                    return;
                }
            }
            try {
                await renderInitialLoadedPage(plan, reloadTransactionId);
                if (!isActiveLoadedDocument(activeLoadToken, loaded.version)) {
                    releasePlanPreservedVisualSnapshotNow(plan, 'initial-render-superseded');
                    settleVisualReloadTransition('initial-render-superseded');
                    reloadCancellation = createReloadCancellation(
                        'superseded',
                        plan.shouldPreserveVisibleContent,
                    );
                    return;
                }
                if (
                    !plan.shouldPreserveVisibleContent
                    && !plan.isSelectiveReload
                    && isReload
                    && options.currentPage.value > 1
                ) {
                    // Crop and other geometry-changing reloads can shift placeholder
                    // offsets enough that the pre-render jump lands on the wrong page.
                    // Re-apply the intended page target once the first real page render
                    // has stabilized layout, then sync currentPage from that viewport.
                    applyReloadViewport(options.currentPage.value);
                    await nextTick();
                    if (!isActiveLoadedDocument(activeLoadToken, loaded.version)) {
                        releasePlanPreservedVisualSnapshotNow(plan, 'post-render-scroll-superseded');
                        settleVisualReloadTransition('post-render-scroll-superseded');
                        reloadCancellation = createReloadCancellation(
                            'superseded',
                            plan.shouldPreserveVisibleContent,
                        );
                        return;
                    }
                    if (!commitReloadViewportVisibleRange(reloadTransactionId)) {
                        releasePlanPreservedVisualSnapshotNow(plan, 'post-render-range-superseded');
                        settleVisualReloadTransition('post-render-range-superseded');
                        reloadCancellation = createReloadCancellation(
                            'superseded',
                            plan.shouldPreserveVisibleContent,
                        );
                        return;
                    }
                }
                if (plan.shouldPinReloadPage) {
                    if (!pinCurrentPageToRestoreTarget(plan, reloadTransactionId)) {
                        releasePlanPreservedVisualSnapshotNow(plan, 'pin-current-page-superseded');
                        settleVisualReloadTransition('pin-current-page-superseded');
                        reloadCancellation = createReloadCancellation(
                            'superseded',
                            plan.shouldPreserveVisibleContent,
                        );
                        return;
                    }
                } else {
                    await options.syncCurrentPageFromViewport({ source: 'load-from-source' });
                    if (!isActiveLoadedDocument(activeLoadToken, loaded.version)) {
                        releasePlanPreservedVisualSnapshotNow(plan, 'current-page-sync-superseded');
                        settleVisualReloadTransition('current-page-sync-superseded');
                        reloadCancellation = createReloadCancellation(
                            'superseded',
                            plan.shouldPreserveVisibleContent,
                        );
                        return;
                    }
                }
            } catch (error) {
                initialRenderError = error;
                releasePlanPreservedVisualSnapshotNow(plan, 'initial-render-error');
                settleVisualReloadTransition('initial-render-error');
                reloadCancellation = createReloadCancellation(
                    'reload',
                    plan.shouldPreserveVisibleContent,
                );
                logAsyncStageError('render visible pages after source load', error);
            }
            settleTransferredToFinish = finishLoadedSource(
                plan,
                activeLoadToken,
                loaded.version,
                reloadTransactionId,
                visualReload,
                settleVisualReloadTransition,
                initialRenderError,
            );
        } finally {
            if (!settleTransferredToFinish) {
                cancelReloadTransaction(
                    reloadTransactionId,
                    reloadCancellation ?? createReloadCancellation(
                        'reload',
                        activeReloadPlan?.shouldPreserveVisibleContent ?? false,
                    ),
                );
                settleDocumentLoad(activeLoadToken);
            }
        }
    }

    function scheduleLoadFromSource(isReload = false) {
        const activeScheduledLoadToken = scheduledLoadToken;
        runGuardedTask(async () => {
            if (activeScheduledLoadToken !== scheduledLoadToken) {
                return;
            }
            await loadFromSource(isReload);
        }, {
            category: 'user-visible-operation',
            scope: 'pdf-viewer',
            message: 'Failed to load PDF source',
        });
    }

    function preserveNextSourceReloadVisibleContent(request?: IPreservedVisibleContentRequest) {
        shouldPreserveNextSourceReloadVisibleContent = true;
        nextPreservedVisibleContentState = capturePreservedVisibleContentState(request);
    }

    return {
        isLoadFromSourceActive: readonly(isLoadFromSourceActive),
        invalidateDocumentLoad,
        preserveNextSourceReloadVisibleContent,
        scheduleLoadFromSource,
    };
};
