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

    async function recoverInitialRenderIfNeeded() {
        if (!options.pdfDocument.value || options.isLoading.value || options.numPages.value <= 0) {
            return;
        }
        if (hasRenderedPageCanvas() || hasRenderedTextLayerContent()) {
            return;
        }
        await nextTick();
        await delay(40);
        if (hasRenderedPageCanvas() || hasRenderedTextLayerContent()) {
            return;
        }

        options.updateVisibleRange(options.viewerContainer.value, options.numPages.value);
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
        if (hasRenderedPageCanvas() || hasRenderedTextLayerContent()) {
            return;
        }

        options.updateVisibleRange(options.viewerContainer.value, options.numPages.value);
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

    async function loadFromSource(isReload = false) {
        if (!options.src.value) {
            options.commentSync.incrementSyncToken();
            options.annotationCommentsCache.value = [];
            options.activeCommentStableKey.value = null;
            options.emit('annotation-comments', []);
            return;
        }

        const activeLoadToken = ++documentLoadToken;
        options.onDocumentLoadStateChange?.({
            token: activeLoadToken,
            phase: 'started',
        });

        try {
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
            const visualReloadTransitionToken = shouldPinReloadPage
                ? options.beginVisualReloadTransition('reload-recovery')
                : null;
            let visualReloadTransitionHandledByWarmRender = false;
            let visualReloadTransitionSettled = false;

            const settleVisualReloadTransition = (reason: string) => {
                if (visualReloadTransitionToken === null || visualReloadTransitionSettled) {
                    return;
                }

                visualReloadTransitionSettled = true;
                options.endVisualReloadTransition(visualReloadTransitionToken, reason);
            };

            if (shouldPinReloadPage) {
                // Geometry-changing reloads can briefly report a stale viewport page
                // while placeholders, resize observers, and buffered renders settle.
                options.pinCurrentPageDuringRecovery(resolvedPageToRestore, {
                    durationMs: 900,
                    reason: 'reload-recovery',
                });
            }

            const savedBaseWidth = isSelectiveReload ? options.basePageWidth.value : null;
            const savedBaseHeight = isSelectiveReload ? options.basePageHeight.value : null;
            const savedVisibleRange = isSelectiveReload
                ? { ...options.visibleRange.value }
                : null;

            options.emit('update:document', null);
            if (!isReload) options.emit('update:totalPages', 0);
            options.emit('update:currentPage', pageToRestore);

            if (isSelectiveReload && pagesToInvalidate) {
                options.invalidateRenderedPages(pagesToInvalidate);
            } else {
                options.cleanupRenderedPages();
                if (shouldPreserveReloadDisplayZoom) {
                    options.invalidateScaleCache();
                } else {
                    options.resetScale();
                }
                options.resetInsets();
                options.currentPage.value = pageToRestore;
                options.visibleRange.value = {
                    start: pageToRestore,
                    end: pageToRestore,
                };
            }
            options.editor.destroyAnnotationEditor();

            const loaded = await options.loadPdf(
                options.src.value,
                isSelectiveReload ? { preservePageStructure: true } : undefined,
            );
            if (!loaded) {
                settleVisualReloadTransition('load-aborted');
                return;
            }

            if (
                isSelectiveReload &&
                savedBaseWidth !== null &&
                savedBaseHeight !== null
            ) {
                options.basePageWidth.value = savedBaseWidth;
                options.basePageHeight.value = savedBaseHeight;
            }

            options.emit('update:document', options.pdfDocument.value);
            options.editor.initAnnotationEditor();

            options.currentPage.value = Math.min(resolvedPageToRestore, options.numPages.value);
            options.emit('update:totalPages', options.numPages.value);
            options.emit('update:currentPage', options.currentPage.value);
            const metricHydrationStartPage = isReload && !isSelectiveReload && options.currentPage.value > 1
                ? 1
                : options.currentPage.value;
            await options.ensurePageMetricsInRange(
                metricHydrationStartPage,
                options.currentPage.value,
            );

            if (!isSelectiveReload) {
                runGuardedTask(
                    async () => {
                        const firstPage = await options.getPage(1);
                        await options.computeSkeletonInsets(
                            firstPage,
                            loaded.version,
                            options.getRenderVersion,
                        );
                    },
                    {
                        scope: 'pdf-viewer',
                        message: 'Failed to compute PDF skeleton insets',
                    },
                );
            }

            await nextTick();
            await options.beforeInitialRender?.();

            if (!isSelectiveReload) {
                options.computeFitWidthScale(options.viewerContainer.value);
                if (displayZoomToRestore !== null) {
                    const nextZoom = resolveCustomReloadZoomMultiplier({
                        currentZoom: options.zoom.value,
                        currentEffectiveScale: options.effectiveScale.value,
                        targetDisplayZoom: displayZoomToRestore,
                    });
                    if (nextZoom !== null && Math.abs(nextZoom - options.zoom.value) > 0.001) {
                        options.suppressNextZoomRerender(nextZoom);
                        options.emit('update:zoom', nextZoom);
                        await waitForZoomPropSync(nextZoom);
                    }
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
                if (!isSelectiveReload && isReload && options.currentPage.value > 1) {
                    // Crop and other geometry-changing reloads can shift placeholder
                    // offsets enough that the pre-render jump lands on the wrong page.
                    // Re-apply the intended page target once the first real page render
                    // has stabilized layout, then sync currentPage from that viewport.
                    options.scrollToPage(options.currentPage.value);
                    await nextTick();
                    options.updateVisibleRange(options.viewerContainer.value, options.numPages.value);
                }
                if (shouldPinReloadPage) {
                    options.currentPage.value = Math.min(resolvedPageToRestore, options.numPages.value);
                    options.emit('update:currentPage', options.currentPage.value);
                } else {
                    await options.syncCurrentPageFromViewport({ source: 'load-from-source' });
                }
            } catch (error) {
                settleVisualReloadTransition('initial-render-error');
                logAsyncStageError('render visible pages after source load', error);
            }
            if (visualReloadTransitionToken !== null) {
                visualReloadTransitionHandledByWarmRender = true;
            }
            runGuardedTask(
                async () => {
                    try {
                        await options.renderVisiblePages(options.getVisibleRange());
                        if (!shouldPinReloadPage) {
                            return;
                        }

                        options.currentPage.value = Math.min(resolvedPageToRestore, options.numPages.value);
                        options.emit('update:currentPage', options.currentPage.value);
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
            options.applySearchHighlights();
            options.commentSync.scheduleAnnotationCommentsSync(true);
            scheduleRecoverInitialRender();

            if (!visualReloadTransitionHandledByWarmRender) {
                settleVisualReloadTransition('load-complete');
            }
        } finally {
            options.onDocumentLoadStateChange?.({
                token: activeLoadToken,
                phase: 'settled',
            });
        }
    }

    function scheduleLoadFromSource(isReload = false) {
        runGuardedTask(() => loadFromSource(isReload), {
            scope: 'pdf-viewer',
            message: 'Failed to load PDF source',
        });
    }

    return {
        scheduleRecoverInitialRender,
        scheduleLoadFromSource,
    };
}
