import { clamp } from 'es-toolkit/math';
import type {
    PDFDocumentProxy,
    PDFPageProxy,
    RenderTask,
} from 'pdfjs-dist';
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
    isThumbnailRasterWidthReady,
    resolveThumbnailRasterWidth,
    resolveThumbnailRenderWidthFromStyles,
    roundMetric,
} from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailRenderMetrics';
import { drawEditedTextMarkupThumbnailVisuals } from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailTextMarkupVisuals';
import { resolveThumbnailItemHeightFromAspect } from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailLayout';
import { resolveThumbnailRenderConcurrency } from '@app/modules/pdf-viewer/thumbnails/resolveThumbnailRenderConcurrency';
import { resolveThumbnailRenderCoordination } from '@app/modules/pdf-viewer/thumbnails/resolveThumbnailRenderCoordination';
import {
    createThumbnailSurfaceResidency,
    type TThumbnailSurfaceDemand,
} from '@app/modules/pdf-viewer/thumbnails/createThumbnailSurfaceResidency';
import type { IUsePdfThumbnailRenderRuntimeOptions } from '@app/modules/pdf-viewer/thumbnails/usePdfThumbnailRenderRuntimeOptions';
import {
    estimateCanvasSurfaceBytes,
    workspaceSurfaceBudgetController,
} from '@app/utils/document-viewer/workspaceSurfaceBudget';
import { createThumbnailRenderFrameScheduler } from '@app/modules/pdf-viewer/thumbnails/createThumbnailRenderFrameScheduler';
import { shouldPreserveThumbnailBitmap } from '@app/modules/pdf-viewer/thumbnails/shouldPreserveThumbnailBitmap';

export const PDF_THUMBNAIL_LOG_SECTION = 'pdf-thumbnails';
const THUMBNAIL_RENDER_CONCURRENCY = getPerformanceProfile().thumbnailBaseConcurrency;

const THUMBNAIL_NAVIGATION_CONCURRENCY_COOLDOWN_MS = 250;
const IMMEDIATE_RENDER_RADIUS = 2;
const PREFETCH_RENDER_RADIUS = 4;
const MAX_DEMAND_RENDER_RETRIES = 3;
const MAX_THUMBNAIL_OUTPUT_SCALE = 2;
let nextThumbnailSurfaceScopeId = 0;

