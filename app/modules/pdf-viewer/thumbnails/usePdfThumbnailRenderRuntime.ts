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
import { createHiddenAnnotationOperationsFilter } from '@app/modules/pdf-viewer/engine/pdf-hidden-annotation-operations/createHiddenAnnotationOperationsFilter';
import { runCoordinatedPdfPageRender } from '@app/modules/pdf-viewer/engine/pdf-page-render-coordinator/coordinatedPdfPageRender';
import type { IPdfPagePreviewEntry } from '@app/modules/pdf-viewer/engine/pdf-page-preview/pdfPagePreviewTypes';
import { AnnotationMode } from '@app/services/pdfjs/runtimeLib';
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
    resolveSeededThumbnailMetrics,
    resolveThumbnailRenderWidthFromStyles,
    roundMetric,
} from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailRenderMetrics';
import { drawEditedTextMarkupThumbnailVisuals } from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailTextMarkupVisuals';
import { resolveThumbnailItemHeightFromAspect } from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailLayout';
import { resolveThumbnailRenderConcurrency } from '@app/modules/pdf-viewer/thumbnails/resolveThumbnailRenderConcurrency';
import { resolveThumbnailRenderCoordination } from '@app/modules/pdf-viewer/thumbnails/resolveThumbnailRenderCoordination';

export const PDF_THUMBNAIL_LOG_SECTION = 'pdf-thumbnails';

