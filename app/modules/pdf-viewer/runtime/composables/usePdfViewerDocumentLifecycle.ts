import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import { delay } from 'es-toolkit/promise';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import { runGuardedTask } from '@app/utils/asyncGuard';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type {
    IPageRange,
    IScrollSnapshot,
    PDFDocumentProxy,
    PDFPageProxy,
    TPdfSource,
    TZoomMode,
} from '@app/types/pdf';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import { tracePdfAnnotationSaveDom } from '@app/modules/pdf-viewer/engine/pdf-annotation-save-trace/tracePdfAnnotationSaveDom';
import { tracePdfAnnotationSaveEvent } from '@app/modules/pdf-viewer/engine/pdf-annotation-save-trace/tracePdfAnnotationSaveEvent';
import { hasPdfPageAnnotationVisualContentForSnapshotRelease } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/hasPdfPageAnnotationVisualContentForSnapshotRelease';
import type { TPdfLayerVisualSnapshotRelease } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotRelease';
import { preservePdfPageAnnotationVisualSnapshot } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/preservePdfPageAnnotationVisualSnapshot';
import { schedulePdfLayerVisualSnapshotRelease } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/schedulePdfLayerVisualSnapshotRelease';
import { resolveCustomReloadZoomMultiplier } from '@app/modules/pdf-viewer/runtime/reload-zoom/resolveCustomReloadZoomMultiplier';


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

interface IPreservedScrollPosition {
    left: number;
    top: number;
}

interface IPreservedVisibleContentRequest {
    scrollSnapshot?: IScrollSnapshot | null;
    pageToRestore?: number | null;
}

interface IPreservedVisibleContentState {
    scrollPosition: IPreservedScrollPosition | null;
    pageToRestore: number | null;
    visualSnapshotRelease: TPdfLayerVisualSnapshotRelease | null;
}

interface ICommentSyncLike {
    incrementSyncToken: () => void;
    scheduleAnnotationCommentsSync: (immediate?: boolean) => void;
}

interface IAnnotationEditorLike {
    destroyAnnotationEditor: () => void;
    initAnnotationEditor: () => void;
}

interface IUsePdfViewerDocumentLifecycleOptions {
    viewerContainer: Ref<HTMLElement | null>;
    src: ComputedRef<TPdfSource | null>;
    zoom: ComputedRef<number>;
    zoomMode: ComputedRef<TZoomMode>;
    effectiveScale: Ref<number>;
    currentPage: Ref<number>;
    visibleRange: Ref<IPageRange>;
    basePageWidth: Ref<number | null>;
    basePageHeight: Ref<number | null>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>;
    activeCommentStableKey: Ref<string | null>;
    pdfDocument: Ref<PDFDocumentProxy | null>;
    numPages: Ref<number>;
    isLoading: Ref<boolean>;
    getRenderVersion: () => number;
    loadPdf: (
        src: TPdfSource,
        options?: { preservePageStructure?: boolean },
    ) => Promise<{version: number;} | null>;
    ensurePageMetricsInRange: (
        startPage: number,
        endPage: number,
    ) => Promise<boolean>;
    getPage: (pageNumber: number) => Promise<PDFPageProxy>;
    renderVisiblePages: (
        range: IPageRange,
        options?: {
            preserveRenderedPages?: boolean;
            bufferOverride?: number;
            forceRerender?: boolean;
        },
    ) => Promise<void>;
    getVisibleRange: () => IPageRange;
    reRenderVisiblePagesAndSyncCurrentPage: () => Promise<void>;
    syncCurrentPageFromViewport: (options?: {
        source?: string;
        stabilize?: boolean 
    }) => Promise<void>;
    applySearchHighlights: () => void;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    scrollToPage: (pageNumber: number, options?: IScrollToPageOptions) => void;
    cleanupRenderedPages: () => void;
    invalidateScaleCache: () => void;
    resetScale: () => void;
    resetInsets: () => void;
    setupPagePlaceholders: () => void;
    computeFitWidthScale: (container: HTMLElement | null) => boolean;
    computeSkeletonInsets: (
        pdfPage: PDFPageProxy,
        renderVersion: number,
        getCurrentVersion: () => number,
    ) => Promise<void>;
    beforeInitialRender?: (() => Promise<void>) | undefined;
    invalidateRenderedPages: (pages: number[]) => void;
    consumePendingInvalidation: () => number[] | null;
    commentSync: ICommentSyncLike;
    editor: IAnnotationEditorLike;
    pinCurrentPageDuringRecovery: (
        page: number,
        options?: {
            durationMs?: number;
            reason?: string;
        },
    ) => void;
    suppressNextZoomRerender: (targetZoom: number) => void;
    beginVisualReloadTransition: (reason: string) => number;
    endVisualReloadTransition: (token: number, reason: string) => void;
    onDocumentLoadStateChange?: ((payload: {
        token: number;
        phase: 'started' | 'settled';
    }) => void) | undefined;
    emit: {
        (e: 'update:totalPages', total: number): void;
        (e: 'update:currentPage', page: number): void;
        (e: 'update:document', document: PDFDocumentProxy | null): void;
        (e: 'annotation-comments', comments: IAnnotationCommentSummary[]): void;
        (e: 'update:zoom', value: number): void;
    };
}

