import type {
    ComputedRef,
    Ref,
} from 'vue';
import { useDebounceFn } from '@vueuse/core';
import { clamp } from 'es-toolkit/math';
import type {
    PDFDocumentProxy,
    PDFPageProxy,
    RenderTask,
} from 'pdfjs-dist';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
} from '@app/types/annotations';
import { THUMBNAIL_WIDTH } from '@app/constants/pdfLayout';
import { createRenderTaskHiddenAnnotationOperationsFilter } from '@app/modules/pdf-viewer/engine/pdf-hidden-annotation-operations/createRenderTaskHiddenAnnotationOperationsFilter';
import { runCoordinatedPdfPageRender } from '@app/modules/pdf-viewer/engine/pdf-page-render-coordinator/coordinatedPdfPageRender';
import { AnnotationMode } from '@app/services/pdfjs/runtimeLib';
import {
    leasePdfDocumentPage,
    type IPdfDocumentPageLease,
} from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfDocument';
import { BrowserLogger } from '@app/utils/browserLogger';
import { runGuardedTask } from '@app/utils/asyncGuard';
import { isPdfDocumentUsable } from '@app/utils/isPdfDocumentUsable';
import { getPerformanceProfile } from '@app/utils/performanceProfile';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { buildThumbnailRenderQueue } from '@app/modules/pdf-viewer/thumbnails/buildThumbnailRenderQueue';
import { createThumbnailRenderState } from '@app/modules/pdf-viewer/thumbnails/createThumbnailRenderState';
import { isThumbnailRenderGenerationCurrent as isThumbnailRenderGenerationSnapshotCurrent } from '@app/modules/pdf-viewer/thumbnails/isThumbnailRenderGenerationCurrent';
import {
    buildThumbnailRenderTransform,
    resolveThumbnailRenderWidthFromStyles,
    roundMetric,
} from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailRenderMetrics';
import { drawEditedTextMarkupThumbnailVisuals } from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailTextMarkupVisuals';
import { resolveThumbnailItemHeightFromAspect } from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailLayout';
import { resolveThumbnailRenderConcurrency } from '@app/modules/pdf-viewer/thumbnails/resolveThumbnailRenderConcurrency';
import { resolveThumbnailRenderCoordination } from '@app/modules/pdf-viewer/thumbnails/resolveThumbnailRenderCoordination';
import {
    estimateCanvasSurfaceBytes,
    workspaceSurfaceBudgetController,
    type IWorkspaceSurfaceLease,
} from '@app/utils/document-viewer/workspaceSurfaceBudget';

export const PDF_THUMBNAIL_LOG_SECTION = 'pdf-thumbnails';
interface IPdfThumbnailRenderRuntimeSource {
    currentPage: ComputedRef<number>;
    invalidationRequest: ComputedRef<{
        id: number;
        pages: number[];
    } | null | undefined>;
    isActive: ComputedRef<boolean>;
    pdfDocument: ComputedRef<PDFDocumentProxy | null>;
    totalPages: ComputedRef<number>;
}
interface IPdfThumbnailRenderRuntimeVisuals {
    annotationSettings: ComputedRef<IAnnotationSettings | null | undefined>;
    editedTextMarkupComments: ComputedRef<IAnnotationCommentSummary[]>;
    editedTextMarkupVisualSignature: ComputedRef<string>;
    hiddenAnnotationIdSet: ComputedRef<Set<string>>;
    hiddenAnnotationIdsSignature: ComputedRef<string>;
}
interface IPdfThumbnailRenderRuntimeLayout {
    clearThumbnailAspectRatios: () => void;
    shouldPreferVisibleAnchorOverCurrentPage: () => boolean;
    resolveViewportAnchorPage: () => number | null;
    thumbnailAspectRatios: Ref<Array<number | null>>;
    thumbnailRenderWidth: Ref<number>;
    virtualPages: ComputedRef<number[]>;
    updateThumbnailAspectRatio: (page: number, aspectRatio: number | null) => void;
}
interface IPdfThumbnailRenderRuntimeDom {
    getCanvas: (page: number) => HTMLCanvasElement | null;
    resolveVisibleContainer: (reason: string) => HTMLElement | null;
}
interface IPdfThumbnailRenderRuntimeEffects {
    cancelActivePaneRefresh: () => void;
    measureThumbnailHeight: () => void | Promise<void>;
    onSourceCycleStarted: () => void;
    refreshVisibleThumbnailPane: (reason: string) => void | Promise<void>;
    resetMeasurementState: () => void;
    scheduleActivePaneRefresh: (reason: string) => void;
}
interface IUsePdfThumbnailRenderRuntimeOptions {
    dom: IPdfThumbnailRenderRuntimeDom;
    effects: IPdfThumbnailRenderRuntimeEffects;
    layout: IPdfThumbnailRenderRuntimeLayout;
    source: IPdfThumbnailRenderRuntimeSource;
    visuals: IPdfThumbnailRenderRuntimeVisuals;
}
const THUMBNAIL_RENDER_CONCURRENCY = getPerformanceProfile().thumbnailBaseConcurrency;