interface IPdfThumbnailRenderRuntimeSource {
    currentPage: ComputedRef<number>;
    invalidationRequest: ComputedRef<{
        id: number;
        pages: number[];
    } | null | undefined>;
    isActive: ComputedRef<boolean>;
    pagePreviewProvider: ComputedRef<((page: number) => IPdfPagePreviewEntry | null) | null>;
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
    shouldPreferVisibleAnchorOverCurrentPage: () => boolean;
    resolveViewportAnchorPage: () => number | null;
    thumbnailAspectRatios: Ref<Array<number | null>>;
    thumbnailRenderWidth: Ref<number>;
    virtualPages: ComputedRef<number[]>;
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
const THUMBNAIL_NAVIGATION_CONCURRENCY_COOLDOWN_MS = 250;
const IMMEDIATE_RENDER_RADIUS = 2;
const PREFETCH_RENDER_RADIUS = 4;
const MAX_THUMBNAIL_OUTPUT_SCALE = 2;

export const usePdfThumbnailRenderRuntime = (options: IUsePdfThumbnailRenderRuntimeOptions) => {
    const {
        dom,
        effects,
        layout,
        source,
        visuals,
    } = options;

    const thumbnailRenderState = createThumbnailRenderState();
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
        canvas.width = 0;
        canvas.height = 0;
        delete canvas.dataset.thumbnailRendered;
        delete canvas.dataset.thumbnailSeededPreview;
        delete canvas.dataset.thumbnailSeededPreviewId;
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

        const nextRatios = layout.thumbnailAspectRatios.value.slice(0, Math.max(source.totalPages.value, page));
        nextRatios[page - 1] = nextAspectRatio;
        layout.thumbnailAspectRatios.value = nextRatios;
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

    function getPagePreviewSeed(pageNum: number) {
        const preview = source.pagePreviewProvider.value?.(pageNum) ?? null;
        if (
            !preview
            || preview.width <= 0
            || preview.height <= 0
        ) {
            return null;
        }

        return preview;
    }

    function seedThumbnailCanvasFromPagePreview(
        pageNum: number,
        canvas: HTMLCanvasElement,
        renderKey: string,
        reason: string,
    ) {
        const preview = getPagePreviewSeed(pageNum);
        if (!preview) {
            return false;
        }

        const metrics = resolveSeededThumbnailMetrics({
            cssWidth: layout.thumbnailRenderWidth.value,
            outputScale: resolveThumbnailOutputScale(),
            sourceHeight: preview.height,
            sourceWidth: preview.width,
        });
        if (!metrics) {
            return false;
        }

        const context = canvas.getContext('2d');
        if (!context) {
            return false;
        }

        updateThumbnailAspectRatioForPage(
            pageNum,
            preview.width,
            preview.height,
            'page-preview-seed',
        );
        canvas.width = metrics.pixelWidth;
        canvas.height = metrics.pixelHeight;
        canvas.style.removeProperty('width');
        canvas.style.removeProperty('height');
        canvas.dataset.thumbnailRenderKey = renderKey;
        canvas.dataset.thumbnailSeededPreview = 'true';
        canvas.dataset.thumbnailSeededPreviewId = String(preview.id);
        context.drawImage(preview.source, 0, 0, metrics.pixelWidth, metrics.pixelHeight);
        logPdfRenderTrace('thumbnail-seeded-from-page-preview', {
            pageNumber: pageNum,
            previewId: preview.id,
            reason,
            renderKey,
            sourceWidth: preview.width,
            sourceHeight: preview.height,
            pixelWidth: metrics.pixelWidth,
            pixelHeight: metrics.pixelHeight,
            sourceAspectRatio: metrics.sourceAspectRatio,
        });
        return true;
    }

    function seedVisibleThumbnailsFromPagePreview(reason: string) {
        for (const pageNum of layout.virtualPages.value) {
            const canvas = dom.getCanvas(pageNum);
            if (!canvas || isCurrentThumbnailCanvasRendered(pageNum)) {
                continue;
            }

            const preview = getPagePreviewSeed(pageNum);
            if (!preview) {
                continue;
            }

            const renderKey = getThumbnailRenderKey(pageNum);
            if (
                isCanvasForRenderKey(canvas, renderKey)
                && canvas.dataset.thumbnailSeededPreviewId === String(preview.id)
            ) {
                continue;
            }

            seedThumbnailCanvasFromPagePreview(pageNum, canvas, renderKey, reason);
        }
    }

    const visiblePagePreviewSignature = computed(() => {
        if (!source.pagePreviewProvider.value) {
            return '';
        }

        return layout.virtualPages.value
            .map((pageNum) => {
                const preview = source.pagePreviewProvider.value?.(pageNum);
                return preview
                    ? `${pageNum}:${preview.id}:${preview.width}:${preview.height}`
                    : `${pageNum}:`;
            })
            .join('|');
    });

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

        clearThumbnailCanvas(canvas, renderKey);
        seedThumbnailCanvasFromPagePreview(pageNum, canvas, renderKey, 'render-prepare');
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

    function cleanupPdfPage(page: PDFPageProxy, pageNumber: number, reason: string) {
        try {
            logPdfRenderTrace('thumbnail-page-cleanup-begin', {
                pageNumber,
                reason,
            });
            page.cleanup();
            logPdfRenderTrace('thumbnail-page-cleanup-end', {
                pageNumber,
                reason,
            });
        } catch (error) {
            logPdfRenderTrace('thumbnail-page-cleanup-error', {
                pageNumber,
                reason,
                errorName: error instanceof Error ? error.name : null,
                errorMessage: error instanceof Error ? error.message : String(error),
            });
            BrowserLogger.diagnostic(PDF_THUMBNAIL_LOG_SECTION, 'Failed to cleanup thumbnail PDF page', {error});
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
        delete canvas.dataset.thumbnailSeededPreview;
        delete canvas.dataset.thumbnailSeededPreviewId;
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
        const page = await pdfDocument.getPage(pageNum);
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

            const annotationMode = AnnotationMode?.ENABLE_STORAGE
                ?? AnnotationMode?.ENABLE_FORMS
                ?? AnnotationMode?.ENABLE
                ?? 1;
            const metrics = resolveThumbnailRenderMetrics(page, pageNum);
            const renderCoordination = resolveThumbnailRenderCoordination(pageNum, source.currentPage.value);
            thumbnailRenderState.trackAbortController(pageNum, renderAbortController);
            const operationsFilter = await createHiddenAnnotationOperationsFilter(
                page,
                annotationMode,
                visuals.hiddenAnnotationIdSet.value,
                {
                    owner: renderCoordination.owner,
                    priority: renderCoordination.priority,
                    signal: renderAbortController.signal,
                    shouldStart: isCurrentThumbnailRender,
                    shouldContinue: isCurrentThumbnailRender,
                },
            );
            if (!isCurrentThumbnailRender()) {
                return;
            }
            const renderCanvas = canvas.dataset.thumbnailSeededPreview === 'true'
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
                    shouldStart: isCurrentThumbnailRender,
                    startRender: () => page.render({
                        canvasContext: context,
                        viewport: metrics.scaledViewport,
                        canvas: renderCanvas,
                        transform: buildThumbnailRenderTransform(metrics.scaleX, metrics.scaleY),
                        annotationMode,
                        operationsFilter,
                    }),
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
            if (isStillCurrentCanvas) {
                drawEditedTextMarkupThumbnailVisuals({
                    annotationSettings: visuals.annotationSettings.value,
                    canvas: renderCanvas,
                    comments: visuals.editedTextMarkupComments.value,
                    context,
                    pageNum,
                });
            }
            if (renderCanvas !== canvas && isStillCurrentCanvas) {
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
            }
            if (renderCanvas !== canvas && !isStillCurrentCanvas) {
                renderCanvas.width = 0;
                renderCanvas.height = 0;
                renderCanvas.remove();
            }
            finalizeRenderedThumbnail(pageNum, canvas, renderKey);
        } finally {
            thumbnailRenderState.clearAbortController(pageNum, renderAbortController);
            cleanupPdfPage(page, pageNum, 'render-thumbnail');
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
            scope: PDF_THUMBNAIL_LOG_SECTION,
            message: 'Failed to render virtual thumbnail list',
        });
    }, 20);

    async function preloadThumbnailAspectRatio(pdfDocument: PDFDocumentProxy, runId: number) {
        const pageNum = clamp(source.currentPage.value || 1, 1, Math.max(1, source.totalPages.value));
        try {
            const page = await pdfDocument.getPage(pageNum);
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
                cleanupPdfPage(page, pageNum, 'preload-aspect-ratio');
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
            layout.thumbnailAspectRatios.value = [];
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
        const nextRatios = layout.thumbnailAspectRatios.value.slice();
        let didClearRatio = false;
        for (const page of pages) {
            if (nextRatios[page - 1] !== undefined) {
                nextRatios[page - 1] = null;
                didClearRatio = true;
            }
        }
        if (didClearRatio) {
            layout.thumbnailAspectRatios.value = nextRatios;
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
        visiblePagePreviewSignature,
        async () => {
            await nextTick();
            seedVisibleThumbnailsFromPagePreview('page-preview-ready');
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