export const usePdfThumbnailRenderRuntime = (options: IUsePdfThumbnailRenderRuntimeOptions) => {
    const {
        dom,
        effects,
        layout,
        source,
        surfaceBudget = workspaceSurfaceBudgetController,
        visuals,
    } = options;
    const thumbnailRenderState = createThumbnailRenderState();
    const surfaceScopeId = `pdf-thumbnails:${++nextThumbnailSurfaceScopeId}`;
    let renderRunId = 0;
    let renderQueueRunId = 0;
    let pendingInvalidation: number[] | null = null;
    let reloadTransition = false;
    let lastNavigationAtMs = Number.NEGATIVE_INFINITY;
    const demandRetryAttempts = new Map<number, {
        attempts: number;
        renderKey: string;
    }>();

    const documentRenderEpoch = ref(0);
    const thumbnailKeySignal = ref(0);

    function resolveThumbnailDemand(page: number): TThumbnailSurfaceDemand {
        if (!isThumbnailPaneActive()) {
            return 'inactive';
        }
        if (page === source.currentPage.value) {
            return 'current';
        }
        if (layout.viewportPages.value.includes(page)) {
            return 'viewport';
        }
        return Math.abs(page - source.currentPage.value) <= IMMEDIATE_RENDER_RADIUS
            ? 'nearby'
            : 'cold';
    }

    function resetThumbnailCanvasBitmap(canvas: HTMLCanvasElement, renderKey: string | null = null) {
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

    const surfaceResidency = createThumbnailSurfaceResidency<HTMLCanvasElement>({
        budget: surfaceBudget,
        scopeId: surfaceScopeId,
        resolveDemand: ({page}) => resolveThumbnailDemand(page),
        onEvict: ({
            page,
            canvas,
        }) => {
            thumbnailRenderState.deleteRenderedPage(page);
            resetThumbnailCanvasBitmap(canvas);
            logPdfRenderTrace('thumbnail-surface-evicted', {
                pageNumber: page,
                currentPage: source.currentPage.value,
                demand: resolveThumbnailDemand(page),
            });
        },
    });

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

    function clearThumbnailCanvas(
        page: number,
        canvas: HTMLCanvasElement,
        renderKey: string | null = null,
    ) {
        surfaceResidency.releasePage(page, canvas);
        thumbnailRenderState.deleteRenderedPage(page);
        resetThumbnailCanvasBitmap(canvas, renderKey);
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
                clearThumbnailCanvas(page, canvas, null);
            }
        }
    }

    function clearUnderResolutionVisibleThumbnailCanvases() {
        const container = dom.resolveVisibleContainer('clear-under-resolution-thumbnails');
        if (!container) {
            return;
        }

        const minimumPixelWidth = Math.ceil(
            resolveThumbnailRasterWidth(layout.thumbnailLayoutWidth.value)
            * resolveThumbnailOutputScale(),
        );
        const thumbnails = container.querySelectorAll<HTMLElement>('.pdf-thumbnail');
        for (const thumbnail of thumbnails) {
            const page = Number(thumbnail.dataset.page);
            const canvas = thumbnail.querySelector<HTMLCanvasElement>('canvas');
            if (
                canvas
                && (isCanvasRendered(canvas) || canvas.dataset.thumbnailPreservedBitmap === 'true')
                && canvas.width < minimumPixelWidth
            ) {
                clearThumbnailCanvas(page, canvas, null);
            }
        }
    }

    function isThumbnailRasterReady() {
        return isThumbnailRasterWidthReady(
            layout.thumbnailLayoutWidth.value,
            layout.thumbnailRenderWidth.value,
        );
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

    function isThumbnailDocumentGenerationCurrent(pdfDocument: PDFDocumentProxy, runId: number) {
        return runId === renderRunId && isPdfDocumentUsable(pdfDocument);
    }

    function cancelAllRenders() {
        thumbnailRenderState.cancelAll();
    }

    function cancelRenderForPage(page: number) {
        thumbnailRenderState.cancelPage(page);
    }

    function incrementRenderGeneration() {
        renderRunId += 1;
        renderQueueRunId += 1;
    }

    function pruneDetachedThumbnailState() {
        const mountedPages = new Set(layout.virtualPages.value);
        surfaceResidency.prune(mountedPages, dom.getCanvas);
        thumbnailRenderState.pruneDetached({
            mountedPages,
            resolveCanvas: dom.getCanvas,
        });
        for (const page of demandRetryAttempts.keys()) {
            if (!mountedPages.has(page)) {
                demandRetryAttempts.delete(page);
            }
        }
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

        const minimumPixelWidth = Math.ceil(
            layout.thumbnailRenderWidth.value * resolveThumbnailOutputScale(),
        );
        if (shouldPreserveThumbnailBitmap(canvas, minimumPixelWidth)) {
            canvas.dataset.thumbnailRenderKey = renderKey;
            canvas.dataset.thumbnailPreservedBitmap = 'true';
            delete canvas.dataset.thumbnailRendered;
        } else {
            clearThumbnailCanvas(pageNum, canvas, renderKey);
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
        demandRetryAttempts.delete(pageNum);
        const renderedCount = thumbnailRenderState.markRendered({
            page: pageNum,
            canvas,
        });
        const admitted = surfaceResidency.register({
            page: pageNum,
            canvas,
        }, estimateCanvasSurfaceBytes(canvas));
        logPdfRenderTrace('thumbnail-finalize-rendered', {
            pageNumber: pageNum,
            renderKey,
            renderedCount,
            admitted,
            demand: resolveThumbnailDemand(pageNum),
        });
        if (!admitted) {
            return;
        }
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
            visiblePages: layout.viewportPages.value,
            mountedPages: layout.virtualPages.value,
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
        queueRunId: number,
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
                if (
                    runId !== renderRunId
                    || queueRunId !== renderQueueRunId
                    || !isPdfDocumentUsable(pdfDocument)
                ) {
                    logPdfRenderTrace('thumbnail-queue-stop-stale', {
                        runId,
                        renderRunId,
                        queueRunId,
                        renderQueueRunId,
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
        if (queueRunId === renderQueueRunId) {
            scheduleDemandedThumbnailRetry(runId);
        }
    }

    function scheduleDemandedThumbnailRetry(runId: number) {
        if (runId !== renderRunId || !isThumbnailPaneActive()) {
            return;
        }
        const mountedPages = new Set(layout.virtualPages.value);
        const demandedPages = new Set(layout.viewportPages.value);
        for (let distance = -IMMEDIATE_RENDER_RADIUS; distance <= IMMEDIATE_RENDER_RADIUS; distance += 1) {
            demandedPages.add(source.currentPage.value + distance);
        }
        const retryPages: number[] = [];
        const exhaustedPages: number[] = [];
        for (const page of demandedPages) {
            if (
                page < 1
                || page > source.totalPages.value
                || !mountedPages.has(page)
                || isCurrentThumbnailCanvasRendered(page)
                || isCurrentThumbnailCanvasRendering(page)
                || !dom.getCanvas(page)
            ) {
                continue;
            }

            const renderKey = getThumbnailRenderKey(page);
            const previous = demandRetryAttempts.get(page);
            const attempts = previous?.renderKey === renderKey ? previous.attempts : 0;
            if (attempts >= MAX_DEMAND_RENDER_RETRIES) {
                exhaustedPages.push(page);
                continue;
            }
            demandRetryAttempts.set(page, {
                attempts: attempts + 1,
                renderKey,
            });
            retryPages.push(page);
        }

        if (retryPages.length === 0) {
            if (exhaustedPages.length > 0) {
                logPdfRenderTrace('thumbnail-demand-retry-exhausted', {
                    pages: exhaustedPages,
                    runId,
                    renderRunId,
                });
            }
            return;
        }

        logPdfRenderTrace('thumbnail-demand-retry-scheduled', {
            pages: retryPages,
            runId,
            renderRunId,
        });
        void scheduleVisibleThumbnailRender();
    }

    function runVisibleThumbnailRender() {
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
        if (!isThumbnailRasterReady()) {
            clearUnderResolutionVisibleThumbnailCanvases();
            return;
        }
        const runId = renderRunId;
        const queueRunId = ++renderQueueRunId;
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

        runGuardedTask(() => renderThumbnailQueue(doc, pages, runId, queueRunId), {
            category: 'user-visible-operation',
            scope: PDF_THUMBNAIL_LOG_SECTION,
            message: 'Failed to render virtual thumbnail list',
        });
    }

    const visibleThumbnailRenderScheduler = createThumbnailRenderFrameScheduler(runVisibleThumbnailRender);
    const scheduleVisibleThumbnailRender = visibleThumbnailRenderScheduler.schedule;

    watch(
        () => [
            layout.thumbnailLayoutWidth.value,
            layout.thumbnailRenderWidth.value,
        ] as const,
        () => {
            if (isThumbnailRasterReady()) {
                void scheduleVisibleThumbnailRender();
                return;
            }

            visibleThumbnailRenderScheduler.cancel();
            cancelAllRenders();
            incrementRenderGeneration();
            clearUnderResolutionVisibleThumbnailCanvases();
        },
        {
            flush: 'sync',
            immediate: true,
        },
    );

    async function preloadThumbnailAspectRatio(pdfDocument: PDFDocumentProxy, runId: number) {
        const pageNum = clamp(source.currentPage.value || 1, 1, Math.max(1, source.totalPages.value));
        try {
            const pageLease = await leasePdfDocumentPage(pdfDocument, pageNum);
            const page = pageLease.page;
            try {
                if (!isThumbnailDocumentGenerationCurrent(pdfDocument, runId)) {
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
        surfaceResidency.releaseAll();
        demandRetryAttempts.clear();
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
                clearThumbnailCanvas(page, canvas, getThumbnailRenderKey(page));
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
            surfaceResidency.reconcile();
            void scheduleVisibleThumbnailRender();
        },
    );

    watch(
        () => source.currentPage.value,
        (nextPage, previousPage) => {
            if (previousPage !== undefined && nextPage !== previousPage) {
                lastNavigationAtMs = Date.now();
            }
            surfaceResidency.reconcile();
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
            surfaceResidency.reconcile();
            if (!isActive) {
                effects.cancelActivePaneRefresh();
                visibleThumbnailRenderScheduler.cancel();
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
        surfaceResidency.reconcile();
        await nextTick();
        void effects.measureThumbnailHeight();
        void scheduleVisibleThumbnailRender();
    });

    onMounted(() => {
        effects.scheduleActivePaneRefresh('mounted');
    });

    onBeforeUnmount(() => {
        effects.cancelActivePaneRefresh();
        visibleThumbnailRenderScheduler.cancel();
        cancelAllRenders();
        incrementRenderGeneration();
        clearRenderedState();
    });

    return {
        cancelAllRenders,
        getRenderSummary: () => thumbnailRenderState.createSnapshot(),
        getThumbnailRenderKey,
        hasRenderedThumbnails: () => thumbnailRenderState.renderedCount > 0,
        reconcileSurfaceResidency: surfaceResidency.reconcile,
        resolveThumbnailRenderWidth,
        scheduleVisibleThumbnailRender,
    };
};