export function shouldPreserveThumbnailBitmap(canvas: Pick<HTMLCanvasElement, 'height' | 'width'>) {
    return canvas.width > 0 && canvas.height > 0;
}
const THUMBNAIL_NAVIGATION_CONCURRENCY_COOLDOWN_MS = 250;
const IMMEDIATE_RENDER_RADIUS = 2;
const PREFETCH_RENDER_RADIUS = 4;
const MAX_THUMBNAIL_OUTPUT_SCALE = 2;
let nextThumbnailSurfaceScopeId = 0;

export const usePdfThumbnailRenderRuntime = (options: IUsePdfThumbnailRenderRuntimeOptions) => {
    const {
        dom,
        effects,
        layout,
        source,
        visuals,
    } = options;
    const thumbnailRenderState = createThumbnailRenderState();
    const surfaceScopeId = `pdf-thumbnails:${++nextThumbnailSurfaceScopeId}`;
    const surfaceLeases = new WeakMap<HTMLCanvasElement, IWorkspaceSurfaceLease>();
    let renderRunId = 0;
    let pendingInvalidation: number[] | null = null;
    let reloadTransition = false;
    let lastNavigationAtMs = Number.NEGATIVE_INFINITY;

    const documentRenderEpoch = ref(0);
    const thumbnailKeySignal = ref(0);

    function getThumbnailRenderKey(page: number) {
        void thumbnailKeySignal.value;
        const pageEpoch = thumbnailRenderState.getPageRenderEpoch(page);
        const outputScale = resolveThumbnailOutputScale().toFixed(3);
        return [
            documentRenderEpoch.value,
            page,
            Math.round(layout.thumbnailRenderWidth.value),
            outputScale,
            pageEpoch,
            visuals.hiddenAnnotationIdsSignature.value,
            visuals.editedTextMarkupVisualSignature.value,
        ].join(':');
    }

    function isCanvasRendered(canvas: HTMLCanvasElement | null) {
        return canvas?.dataset.thumbnailRendered === 'true';
    }

    function isCanvasForRenderKey(canvas: HTMLCanvasElement | null, renderKey: string) {
        return canvas?.dataset.thumbnailRenderKey === renderKey;
    }

    function isCurrentThumbnailCanvasRendered(pageNum: number) {
        const canvas = dom.getCanvas(pageNum);
        if (!canvas) {
            return false;
        }
        const renderKey = getThumbnailRenderKey(pageNum);
        return thumbnailRenderState.isRenderedCanvas(pageNum, canvas)
            && isCanvasRendered(canvas)
            && isCanvasForRenderKey(canvas, renderKey);
    }

    function isCurrentThumbnailCanvasRendering(pageNum: number) {
        const canvas = dom.getCanvas(pageNum);
        if (!canvas) {
            return false;
        }
        const renderKey = getThumbnailRenderKey(pageNum);
        return thumbnailRenderState.isRenderingCanvasKey({
            page: pageNum,
            canvas,
            renderKey,
        });
    }

    function resolveThumbnailRenderWidth(container: HTMLElement) {
        const containerStyle = window.getComputedStyle(container);
        const thumbnail = container.querySelector<HTMLElement>('.pdf-thumbnail');
        const thumbnailStyle = thumbnail
            ? window.getComputedStyle(thumbnail)
            : null;
        return resolveThumbnailRenderWidthFromStyles({
            containerClientWidth: container.clientWidth,
            containerStyle,
            minWidth: THUMBNAIL_WIDTH,
            thumbnailStyle,
        });
    }

    function resolveThumbnailOutputScale() {
        if (typeof window === 'undefined' || window.devicePixelRatio <= 0) {
            return 1;
        }

        return Math.min(MAX_THUMBNAIL_OUTPUT_SCALE, window.devicePixelRatio);
    }

    function clearThumbnailCanvas(canvas: HTMLCanvasElement, renderKey: string | null = null) {
        surfaceLeases.get(canvas)?.release();
        surfaceLeases.delete(canvas);
        canvas.width = 0;
        canvas.height = 0;
        delete canvas.dataset.thumbnailRendered;
        delete canvas.dataset.thumbnailPreservedBitmap;
        if (renderKey) {
            canvas.dataset.thumbnailRenderKey = renderKey;
            return;
        }
        delete canvas.dataset.thumbnailRenderKey;
    }

    function clearVisibleThumbnailCanvases(pages: number[] | null = null) {
        const container = dom.resolveVisibleContainer('clear-visible-thumbnails');
        if (!container) {
            return;
        }

        const pageFilter = pages ? new Set(pages) : null;
        const thumbnails = container.querySelectorAll<HTMLElement>('.pdf-thumbnail');
        for (const thumbnail of thumbnails) {
            const page = Number(thumbnail.dataset.page);
            if (pageFilter && !pageFilter.has(page)) {
                continue;
            }
            const canvas = thumbnail.querySelector<HTMLCanvasElement>('canvas');
            if (canvas) {
                clearThumbnailCanvas(canvas, null);
            }
        }
    }

    function updateThumbnailAspectRatioForPage(
        page: number,
        viewportWidth: number,
        viewportHeightValue: number,
        reason: string,
        data: Record<string, unknown> = {},
    ) {
        if (
            page < 1
            || page > source.totalPages.value
            || viewportWidth <= 0
            || viewportHeightValue <= 0
        ) {
            return false;
        }

        const nextAspectRatio = viewportHeightValue / viewportWidth;
        if (!Number.isFinite(nextAspectRatio) || nextAspectRatio <= 0) {
            return false;
        }

        const previousAspectRatio = layout.thumbnailAspectRatios.value[page - 1] ?? null;
        if (previousAspectRatio !== null && Math.abs(previousAspectRatio - nextAspectRatio) < 0.001) {
            return false;
        }

        layout.updateThumbnailAspectRatio(page, nextAspectRatio);
        BrowserLogger.diagnostic(PDF_THUMBNAIL_LOG_SECTION, 'Thumbnail aspect ratio changed', {
            reason,
            page,
            previousAspectRatio: previousAspectRatio === null ? null : roundMetric(previousAspectRatio),
            nextAspectRatio: roundMetric(nextAspectRatio),
            itemHeight: roundMetric(resolveThumbnailItemHeightFromAspect(
                nextAspectRatio,
                layout.thumbnailRenderWidth.value,
            )),
            currentPage: source.currentPage.value,
            totalPages: source.totalPages.value,
            ...data,
        });

        return true;
    }

    function isThumbnailPaneActive() {
        return source.isActive.value !== false;
    }

    function isThumbnailRenderGenerationCurrent(pdfDocument: PDFDocumentProxy, runId: number) {
        return isThumbnailRenderGenerationSnapshotCurrent({
            runId,
            renderRunId,
            isDocumentUsable: isPdfDocumentUsable(pdfDocument),
            isPaneActive: isThumbnailPaneActive(),
        });
    }

    function cancelAllRenders() {
        thumbnailRenderState.cancelAll();
    }

    function cancelRenderForPage(page: number) {
        thumbnailRenderState.cancelPage(page);
    }

    function incrementRenderGeneration() {
        renderRunId += 1;
    }

    function pruneDetachedThumbnailState() {
        const mountedPages = new Set(layout.virtualPages.value);
        thumbnailRenderState.pruneDetached({
            mountedPages,
            resolveCanvas: dom.getCanvas,
        });
    }

    function prepareThumbnailCanvas(pageNum: number) {
        const canvas = dom.getCanvas(pageNum);
        if (!canvas || isCurrentThumbnailCanvasRendered(pageNum)) {
            return null;
        }

        const renderKey = getThumbnailRenderKey(pageNum);
        if (thumbnailRenderState.hasRenderingPage(pageNum)) {
            if (thumbnailRenderState.isRenderingCanvasKey({
                page: pageNum,
                canvas,
                renderKey,
            })) {
                return null;
            }
            cancelRenderForPage(pageNum);
        }

        if (shouldPreserveThumbnailBitmap(canvas)) {
            canvas.dataset.thumbnailRenderKey = renderKey;
            canvas.dataset.thumbnailPreservedBitmap = 'true';
            delete canvas.dataset.thumbnailRendered;
        } else {
            clearThumbnailCanvas(canvas, renderKey);
        }
        thumbnailRenderState.beginRender({
            page: pageNum,
            canvas,
            renderKey,
        });
        return {
            canvas,
            renderKey,
        };
    }

    function resolveThumbnailRenderMetrics(page: PDFPageProxy, pageNum: number) {
        const viewport = page.getViewport({ scale: 1 });
        updateThumbnailAspectRatioForPage(
            pageNum,
            viewport.width,
            viewport.height,
            'render-viewport',
        );
        const scale = layout.thumbnailRenderWidth.value / viewport.width;
        const scaledViewport = page.getViewport({ scale });
        const outputScale = resolveThumbnailOutputScale();
        const pixelWidth = Math.max(1, Math.round(scaledViewport.width * outputScale));
        const pixelHeight = Math.max(1, Math.round(scaledViewport.height * outputScale));

        return {
            scaledViewport,
            pixelWidth,
            pixelHeight,
            scaleX: pixelWidth / scaledViewport.width,
            scaleY: pixelHeight / scaledViewport.height,
        };
    }

    function applyThumbnailCanvasSize(
        canvas: HTMLCanvasElement,
        metrics: ReturnType<typeof resolveThumbnailRenderMetrics>,
    ) {
        canvas.width = metrics.pixelWidth;
        canvas.height = metrics.pixelHeight;
        canvas.style.removeProperty('width');
        canvas.style.removeProperty('height');
    }

    function releaseThumbnailPage(
        pageLease: IPdfDocumentPageLease,
        pageNumber: number,
        reason: string,
    ) {
        try {
            logPdfRenderTrace('thumbnail-page-release-begin', {
                pageNumber,
                reason,
            });
            pageLease.release();
            logPdfRenderTrace('thumbnail-page-release-end', {
                pageNumber,
                reason,
            });
        } catch (error) {
            logPdfRenderTrace('thumbnail-page-release-error', {
                pageNumber,
                reason,
                errorName: error instanceof Error ? error.name : null,
                errorMessage: error instanceof Error ? error.message : String(error),
            });
            BrowserLogger.diagnostic(PDF_THUMBNAIL_LOG_SECTION, 'Failed to release thumbnail PDF page', {error});
        }
    }

    function finalizeRenderedThumbnail(pageNum: number, canvas: HTMLCanvasElement, renderKey: string) {
        if (
            dom.getCanvas(pageNum) !== canvas
            || getThumbnailRenderKey(pageNum) !== renderKey
            || !isCanvasForRenderKey(canvas, renderKey)
        ) {
            logPdfRenderTrace('thumbnail-finalize-skip-stale', {
                pageNumber: pageNum,
                renderKey,
                currentRenderKey: getThumbnailRenderKey(pageNum),
                hasCanvas: Boolean(dom.getCanvas(pageNum)),
            });
            void scheduleVisibleThumbnailRender();
            return;
        }

        canvas.dataset.thumbnailRendered = 'true';
        surfaceLeases.get(canvas)?.release();
        let leaseCommitted = false;
        const lease = workspaceSurfaceBudgetController.reserve({
            scopeId: surfaceScopeId,
            category: 'pdf-thumbnail-canvas',
            bytes: estimateCanvasSurfaceBytes(canvas),
            priority: pageNum === source.currentPage.value ? 100 : 10,
            canEvict: () => leaseCommitted && pageNum !== source.currentPage.value,
            evict: () => clearThumbnailCanvas(canvas),
        });
        surfaceLeases.set(canvas, lease);
        leaseCommitted = true;
        const renderedCount = thumbnailRenderState.markRendered({
            page: pageNum,
            canvas,
        });
        logPdfRenderTrace('thumbnail-finalize-rendered', {
            pageNumber: pageNum,
            renderKey,
            renderedCount,
        });
        void effects.measureThumbnailHeight();
        if (renderedCount === 1) {
            void scheduleVisibleThumbnailRender();
        }
    }

    function shouldIgnoreThumbnailRenderError(
        error: unknown,
        pdfDocument: PDFDocumentProxy,
        runId: number,
    ) {
        return (
            (error instanceof Error && error.name === 'RenderingCancelledException') ||
            !isThumbnailRenderGenerationCurrent(pdfDocument, runId)
        );
    }

    async function renderPreparedThumbnail(
        pdfDocument: PDFDocumentProxy,
        pageNum: number,
        runId: number,
        canvas: HTMLCanvasElement,
        renderKey: string,
    ) {
        logPdfRenderTrace('thumbnail-page-load-begin', {
            pageNumber: pageNum,
            runId,
            renderKey,
            renderRunId,
        });
        const pageLease = await leasePdfDocumentPage(pdfDocument, pageNum);
        const page = pageLease.page;
        const renderAbortController = new AbortController();
        logPdfRenderTrace('thumbnail-page-load-end', {
            pageNumber: pageNum,
            runId,
            renderKey,
            renderRunId,
        });
        try {
            const isCurrentThumbnailRender = () => (
                isThumbnailRenderGenerationCurrent(pdfDocument, runId)
                && dom.getCanvas(pageNum) === canvas
                && getThumbnailRenderKey(pageNum) === renderKey
                && isCanvasForRenderKey(canvas, renderKey)
                && thumbnailRenderState.isRenderingCanvasKey({
                    page: pageNum,
                    canvas,
                    renderKey,
                })
            );
            if (
                !isCurrentThumbnailRender()
            ) {
                logPdfRenderTrace('thumbnail-render-skip-stale', {
                    pageNumber: pageNum,
                    runId,
                    renderRunId,
                    renderKey,
                    currentRenderKey: getThumbnailRenderKey(pageNum),
                    usableDocument: isPdfDocumentUsable(pdfDocument),
                    thumbnailPaneActive: isThumbnailPaneActive(),
                });
                return;
            }

            const hasHiddenAnnotations = visuals.hiddenAnnotationIdSet.value.size > 0;
            const annotationMode = AnnotationMode?.ENABLE_STORAGE
                ?? AnnotationMode?.ENABLE_FORMS
                ?? AnnotationMode?.ENABLE
                ?? 1;
            const metrics = resolveThumbnailRenderMetrics(page, pageNum);
            const renderCoordination = resolveThumbnailRenderCoordination(pageNum, source.currentPage.value);
            thumbnailRenderState.trackAbortController(pageNum, renderAbortController);
            const hiddenAnnotationFilter = hasHiddenAnnotations
                ? createRenderTaskHiddenAnnotationOperationsFilter(visuals.hiddenAnnotationIdSet.value)
                : null;
            if (!isCurrentThumbnailRender()) {
                return;
            }
            const renderCanvas = canvas.dataset.thumbnailPreservedBitmap === 'true'
                ? document.createElement('canvas')
                : canvas;
            applyThumbnailCanvasSize(renderCanvas, metrics);
            const context = renderCanvas.getContext('2d');
            if (!context) {
                if (renderCanvas !== canvas) {
                    renderCanvas.remove();
                }
                return;
            }

            const hiddenIds = Array.from(visuals.hiddenAnnotationIdSet.value);
            logPdfRenderTrace('thumbnail-render-start', {
                pageNumber: pageNum,
                runId,
                renderKey,
                hiddenAnnotationCount: hiddenIds.length,
                hiddenAnnotationIds: hiddenIds.slice(0, 30),
                hiddenAnnotationIdsSignature: visuals.hiddenAnnotationIdsSignature.value,
                pixelWidth: metrics.pixelWidth,
                pixelHeight: metrics.pixelHeight,
                scaleX: metrics.scaleX,
                scaleY: metrics.scaleY,
                target: renderCanvas === canvas ? 'visible' : 'buffered',
                renderOwner: renderCoordination.owner,
                renderPriority: renderCoordination.priority,
            });

            let task: RenderTask | null = null;
            try {
                await runCoordinatedPdfPageRender({
                    owner: renderCoordination.owner,
                    pageNumber: pageNum,
                    pdfPage: page,
                    priority: renderCoordination.priority,
                    continuation: {
                        key: `thumbnail:${documentRenderEpoch.value}:${pageNum}:${renderKey}`,
                        priority: renderCoordination.owner === 'thumbnail-current'
                            ? 'thumbnail'
                            : 'prefetch',
                    },
                    signal: renderAbortController.signal,
                    shouldStart: isCurrentThumbnailRender,
                    startRender: () => {
                        const renderOptions = {
                            canvasContext: context,
                            viewport: metrics.scaledViewport,
                            canvas: renderCanvas,
                            transform: buildThumbnailRenderTransform(metrics.scaleX, metrics.scaleY),
                            annotationMode,
                        };
                        if (!hiddenAnnotationFilter) {
                            return page.render(renderOptions);
                        }
                        const guardedTask = page.render({
                            ...renderOptions,
                            operationsFilter: hiddenAnnotationFilter.filter,
                        });
                        if (hiddenAnnotationFilter.bindTask(guardedTask)) {
                            return guardedTask;
                        }
                        guardedTask.cancel();
                        return page.render({
                            ...renderOptions,
                            annotationMode: AnnotationMode?.DISABLE ?? 0,
                        });
                    },
                    onTask: (nextTask) => {
                        task = nextTask;
                        thumbnailRenderState.trackRenderTask(pageNum, nextTask);
                    },
                });
                logPdfRenderTrace('thumbnail-render-resolve', {
                    pageNumber: pageNum,
                    runId,
                    renderKey,
                });
                const hiddenFilterDiagnostics = hiddenAnnotationFilter?.getDiagnostics();
                if (
                    hiddenFilterDiagnostics
                    && hiddenFilterDiagnostics.callCount > 0
                    && hiddenFilterDiagnostics.hiddenMatchCount === 0
                    && isCurrentThumbnailRender()
                ) {
                    // Some PDF.js render intents flatten annotation boundaries out of
                    // the QueueOptimizer operator list. In that unsupported private
                    // runtime shape, fail closed rather than showing a deleted source
                    // annotation until the persisted bytes replace the live source.
                    context.clearRect(0, 0, renderCanvas.width, renderCanvas.height);
                    await runCoordinatedPdfPageRender({
                        owner: renderCoordination.owner,
                        pageNumber: pageNum,
                        pdfPage: page,
                        priority: renderCoordination.priority,
                        continuation: {
                            key: `thumbnail-hidden-fallback:${documentRenderEpoch.value}:${pageNum}:${renderKey}`,
                            priority: renderCoordination.owner === 'thumbnail-current'
                                ? 'thumbnail'
                                : 'prefetch',
                        },
                        signal: renderAbortController.signal,
                        shouldStart: isCurrentThumbnailRender,
                        startRender: () => page.render({
                            canvasContext: context,
                            viewport: metrics.scaledViewport,
                            canvas: renderCanvas,
                            transform: buildThumbnailRenderTransform(metrics.scaleX, metrics.scaleY),
                            annotationMode: AnnotationMode?.DISABLE ?? 0,
                        }),
                        onTask: (nextTask) => {
                            task = nextTask;
                            thumbnailRenderState.trackRenderTask(pageNum, nextTask);
                        },
                    });
                }
            } catch (error) {
                logPdfRenderTrace('thumbnail-render-reject', {
                    pageNumber: pageNum,
                    runId,
                    renderKey,
                    errorName: error instanceof Error ? error.name : null,
                    errorMessage: error instanceof Error ? error.message : String(error),
                });
                if (renderCanvas !== canvas) {
                    renderCanvas.width = 0;
                    renderCanvas.height = 0;
                    renderCanvas.remove();
                }
                throw error;
            } finally {
                if (task) {
                    thumbnailRenderState.clearRenderTask(pageNum, task);
                }
            }
            const isStillCurrentCanvas = (
                isThumbnailRenderGenerationCurrent(pdfDocument, runId)
                &&
                dom.getCanvas(pageNum) === canvas
                && getThumbnailRenderKey(pageNum) === renderKey
                && isCanvasForRenderKey(canvas, renderKey)
            );
            if (!isStillCurrentCanvas) {
                if (renderCanvas !== canvas) {
                    renderCanvas.width = 0;
                    renderCanvas.height = 0;
                    renderCanvas.remove();
                }
                void scheduleVisibleThumbnailRender();
                return;
            }
            drawEditedTextMarkupThumbnailVisuals({
                annotationSettings: visuals.annotationSettings.value,
                canvas: renderCanvas,
                comments: visuals.editedTextMarkupComments.value,
                context,
                pageNum,
            });
            if (renderCanvas !== canvas) {
                const visibleContext = canvas.getContext('2d');
                if (!visibleContext) {
                    renderCanvas.remove();
                    return;
                }

                applyThumbnailCanvasSize(canvas, metrics);
                visibleContext.drawImage(renderCanvas, 0, 0);
                renderCanvas.width = 0;
                renderCanvas.height = 0;
                renderCanvas.remove();
                delete canvas.dataset.thumbnailPreservedBitmap;
            }
            finalizeRenderedThumbnail(pageNum, canvas, renderKey);
        } finally {
            thumbnailRenderState.clearAbortController(pageNum, renderAbortController);
            releaseThumbnailPage(pageLease, pageNum, 'render-thumbnail');
        }
    }

    function cleanupThumbnailRenderState(pageNum: number, canvas: HTMLCanvasElement, renderKey: string) {
        thumbnailRenderState.clearFinishedRender({
            page: pageNum,
            canvas,
            renderKey,
        });
    }

    function handleThumbnailRenderError(
        error: unknown,
        pdfDocument: PDFDocumentProxy,
        pageNum: number,
        runId: number,
    ) {
        if (shouldIgnoreThumbnailRenderError(error, pdfDocument, runId)) {
            return;
        }

        BrowserLogger.error(
            PDF_THUMBNAIL_LOG_SECTION,
            `Failed to render thumbnail for page ${pageNum}`,
            error,
        );
    }

    async function renderThumbnail(
        pdfDocument: PDFDocumentProxy,
        pageNum: number,
        runId: number,
    ) {
        const canvas = isThumbnailRenderGenerationCurrent(pdfDocument, runId)
            ? prepareThumbnailCanvas(pageNum)
            : null;
        if (!canvas) {
            return;
        }

        try {
            await renderPreparedThumbnail(
                pdfDocument,
                pageNum,
                runId,
                canvas.canvas,
                canvas.renderKey,
            );
        } catch (error) {
            handleThumbnailRenderError(error, pdfDocument, pageNum, runId);
        } finally {
            cleanupThumbnailRenderState(pageNum, canvas.canvas, canvas.renderKey);
        }
    }

    function buildRenderQueue(totalPages: number) {
        pruneDetachedThumbnailState();

        const currentRenderedPages = new Set(
            layout.virtualPages.value.filter(page => isCurrentThumbnailCanvasRendered(page)),
        );
        const currentRenderingPages = new Set(
            layout.virtualPages.value.filter(page => isCurrentThumbnailCanvasRendering(page)),
        );
        const queueCurrentPage = layout.shouldPreferVisibleAnchorOverCurrentPage()
            ? layout.resolveViewportAnchorPage() ?? source.currentPage.value
            : source.currentPage.value;

        return buildThumbnailRenderQueue({
            totalPages,
            currentPage: queueCurrentPage,
            visiblePages: layout.virtualPages.value,
            renderedPages: currentRenderedPages,
            renderingPages: currentRenderingPages,
            immediateRenderRadius: IMMEDIATE_RENDER_RADIUS,
            prefetchRenderRadius: PREFETCH_RENDER_RADIUS,
        }).filter((page) => (
            !isCurrentThumbnailCanvasRendered(page)
            && !isCurrentThumbnailCanvasRendering(page)
        ));
    }

    async function renderThumbnailQueue(
        pdfDocument: PDFDocumentProxy,
        pages: number[],
        runId: number,
    ) {
        if (pages.length === 0) {
            return;
        }

        const queue = [...pages];

        const concurrency = resolveThumbnailRenderConcurrency({
            baseConcurrency: THUMBNAIL_RENDER_CONCURRENCY,
            lastNavigationAtMs,
            navigationCooldownMs: THUMBNAIL_NAVIGATION_CONCURRENCY_COOLDOWN_MS,
            nowMs: Date.now(),
        });
        logPdfRenderTrace('thumbnail-queue-start', {
            pages: pages.slice(0, 40),
            totalPages: pages.length,
            runId,
            renderRunId,
            concurrency,
            currentPage: source.currentPage.value,
            virtualPages: layout.virtualPages.value.slice(0, 40),
            hiddenAnnotationIdsSignature: visuals.hiddenAnnotationIdsSignature.value,
        });
        const workers = Array.from({length: Math.min(concurrency, queue.length)}, async () => {
            while (queue.length > 0) {
                if (runId !== renderRunId || !isPdfDocumentUsable(pdfDocument)) {
                    logPdfRenderTrace('thumbnail-queue-stop-stale', {
                        runId,
                        renderRunId,
                        usableDocument: isPdfDocumentUsable(pdfDocument),
                        remaining: queue.length,
                    });
                    return;
                }
                const pageNum = queue.shift();
                if (pageNum === undefined) {
                    return;
                }
                await renderThumbnail(pdfDocument, pageNum, runId);
            }
        });

        await Promise.all(workers);
        const renderStateSnapshot = thumbnailRenderState.createSnapshot();
        logPdfRenderTrace('thumbnail-queue-end', {
            runId,
            renderRunId,
            renderedCount: renderStateSnapshot.renderedCount,
            activeTasks: renderStateSnapshot.activeTasks,
        });
    }

    const scheduleVisibleThumbnailRender = useDebounceFn(() => {
        const doc = source.pdfDocument.value;

        if (!doc || source.totalPages.value <= 0) {
            return;
        }
        if (!isThumbnailPaneActive()) {
            return;
        }
        if (!dom.resolveVisibleContainer('schedule-visible-render')) {
            return;
        }

        const runId = renderRunId;
        const pages = buildRenderQueue(source.totalPages.value);
        logPdfRenderTrace('thumbnail-schedule-visible-render-run', {
            runId,
            currentPage: source.currentPage.value,
            totalPages: source.totalPages.value,
            pages: pages.slice(0, 40),
            pageCount: pages.length,
            isActive: source.isActive.value,
            hiddenAnnotationIdsSignature: visuals.hiddenAnnotationIdsSignature.value,
        });

        runGuardedTask(() => renderThumbnailQueue(doc, pages, runId), {
            category: 'user-visible-operation',
            scope: PDF_THUMBNAIL_LOG_SECTION,
            message: 'Failed to render virtual thumbnail list',
        });
    }, 20);

    async function preloadThumbnailAspectRatio(pdfDocument: PDFDocumentProxy, runId: number) {
        const pageNum = clamp(source.currentPage.value || 1, 1, Math.max(1, source.totalPages.value));
        try {
            const pageLease = await leasePdfDocumentPage(pdfDocument, pageNum);
            const page = pageLease.page;
            try {
                if (!isThumbnailRenderGenerationCurrent(pdfDocument, runId)) {
                    return;
                }

                const viewport = page.getViewport({scale: 1});
                updateThumbnailAspectRatioForPage(
                    pageNum,
                    viewport.width,
                    viewport.height,
                    'preload-viewport',
                );
                void effects.refreshVisibleThumbnailPane('preload-viewport');
            } finally {
                releaseThumbnailPage(pageLease, pageNum, 'preload-aspect-ratio');
            }
        } catch (error) {
            if (shouldIgnoreThumbnailRenderError(error, pdfDocument, runId)) {
                return;
            }
            BrowserLogger.diagnostic(PDF_THUMBNAIL_LOG_SECTION, 'Failed to preload thumbnail aspect ratio', {
                page: pageNum,
                currentPage: source.currentPage.value,
                totalPages: source.totalPages.value,
                error,
            });
        }
    }

    function clearRenderedState(options: {
        preserveRenderWidth?: boolean;
        preserveAspectRatio?: boolean;
    } = {}) {
        thumbnailRenderState.clearAllState();
        clearVisibleThumbnailCanvases();
        if (!options.preserveRenderWidth) {
            layout.thumbnailRenderWidth.value = THUMBNAIL_WIDTH;
        }
        if (!options.preserveAspectRatio) {
            layout.clearThumbnailAspectRatios();
        }
        effects.resetMeasurementState();
    }

    function hasValidThumbnailAspectRatio(page: number) {
        const aspectRatio = layout.thumbnailAspectRatios.value[page - 1] ?? null;
        return aspectRatio !== null
            && Number.isFinite(aspectRatio)
            && aspectRatio > 0;
    }

    function invalidatePages(pages: number[]) {
        pendingInvalidation = pages;
        for (const page of pages) {
            thumbnailRenderState.bumpPageRenderEpoch(page);
        }
        for (const page of pages) {
            if (layout.thumbnailAspectRatios.value[page - 1] !== undefined) {
                layout.updateThumbnailAspectRatio(page, null);
            }
        }
        thumbnailKeySignal.value += 1;
        logPdfRenderTrace('thumbnail-invalidate-pages', {
            pages: pages.slice(0, 40),
            totalPages: pages.length,
            renderRunId,
            currentPage: source.currentPage.value,
            hiddenAnnotationIdsSignature: visuals.hiddenAnnotationIdsSignature.value,
            editedTextMarkupVisualSignature: visuals.editedTextMarkupVisualSignature.value,
        });
        BrowserLogger.diagnostic(PDF_THUMBNAIL_LOG_SECTION, 'Invalidating thumbnail pages', {
            pages: pages.slice(0, 40),
            totalPages: pages.length,
            renderRunId,
            currentPage: source.currentPage.value,
        });
        for (const page of pages) {
            thumbnailRenderState.deleteRenderedPage(page);
            cancelRenderForPage(page);

            const canvas = dom.getCanvas(page);
            if (canvas) {
                clearThumbnailCanvas(canvas, getThumbnailRenderKey(page));
            }
        }

        void scheduleVisibleThumbnailRender();
    }

    watch(
        [
            () => source.pdfDocument.value,
            () => source.totalPages.value,
        ],
        ([
            doc,
            total,
        ], [oldDoc]) => {
            cancelAllRenders();
            incrementRenderGeneration();
            effects.onSourceCycleStarted();
            documentRenderEpoch.value += 1;
            thumbnailKeySignal.value += 1;
            thumbnailRenderState.clearPageRenderEpochs();
            clearVisibleThumbnailCanvases();
            BrowserLogger.diagnostic(PDF_THUMBNAIL_LOG_SECTION, 'Thumbnail source/watch cycle started', {
                hasDocument: Boolean(doc),
                hadDocument: Boolean(oldDoc),
                totalPages: total,
                renderRunId,
                reloadTransition,
                pendingInvalidation: pendingInvalidation?.slice(0, 24) ?? null,
                currentPage: source.currentPage.value,
            });

            if (!doc || total <= 0) {
                if (total <= 0) {
                    clearRenderedState();
                    reloadTransition = false;
                } else {
                    reloadTransition = true;
                }
                return;
            }

            if (doc !== oldDoc) {
                if (reloadTransition && pendingInvalidation) {
                    reloadTransition = false;
                    for (const page of pendingInvalidation) {
                        thumbnailRenderState.deleteRenderedPage(page);
                        thumbnailRenderState.clearRenderingPage(page);
                    }
                    pendingInvalidation = null;
                } else {
                    reloadTransition = false;
                    pendingInvalidation = null;
                    clearRenderedState();
                }
            }

            void nextTick(() => {
                if (!hasValidThumbnailAspectRatio(clamp(source.currentPage.value || 1, 1, Math.max(1, source.totalPages.value)))) {
                    void preloadThumbnailAspectRatio(doc, renderRunId);
                    return;
                }

                void effects.refreshVisibleThumbnailPane('document-ready');
            });
        },
        { immediate: true },
    );

    watch(
        () => [
            source.currentPage.value,
            layout.virtualPages.value[0] ?? 0,
            layout.virtualPages.value.at(-1) ?? 0,
            layout.virtualPages.value.length,
        ] as const,
        () => {
            void scheduleVisibleThumbnailRender();
        },
    );

    watch(
        () => source.currentPage.value,
        (nextPage, previousPage) => {
            if (previousPage !== undefined && nextPage !== previousPage) {
                lastNavigationAtMs = Date.now();
            }
            effects.scheduleActivePaneRefresh('current-page');
        },
        {
            flush: 'post',
            immediate: true,
        },
    );

    watch(
        () => source.isActive.value,
        (isActive) => {
            if (!isActive) {
                effects.cancelActivePaneRefresh();
                cancelAllRenders();
                incrementRenderGeneration();
                return;
            }

            effects.scheduleActivePaneRefresh('pane-active');
        },
        {
            flush: 'post',
            immediate: true,
        },
    );

    watch(
        () => [
            visuals.hiddenAnnotationIdsSignature.value,
            visuals.editedTextMarkupVisualSignature.value,
        ],
        (nextSignature, previousSignature) => {
            if (
                nextSignature[0] === previousSignature?.[0]
                && nextSignature[1] === previousSignature?.[1]
            ) {
                return;
            }
            const pages = layout.virtualPages.value.length > 0
                ? layout.virtualPages.value
                : [source.currentPage.value];
            invalidatePages([...new Set(pages)]);
        },
    );

    watch(
        () => source.invalidationRequest.value?.id,
        () => {
            const pages = source.invalidationRequest.value?.pages;
            if (!pages || pages.length === 0) {
                return;
            }
            invalidatePages([...pages]);
        },
    );

    watch(layout.virtualPages, async () => {
        pruneDetachedThumbnailState();
        await nextTick();
        void effects.measureThumbnailHeight();
        void scheduleVisibleThumbnailRender();
    });

    onMounted(() => {
        effects.scheduleActivePaneRefresh('mounted');
    });

    onBeforeUnmount(() => {
        effects.cancelActivePaneRefresh();
        cancelAllRenders();
        incrementRenderGeneration();
        clearRenderedState();
        workspaceSurfaceBudgetController.releaseScope(surfaceScopeId);
    });

    return {
        cancelAllRenders,
        getRenderSummary: () => thumbnailRenderState.createSnapshot(),
        getThumbnailRenderKey,
        hasRenderedThumbnails: () => thumbnailRenderState.renderedCount > 0,
        resolveThumbnailRenderWidth,
        scheduleVisibleThumbnailRender,
    };
};