export const usePdfViewerDocumentLifecycle = (options: IUsePdfViewerDocumentLifecycleOptions) => {
    let documentLoadToken = 0;
    let scheduledLoadToken = 0;
    const isLoadFromSourceActive = ref(false);
    let shouldPreserveNextSourceReloadVisibleContent = false;
    let nextPreservedVisibleContentState: IPreservedVisibleContentState | null = null;

    function hasRenderedPageCanvas() {
        const container = options.viewerContainer.value;
        if (!container) {
            return false;
        }
        return Boolean(
            container.querySelector('.page_container .page_canvas canvas'),
        );
    }

    function hasRenderedTextLayerContent() {
        const container = options.viewerContainer.value;
        if (!container) {
            return false;
        }
        return Boolean(
            container.querySelector(
                '.page_container .text-layer span, .page_container .textLayer span',
            ),
        );
    }

    function logAsyncStageError(stage: string, error: unknown) {
        BrowserLogger.error('pdf-viewer', `Failed to ${stage}`, error);
    }

    function hasRenderedInitialContent() {
        return hasRenderedPageCanvas() || hasRenderedTextLayerContent();
    }

    function refreshVisibleRangeForRecovery() {
        options.computeFitWidthScale(options.viewerContainer.value);
        options.updateVisibleRange(options.viewerContainer.value, options.numPages.value);
    }

    async function recoverInitialRenderIfNeeded() {
        if (!options.pdfDocument.value || options.isLoading.value || options.numPages.value <= 0) {
            return;
        }
        if (hasRenderedInitialContent()) {
            return;
        }
        await nextTick();
        await delay(40);
        if (hasRenderedInitialContent()) {
            return;
        }

        refreshVisibleRangeForRecovery();
        try {
            await options.reRenderVisiblePagesAndSyncCurrentPage();
        } catch (error) {
            logAsyncStageError(
                're-render visible pages during initial recovery',
                error,
            );
        }

        await nextTick();
        await delay(80);
        if (hasRenderedInitialContent()) {
            return;
        }

        refreshVisibleRangeForRecovery();
        try {
            await options.renderVisiblePages(options.getVisibleRange());
            await options.syncCurrentPageFromViewport({ source: 'recover-initial-render' });
        } catch (error) {
            logAsyncStageError('render visible pages during initial recovery', error);
        }
    }

    function scheduleRecoverInitialRender() {
        runGuardedTask(() => recoverInitialRenderIfNeeded(), {
            scope: 'pdf-viewer',
            message: 'Failed to recover initial PDF render',
        });
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
        options.annotationCommentsCache.value = [];
        options.activeCommentStableKey.value = null;
        options.emit('annotation-comments', []);
    }

    function normalizePreservedPageNumber(value: number | null | undefined) {
        return typeof value === 'number' && Number.isFinite(value)
            ? Math.max(1, Math.floor(value))
            : null;
    }

    function asHtmlElement(value: Element | null | undefined) {
        if (!value) {
            return null;
        }
        if (typeof HTMLElement === 'undefined') {
            return value as HTMLElement;
        }
        return value instanceof HTMLElement ? value : null;
    }

    function findPreservedPageContainer(pageNumber: number | null | undefined) {
        const container = options.viewerContainer.value;
        const normalizedPage = normalizePreservedPageNumber(pageNumber) ?? options.currentPage.value;
        return asHtmlElement(
            container?.querySelector(`.page_container[data-page="${normalizedPage}"]`),
        );
    }

    function createTracedPreservedVisualSnapshotRelease(
        release: TPdfLayerVisualSnapshotRelease | null,
        pageNumber: number | null,
        pageContainer: HTMLElement | null,
    ) {
        if (!release) {
            return null;
        }

        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            tracePdfAnnotationSaveDom(
                'document-lifecycle:preserved-visual-snapshot:release',
                pageContainer,
                { pageNumber },
            );
            release();
        };
    }

    function capturePreservedVisualSnapshot(pageNumber: number | null) {
        const snapshotPage = normalizePreservedPageNumber(pageNumber) ?? options.currentPage.value;
        const pageContainer = findPreservedPageContainer(snapshotPage);
        const release = createTracedPreservedVisualSnapshotRelease(
            preservePdfPageAnnotationVisualSnapshot(pageContainer, null),
            snapshotPage,
            pageContainer,
        );
        tracePdfAnnotationSaveDom(
            'document-lifecycle:preserved-visual-snapshot:capture',
            pageContainer,
            {
                hasSnapshot: Boolean(release),
                pageNumber: snapshotPage,
            },
        );
        schedulePdfLayerVisualSnapshotRelease(release, {
            maxDelayMs: 15_000,
            minFrames: 1,
            waitFor: () => false,
        });
        return release;
    }

    function releasePreservedVisualSnapshotNow(
        state: IPreservedVisibleContentState | null,
        reason: string,
    ) {
        if (!state?.visualSnapshotRelease) {
            return;
        }
        tracePdfAnnotationSaveEvent(
            'document-lifecycle:preserved-visual-snapshot:release-now',
            {
                pageNumber: state.pageToRestore,
                reason,
            },
        );
        state.visualSnapshotRelease();
        state.visualSnapshotRelease = null;
    }

    function schedulePreservedVisualSnapshotRelease(
        plan: IReloadPlan,
        reason: string,
    ) {
        const state = plan.preservedVisibleContent;
        if (!state?.visualSnapshotRelease) {
            return;
        }

        const release = state.visualSnapshotRelease;
        state.visualSnapshotRelease = null;
        const pageNumber = plan.resolvedPageToRestore;
        tracePdfAnnotationSaveDom(
            'document-lifecycle:preserved-visual-snapshot:schedule-release',
            findPreservedPageContainer(pageNumber),
            {
                pageNumber,
                reason,
            },
        );
        schedulePdfLayerVisualSnapshotRelease(release, {
            maxDelayMs: 2_500,
            minFrames: 1,
            waitFor: () => hasPdfPageAnnotationVisualContentForSnapshotRelease(
                findPreservedPageContainer(pageNumber),
            ),
        });
    }

    function capturePreservedVisibleContentState(
        request?: IPreservedVisibleContentRequest,
    ): IPreservedVisibleContentState {
        const container = options.viewerContainer.value;
        const requestPage = normalizePreservedPageNumber(request?.pageToRestore);
        const snapshotPage = normalizePreservedPageNumber(request?.scrollSnapshot?.anchorPage);
        const pageToRestore = requestPage ?? snapshotPage ?? options.currentPage.value;
        return {
            scrollPosition: container
                ? {
                    left: container.scrollLeft,
                    top: container.scrollTop,
                }
                : null,
            pageToRestore,
            visualSnapshotRelease: capturePreservedVisualSnapshot(pageToRestore),
        };
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

    function applyPreLoadStateReset(plan: IReloadPlan, isReload: boolean) {
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
            options.currentPage.value = plan.pageToRestore;
        } else {
            options.cleanupRenderedPages();
            if (isReload || plan.shouldPreserveReloadDisplayZoom) {
                options.invalidateScaleCache();
            } else {
                options.resetScale();
            }
            options.resetInsets();
            options.currentPage.value = plan.pageToRestore;
            options.visibleRange.value = {
                start: plan.pageToRestore,
                end: plan.pageToRestore,
            };
        }
        if (!plan.shouldPreserveVisibleContent) {
            options.editor.destroyAnnotationEditor();
        }
    }

    function cleanupPreservedVisibleContentAfterLoadFailure(plan: IReloadPlan) {
        if (!plan.shouldPreserveVisibleContent) {
            return;
        }

        options.emit('update:document', null);
        options.cleanupRenderedPages();
        options.editor.destroyAnnotationEditor();
        options.resetInsets();
        options.visibleRange.value = {
            start: plan.pageToRestore,
            end: plan.pageToRestore,
        };
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

    function applyPostLoadDocumentMetadata(plan: IReloadPlan) {
        options.emit('update:document', options.pdfDocument.value);
        options.editor.initAnnotationEditor();

        options.currentPage.value = Math.min(plan.resolvedPageToRestore, options.numPages.value);
        options.emit('update:totalPages', options.numPages.value);
        options.emit('update:currentPage', options.currentPage.value);
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
                scope: 'pdf-viewer',
                message: 'Failed to compute PDF skeleton insets',
            },
        );
    }

    function schedulePostInitialLoadWork(
        activeLoadToken: number,
        documentVersion: number,
        optionsToSchedule: {
            computeSkeletonInsets?: boolean;
            recoverInitialRender?: boolean;
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
                options.commentSync.scheduleAnnotationCommentsSync(true);
                if (optionsToSchedule.recoverInitialRender) {
                    scheduleRecoverInitialRender();
                }
            },
            {
                scope: 'pdf-viewer',
                message: 'Failed to run deferred PDF load work',
            },
        );
    }

    function pinCurrentPageToRestoreTarget(plan: IReloadPlan) {
        options.currentPage.value = Math.min(plan.resolvedPageToRestore, options.numPages.value);
        options.emit('update:currentPage', options.currentPage.value);
    }

    function scheduleWarmBufferedRender(
        plan: IReloadPlan,
        activeLoadToken: number,
        documentVersion: number,
        settleVisualReloadTransition: (reason: string) => void,
        settleDocumentLoadAfterRender: boolean,
    ) {
        runGuardedTask(
            async () => {
                try {
                    if (!isActiveLoadedDocument(activeLoadToken, documentVersion)) {
                        return;
                    }
                    if (plan.shouldPreserveVisibleContent) {
                        pinCurrentPageToRestoreTarget(plan);
                        return;
                    }
                    await options.renderVisiblePages(options.getVisibleRange());
                    if (!isActiveLoadedDocument(activeLoadToken, documentVersion)) {
                        return;
                    }
                    if (!plan.shouldPinReloadPage) {
                        return;
                    }

                    pinCurrentPageToRestoreTarget(plan);
                    options.scrollToPage(options.currentPage.value);
                    await nextTick();
                    options.updateVisibleRange(options.viewerContainer.value, options.numPages.value);
                } finally {
                    settleVisualReloadTransition('warm-render-complete');
                    if (settleDocumentLoadAfterRender) {
                        settleDocumentLoad(activeLoadToken);
                    }
                }
            },
            {
                scope: 'pdf-viewer',
                message: 'Failed to warm buffered PDF pages after initial render',
            },
        );
    }

    function startDocumentLoad() {
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
        scheduledLoadToken += 1;
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
            durationMs: 900,
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

    function loadPdfForPlan(plan: IReloadPlan) {
        return options.loadPdf(
            options.src.value as TPdfSource,
            plan.isSelectiveReload || plan.shouldPreserveVisibleContent
                ? { preservePageStructure: true }
                : undefined,
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
        visualReload: IVisualReloadTransition,
        settleVisualReloadTransition: (reason: string) => void,
    ) {
        if (plan.shouldPreserveVisibleContent) {
            settleVisualReloadTransition('preserved-load-complete');
            settleDocumentLoad(activeLoadToken);
            schedulePostInitialLoadWork(activeLoadToken, documentVersion);
            return true;
        }

        const visualReloadTransitionHandledByWarmRender = visualReload.token !== null;
        settleDocumentLoad(activeLoadToken);
        scheduleWarmBufferedRender(
            plan,
            activeLoadToken,
            documentVersion,
            settleVisualReloadTransition,
            false,
        );
        schedulePostInitialLoadWork(activeLoadToken, documentVersion, {
            computeSkeletonInsets: !plan.isSelectiveReload,
            recoverInitialRender: true,
        });

        if (!visualReloadTransitionHandledByWarmRender) {
            settleVisualReloadTransition('load-complete');
        }

        return true;
    }

    function capturePreservedScrollPosition(plan: IReloadPlan): IPreservedScrollPosition | null {
        if (!plan.shouldPreserveVisibleContent) {
            return null;
        }

        return plan.preservedVisibleContent?.scrollPosition ?? null;
    }

    function restorePreservedScrollPosition(
        plan: IReloadPlan,
        position: IPreservedScrollPosition | null,
    ) {
        if (!plan.shouldPreserveVisibleContent || !position) {
            return;
        }

        const container = options.viewerContainer.value;
        if (!container) {
            return;
        }

        container.scrollLeft = position.left;
        container.scrollTop = position.top;
    }

    async function renderInitialLoadedPage(
        plan: IReloadPlan,
        preservedScrollPosition: IPreservedScrollPosition | null,
    ) {
        const initialRange = {
            start: options.currentPage.value,
            end: options.currentPage.value,
        } satisfies IPageRange;

        if (plan.shouldPreserveVisibleContent) {
            restorePreservedScrollPosition(plan, preservedScrollPosition);
            const currentPageContainer = options.viewerContainer.value
                ?.querySelector<HTMLElement>(`.page_container[data-page="${options.currentPage.value}"]`);
            tracePdfAnnotationSaveDom(
                'document-lifecycle:preserved-render-visible:start',
                currentPageContainer,
                { pageNumber: options.currentPage.value },
            );
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
            restorePreservedScrollPosition(plan, preservedScrollPosition);
            schedulePreservedVisualSnapshotRelease(plan, 'preserved-render-visible-done');
            return;
        }

        await options.renderVisiblePages(initialRange, { bufferOverride: 0 });
    }

    async function reconcileFreshDocumentViewport(
        plan: IReloadPlan,
        activeLoadToken: number,
        loadedVersion: number,
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

        options.scrollToPage(plan.resolvedPageToRestore);
        options.updateVisibleRange(options.viewerContainer.value, options.numPages.value);
        return true;
    }

    async function loadFromSource(isReload = false) {
        if (!options.src.value) {
            releasePreservedVisualSnapshotNow(nextPreservedVisibleContentState, 'empty-source');
            shouldPreserveNextSourceReloadVisibleContent = false;
            nextPreservedVisibleContentState = null;
            clearAnnotationCacheForEmptySource();
            return;
        }

        const activeLoadToken = startDocumentLoad();
        let settleTransferredToFinish = false;

        try {
            const plan = computeReloadPlan(isReload);
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
            const preservedScrollPosition = capturePreservedScrollPosition(plan);

            pinReloadRecoveryPageIfNeeded(plan);
            const {
                savedBaseWidth,
                savedBaseHeight,
                savedVisibleRange,
            } = captureSelectiveReloadState(plan);

            applyPreLoadStateReset(plan, isReload);

            const loaded = await loadPdfForPlan(plan);
            if (!isDocumentLoadActive(activeLoadToken)) {
                settleVisualReloadTransition('load-superseded');
                return;
            }
            if (!loaded) {
                cleanupPreservedVisibleContentAfterLoadFailure(plan);
                settleVisualReloadTransition('load-aborted');
                return;
            }
            if (!isLoadedDocumentVersionActive(loaded.version)) {
                settleVisualReloadTransition('load-version-superseded');
                return;
            }

            restoreSelectiveReloadBaseDimensions(plan, savedBaseWidth, savedBaseHeight);
            applyPostLoadDocumentMetadata(plan);
            restorePreservedScrollPosition(plan, preservedScrollPosition);
            if (!plan.shouldPreserveVisibleContent) {
                await options.ensurePageMetricsInRange(
                    resolveMetricHydrationStartPage(plan, isReload),
                    options.currentPage.value,
                );
                if (!isActiveLoadedDocument(activeLoadToken, loaded.version)) {
                    settleVisualReloadTransition('metric-prime-superseded');
                    return;
                }
            }

            await nextTick();
            restorePreservedScrollPosition(plan, preservedScrollPosition);
            await options.beforeInitialRender?.();
            if (!isActiveLoadedDocument(activeLoadToken, loaded.version)) {
                settleVisualReloadTransition('before-initial-render-superseded');
                return;
            }

            if (!plan.isSelectiveReload && !plan.shouldPreserveVisibleContent) {
                options.computeFitWidthScale(options.viewerContainer.value);
                const nextZoom = resolveCustomReloadZoomToApply(plan);
                if (nextZoom !== null && Math.abs(nextZoom - options.zoom.value) > 0.001) {
                    options.suppressNextZoomRerender(nextZoom);
                    options.emit('update:zoom', nextZoom);
                    await waitForZoomPropSync(nextZoom);
                    if (!isActiveLoadedDocument(activeLoadToken, loaded.version)) {
                        settleVisualReloadTransition('zoom-sync-superseded');
                        return;
                    }
                }
                options.setupPagePlaceholders();
                if (!isReload) {
                    const reconciled = await reconcileFreshDocumentViewport(
                        plan,
                        activeLoadToken,
                        loaded.version,
                    );
                    if (!reconciled) {
                        settleVisualReloadTransition('fresh-scroll-superseded');
                        return;
                    }
                }
                if (isReload && options.currentPage.value > 1) {
                    options.scrollToPage(options.currentPage.value);
                    await nextTick();
                    if (!isActiveLoadedDocument(activeLoadToken, loaded.version)) {
                        settleVisualReloadTransition('restore-scroll-superseded');
                        return;
                    }
                }
            } else if (savedVisibleRange) {
                options.visibleRange.value = savedVisibleRange;
            }

            if (!plan.shouldPreserveVisibleContent) {
                options.updateVisibleRange(options.viewerContainer.value, options.numPages.value);
            }
            try {
                await renderInitialLoadedPage(plan, preservedScrollPosition);
                if (!isActiveLoadedDocument(activeLoadToken, loaded.version)) {
                    settleVisualReloadTransition('initial-render-superseded');
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
                    options.scrollToPage(options.currentPage.value);
                    await nextTick();
                    if (!isActiveLoadedDocument(activeLoadToken, loaded.version)) {
                        settleVisualReloadTransition('post-render-scroll-superseded');
                        return;
                    }
                    options.updateVisibleRange(options.viewerContainer.value, options.numPages.value);
                }
                if (plan.shouldPinReloadPage) {
                    pinCurrentPageToRestoreTarget(plan);
                } else {
                    await options.syncCurrentPageFromViewport({ source: 'load-from-source' });
                    if (!isActiveLoadedDocument(activeLoadToken, loaded.version)) {
                        settleVisualReloadTransition('current-page-sync-superseded');
                        return;
                    }
                }
            } catch (error) {
                settleVisualReloadTransition('initial-render-error');
                logAsyncStageError('render visible pages after source load', error);
            }
            settleTransferredToFinish = finishLoadedSource(
                plan,
                activeLoadToken,
                loaded.version,
                visualReload,
                settleVisualReloadTransition,
            );
        } finally {
            if (!settleTransferredToFinish) {
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
        scheduleRecoverInitialRender,
        scheduleLoadFromSource,
    };
};
