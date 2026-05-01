import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import { delay } from 'es-toolkit/promise';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import { runGuardedTask } from '@app/utils/async-guard';
import { BrowserLogger } from '@app/utils/browser-logger';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type {
    PDFDocumentProxy,
    PDFPageProxy,
    TPdfSource,
    TZoomMode,
} from '@app/types/pdf';
import { resolveCustomReloadZoomMultiplier } from '@app/modules/pdf-viewer-runtime/reloadZoom';

interface IPageRange {
    start: number;
    end: number;
}

interface IReloadPlan {
    pageToRestore: number;
    resolvedPageToRestore: number;
    displayZoomToRestore: number | null;
    pagesToInvalidate: number[] | null;
    isSelectiveReload: boolean;
    shouldPreserveReloadDisplayZoom: boolean;
    shouldPinReloadPage: boolean;
}

interface IVisualReloadTransition {
    token: number | null;
    settle: (reason: string) => void;
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
    scrollToPage: (pageNumber: number, options?: { preferExactDom?: boolean }) => void;
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
    beforeInitialRender?: () => Promise<void>;
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
    onDocumentLoadStateChange?: (payload: {
        token: number;
        phase: 'started' | 'settled';
    }) => void;
    emit: {
        (e: 'update:totalPages', total: number): void;
        (e: 'update:currentPage', page: number): void;
        (e: 'update:document', document: PDFDocumentProxy | null): void;
        (e: 'annotation-comments', comments: IAnnotationCommentSummary[]): void;
        (e: 'update:zoom', value: number): void;
    };
}

export function usePdfViewerDocumentLifecycle(options: IUsePdfViewerDocumentLifecycleOptions) {
    let documentLoadToken = 0;
    const isLoadFromSourceActive = ref(false);

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

        BrowserLogger.warn('pdf-nav', '[load-from-source] zoom restore did not sync before render', {
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

    function computeReloadPlan(isReload: boolean): IReloadPlan {
        const pageToRestore = isReload ? options.currentPage.value : 1;
        const resolvedPageToRestore = Math.max(1, Math.floor(pageToRestore));
        const displayZoomToRestore = isReload && options.zoomMode.value === 'custom'
            ? options.effectiveScale.value
            : null;
        const pagesToInvalidate = options.consumePendingInvalidation();
        const isSelectiveReload = isReload && pagesToInvalidate !== null;
        const shouldPreserveReloadDisplayZoom = isReload
            && !isSelectiveReload
            && displayZoomToRestore !== null;
        const shouldPinReloadPage = isReload && !isSelectiveReload && resolvedPageToRestore > 1;
        return {
            pageToRestore,
            resolvedPageToRestore,
            displayZoomToRestore,
            pagesToInvalidate,
            isSelectiveReload,
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
        options.emit('update:document', null);
        if (!isReload) options.emit('update:totalPages', 0);
        options.emit('update:currentPage', plan.pageToRestore);

        if (plan.isSelectiveReload && plan.pagesToInvalidate) {
            options.invalidateRenderedPages(plan.pagesToInvalidate);
        } else {
            options.cleanupRenderedPages();
            if (plan.shouldPreserveReloadDisplayZoom) {
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
        options.editor.destroyAnnotationEditor();
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

    function pinCurrentPageToRestoreTarget(plan: IReloadPlan) {
        options.currentPage.value = Math.min(plan.resolvedPageToRestore, options.numPages.value);
        options.emit('update:currentPage', options.currentPage.value);
    }

    function scheduleWarmBufferedRender(
        plan: IReloadPlan,
        settleVisualReloadTransition: (reason: string) => void,
    ) {
        runGuardedTask(
            async () => {
                try {
                    await options.renderVisiblePages(options.getVisibleRange());
                    if (!plan.shouldPinReloadPage) {
                        return;
                    }

                    pinCurrentPageToRestoreTarget(plan);
                    options.scrollToPage(options.currentPage.value);
                    await nextTick();
                    options.updateVisibleRange(options.viewerContainer.value, options.numPages.value);
                } finally {
                    settleVisualReloadTransition('warm-render-complete');
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

    function settleDocumentLoad(token: number) {
        isLoadFromSourceActive.value = false;
        options.onDocumentLoadStateChange?.({
            token,
            phase: 'settled',
        });
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
            plan.isSelectiveReload ? { preservePageStructure: true } : undefined,
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
        visualReload: IVisualReloadTransition,
        settleVisualReloadTransition: (reason: string) => void,
    ) {
        const visualReloadTransitionHandledByWarmRender = visualReload.token !== null;
        scheduleWarmBufferedRender(plan, settleVisualReloadTransition);
        options.applySearchHighlights();
        options.commentSync.scheduleAnnotationCommentsSync(true);
        scheduleRecoverInitialRender();

        if (!visualReloadTransitionHandledByWarmRender) {
            settleVisualReloadTransition('load-complete');
        }
    }

    async function loadFromSource(isReload = false) {
        if (!options.src.value) {
            clearAnnotationCacheForEmptySource();
            return;
        }

        const activeLoadToken = startDocumentLoad();

        try {
            const plan = computeReloadPlan(isReload);
            const visualReload = createVisualReloadTransition(plan.shouldPinReloadPage);
            const settleVisualReloadTransition = visualReload.settle;

            pinReloadRecoveryPageIfNeeded(plan);
            const {
                savedBaseWidth,
                savedBaseHeight,
                savedVisibleRange,
            } = captureSelectiveReloadState(plan);

            applyPreLoadStateReset(plan, isReload);

            const loaded = await loadPdfForPlan(plan);
            if (!loaded) {
                settleVisualReloadTransition('load-aborted');
                return;
            }

            restoreSelectiveReloadBaseDimensions(plan, savedBaseWidth, savedBaseHeight);
            applyPostLoadDocumentMetadata(plan);
            await options.ensurePageMetricsInRange(
                resolveMetricHydrationStartPage(plan, isReload),
                options.currentPage.value,
            );

            if (!plan.isSelectiveReload) {
                scheduleSkeletonInsetsCompute(loaded.version);
            }

            await nextTick();
            await options.beforeInitialRender?.();

            if (!plan.isSelectiveReload) {
                options.computeFitWidthScale(options.viewerContainer.value);
                const nextZoom = resolveCustomReloadZoomToApply(plan);
                if (nextZoom !== null && Math.abs(nextZoom - options.zoom.value) > 0.001) {
                    options.suppressNextZoomRerender(nextZoom);
                    options.emit('update:zoom', nextZoom);
                    await waitForZoomPropSync(nextZoom);
                }
                options.setupPagePlaceholders();
                if (isReload && options.currentPage.value > 1) {
                    options.scrollToPage(options.currentPage.value);
                    await nextTick();
                }
            } else if (savedVisibleRange) {
                options.visibleRange.value = savedVisibleRange;
            }

            options.updateVisibleRange(options.viewerContainer.value, options.numPages.value);
            try {
                const initialRange = {
                    start: options.currentPage.value,
                    end: options.currentPage.value,
                } satisfies IPageRange;

                await options.renderVisiblePages(initialRange, { bufferOverride: 0 });
                if (!plan.isSelectiveReload && isReload && options.currentPage.value > 1) {
                    // Crop and other geometry-changing reloads can shift placeholder
                    // offsets enough that the pre-render jump lands on the wrong page.
                    // Re-apply the intended page target once the first real page render
                    // has stabilized layout, then sync currentPage from that viewport.
                    options.scrollToPage(options.currentPage.value);
                    await nextTick();
                    options.updateVisibleRange(options.viewerContainer.value, options.numPages.value);
                }
                if (plan.shouldPinReloadPage) {
                    pinCurrentPageToRestoreTarget(plan);
                } else {
                    await options.syncCurrentPageFromViewport({ source: 'load-from-source' });
                }
            } catch (error) {
                settleVisualReloadTransition('initial-render-error');
                logAsyncStageError('render visible pages after source load', error);
            }
            finishLoadedSource(plan, visualReload, settleVisualReloadTransition);
        } finally {
            settleDocumentLoad(activeLoadToken);
        }
    }

    function scheduleLoadFromSource(isReload = false) {
        runGuardedTask(() => loadFromSource(isReload), {
            scope: 'pdf-viewer',
            message: 'Failed to load PDF source',
        });
    }

    return {
        isLoadFromSourceActive: readonly(isLoadFromSourceActive),
        scheduleRecoverInitialRender,
        scheduleLoadFromSource,
    };
}
