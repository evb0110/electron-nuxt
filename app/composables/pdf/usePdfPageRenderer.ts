import { Mutex } from 'es-toolkit';
import type {
    AnnotationEditorUIManager,
    PDFPageProxy,
} from 'pdfjs-dist';
import type {
    IPdfPageMatches,
    IPdfPageMetric,
    IPdfSearchMatch,
    IScrollSnapshot,
} from '@app/types/pdf';
import type { TDocumentRef } from '@contracts/platformApi';
import type { IL10n } from 'pdfjs-dist/types/web/interfaces';
import type {
    MaybeRefOrGetter,
    Ref,
} from 'vue';
import { chunk } from 'es-toolkit/array';
import {
    clamp,
    range,
} from 'es-toolkit/math';
import type { usePdfDocument } from '@app/composables/pdf/usePdfDocument';
import { usePdfCanvasRenderer } from '@app/composables/pdf/usePdfCanvasRenderer';
import { usePdfTextLayerRenderer } from '@app/composables/pdf/usePdfTextLayerRenderer';
import { usePdfAnnotationLayerRenderer } from '@app/composables/pdf/usePdfAnnotationLayerRenderer';
import { CONCURRENT_RENDERS } from '@app/constants/pdfLayout';
import {
    PDF_PAGE_LOAD_TIMEOUT_MS,
    PDF_PAGE_RENDER_TIMEOUT_MS,
    PDF_PAGE_TEXT_LAYER_TIMEOUT_MS,
} from '@app/constants/timeouts';
import {
    isRenderingCancelledError,
    captureScrollSnapshot,
    formatRenderError,
} from '@app/composables/pdf/pdfPageRenderPipeline';
import {
    getPageContainer,
    setupPagePlaceholderSizes,
    type IPageRange,
} from '@app/composables/pdf/pdfPageBufferManager';
import { normalizePageMetrics } from '@app/composables/pdf/pdfPageLayout';
import { BrowserLogger } from '@app/utils/browserLogger';
import { runGuardedTask } from '@app/utils/asyncGuard';
import { createPdfSearchMatchScroller } from '@app/composables/pdf/pdfSearchMatchScroller';
import { logPdfNav } from '@app/utils/pdfNavLog';
import {
    createPdfRerenderRestorationLogger,
    type IRerenderRestorationContext,
} from '@app/composables/pdf/pdfRerenderRestoration';
import {
    isPageRenderTimeoutError,
    withPageStageTimeout,
    type IPageRenderStallPayload,
    type IPageRenderTimeoutError,
} from '@app/composables/pdf/pdfPageRenderTimeout';

export type { IPageRenderStallPayload } from '@app/composables/pdf/pdfPageRenderTimeout';

interface IUsePdfPageRendererOptions {
    container: Ref<HTMLElement | null>;
    document: ReturnType<typeof usePdfDocument>;
    currentPage: Ref<number>;
    isActive?: MaybeRefOrGetter<boolean>;
    effectiveScale: MaybeRefOrGetter<number>;

    bufferPages?: MaybeRefOrGetter<number>;
    showAnnotations?: MaybeRefOrGetter<boolean>;
    hiddenAnnotationIds?: MaybeRefOrGetter<Set<string>>;
    managedAnnotationIds?: MaybeRefOrGetter<Set<string>>;
    scrollToPage?: (
        pageNumber: number,
        options?: { preferExactDom?: boolean; },
    ) => void;
    suppressSnap?: () => void;
    beginSearchNavigation?: (pageNumber: number) => void;
    endSearchNavigation?: (settleMs?: number) => void;
    outputScale?: number;

    annotationUiManager?: MaybeRefOrGetter<AnnotationEditorUIManager | null>;
    annotationL10n?: MaybeRefOrGetter<IL10n | null>;

    searchPageMatches?: MaybeRefOrGetter<Map<number, IPdfPageMatches>>;
    currentSearchMatch?: MaybeRefOrGetter<IPdfSearchMatch | null>;
    currentSearchMatchNavigationId?: MaybeRefOrGetter<number>;

    workingCopyPath?: MaybeRefOrGetter<TDocumentRef | null>;
    onRenderStall?: (payload: IPageRenderStallPayload) => void;
    onPageRendered?: (pageNumber: number) => void;
}

interface ICancelableRenderTask {
    cancel: () => void;
    promise: Promise<unknown>;
}

interface IRenderVisiblePagesOptions {
    preserveRenderedPages?: boolean;
    bufferOverride?: number;
    forceRerender?: boolean;
    maxCanvasPixelsOverride?: number;
}

interface IRerenderAllVisiblePagesOptions {
    preserveExistingPages?: boolean;
    anchorSnapshot?: IScrollSnapshot | null;
    disableHorizontalAnchorRestore?: boolean;
    disableVerticalAnchorRestore?: boolean;
    disablePageAnchorRestore?: boolean;
    rerenderSource?: string;
    renderBufferOverride?: number;
    maxCanvasPixelsOverride?: number;
}

interface IVisibleRenderBounds {
    renderStart: number;
    renderEnd: number;
}

interface ISinglePageRenderTarget {
    container: HTMLElement;
    canvasHost: HTMLDivElement;
}

interface IRenderVisiblePagesRequest extends IVisibleRenderBounds {
    containerRoot: HTMLElement;
    version: number;
    buffer: number;
    forceRerender: boolean;
}

interface INormalizedRerenderOptions {
    preserveExistingPages: boolean;
    anchorSnapshot: IScrollSnapshot | null;
    disableHorizontalAnchorRestore: boolean;
    disableVerticalAnchorRestore: boolean;
    disablePageAnchorRestore: boolean;
    rerenderSource: string;
    renderBufferOverride?: number;
    maxCanvasPixelsOverride?: number;
}

interface IRerenderAllVisiblePagesOptionsWithExplicitUndefined extends Omit<
    IRerenderAllVisiblePagesOptions,
    'renderBufferOverride' | 'maxCanvasPixelsOverride'
> {
    renderBufferOverride?: number | undefined;
    maxCanvasPixelsOverride?: number | undefined;
}

interface IRerenderRestoreContext extends INormalizedRerenderOptions, IRerenderRestorationContext {
    version: number;
    snapshotToRestore: IScrollSnapshot | null;
}

export const usePdfPageRenderer = (options: IUsePdfPageRendererOptions) => {
    const {
        pdfDocument,
        numPages,
        basePageWidth,
        basePageHeight,
        isLoading,
        getPage,
        evictPage,
        cleanupPageCache,
    } = options.document;
    const ensurePageMetricsInRange = 'ensurePageMetricsInRange' in options.document
        ? options.document.ensurePageMetricsInRange
        : () => Promise.resolve(false);
    const pageMetrics = 'pageMetrics' in options.document
        ? options.document.pageMetrics
        : ref<IPdfPageMetric[]>([]);

    const bufferPages = options.bufferPages ?? 2;
    const showAnnotations = options.showAnnotations ?? true;
    const searchPageMatches =
        options.searchPageMatches ?? new Map<number, IPdfPageMatches>();
    const currentSearchMatch = options.currentSearchMatch ?? null;
    const currentSearchMatchNavigationId = options.currentSearchMatchNavigationId ?? 0;
    const workingCopyPath = options.workingCopyPath ?? null;
    const isActive = options.isActive ?? true;

    const outputScale =
        options.outputScale ??
    (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);

    const canvasRenderer = usePdfCanvasRenderer({ outputScale });
    const textLayerRenderer = usePdfTextLayerRenderer({
        searchPageMatches,
        currentSearchMatch,
        workingCopyPath,
        effectiveScale: options.effectiveScale,
    });
    const annotationLayerRenderer = usePdfAnnotationLayerRenderer({
        numPages,
        currentPage: options.currentPage,
        pdfDocument,
        showAnnotations,
        hiddenAnnotationIds: options.hiddenAnnotationIds ?? new Set<string>(),
        managedAnnotationIds: options.managedAnnotationIds ?? new Set<string>(),
        annotationUiManager: options.annotationUiManager ?? null,
        annotationL10n: options.annotationL10n ?? null,
        ...(options.scrollToPage ? { scrollToPage: options.scrollToPage } : {}),
    });

    const renderMutex = new Mutex();
    const RERENDER_LOG_THROTTLE_MS = 420;
    let renderVersion = 0;

    const renderedPages = new Set<number>();
    const staleRenderedPages = new Set<number>();
    const renderingPages = new Map<number, number>();
    const activeRenderTasks = new Map<number, {
        version: number;
        task: ICancelableRenderTask;
    }>();
    const pageCanvases = new Map<number, HTMLCanvasElement>();
    const textLayerCleanupFns = new Map<number, () => void>();
    const activeTextLayerAbortControllers = new Map<number, {
        version: number;
        controller: AbortController;
    }>();

    const RENDERED_CONTAINER_CLASS = 'page_container--rendered';

    function cancelActiveRenderTask(pageNumber: number) {
        const activeRenderTask = activeRenderTasks.get(pageNumber);
        if (!activeRenderTask) {
            return;
        }
        activeRenderTasks.delete(pageNumber);
        try {
            activeRenderTask.task.cancel();
        } catch {
            // Ignore cancellation failures.
        }
    }

    function cancelAllActiveRenderTasks() {
        for (const pageNumber of Array.from(activeRenderTasks.keys())) {
            cancelActiveRenderTask(pageNumber);
        }
    }

    function cancelActiveTextLayerRender(pageNumber: number) {
        const activeTextLayer = activeTextLayerAbortControllers.get(pageNumber);
        if (!activeTextLayer) {
            return;
        }
        activeTextLayerAbortControllers.delete(pageNumber);
        activeTextLayer.controller.abort();
    }

    function cancelAllActiveTextLayerRenders() {
        for (const pageNumber of Array.from(activeTextLayerAbortControllers.keys())) {
            cancelActiveTextLayerRender(pageNumber);
        }
    }

    function bumpRenderVersion() {
        renderVersion += 1;
        cancelAllActiveRenderTasks();
        cancelAllActiveTextLayerRenders();
        return renderVersion;
    }

    function logNonCriticalStageError(
        pageNumber: number,
        stage: string,
        error: unknown,
    ) {
        BrowserLogger.error(
            'pdf-renderer',
            `Failed to render ${stage} for page ${pageNumber}`,
            error,
        );
    }

    function releasePageResources(
        pageNumber: number,
        pdfPage: PDFPageProxy,
    ) {
        try {
            pdfPage.cleanup();
        } catch (error) {
            BrowserLogger.warn(
                'pdf-renderer',
                `Failed to release PDF page resources for page ${pageNumber}`,
                error,
            );
        }
    }

    function scheduleRenderForSinglePage(
        pageNumber: number,
        optionsOverride: {
            preserveRenderedPages?: boolean;
            bufferOverride?: number;
        },
    ) {
        runGuardedTask(
            () =>
                renderVisiblePages(
                    {
                        start: pageNumber,
                        end: pageNumber,
                    },
                    optionsOverride,
                ),
            {
                scope: 'pdf-renderer',
                message: `Failed to schedule follow-up render for page ${pageNumber}`,
            },
        );
    }

    const searchMatchScroller = createPdfSearchMatchScroller({
        getContainer: () => options.container.value,
        getCurrentSearchMatch: () => toValue(currentSearchMatch),
        scrollToCurrentMatch,
        scheduleRenderForSinglePage: (pageNumber) => {
            scheduleRenderForSinglePage(pageNumber, {
                preserveRenderedPages: true,
                bufferOverride: 0,
            });
        },
        ...(options.scrollToPage ? { scrollToPage: options.scrollToPage } : {}),
        ...(options.suppressSnap ? { suppressSnap: options.suppressSnap } : {}),
        ...(options.beginSearchNavigation ? { beginSearchNavigation: options.beginSearchNavigation } : {}),
        ...(options.endSearchNavigation ? { endSearchNavigation: options.endSearchNavigation } : {}),
    });

    function cleanupTextLayer(pageNumber: number) {
        const cleanup = textLayerCleanupFns.get(pageNumber);
        if (cleanup) {
            cleanup();
            textLayerCleanupFns.delete(pageNumber);
        }
    }

    function cleanupPage(pageNumber: number) {
        const containerRoot = options.container.value;
        cancelActiveRenderTask(pageNumber);
        cancelActiveTextLayerRender(pageNumber);

        cleanupTextLayer(pageNumber);

        const canvas = pageCanvases.get(pageNumber);
        if (canvas) {
            canvasRenderer.cleanupCanvas(canvas);
            pageCanvases.delete(pageNumber);
        }

        renderedPages.delete(pageNumber);
        staleRenderedPages.delete(pageNumber);
        renderingPages.delete(pageNumber);

        annotationLayerRenderer.cleanupEditorLayer(pageNumber);

        if (containerRoot) {
            const container = containerRoot.querySelector<HTMLElement>(
                `.page_container[data-page="${pageNumber}"]`,
            );
            container?.classList.remove(RENDERED_CONTAINER_CLASS);
            const skeleton =
                container?.querySelector<HTMLElement>('.pdf-page-skeleton');
            const canvasHost =
                container?.querySelector<HTMLDivElement>('.page_canvas');
            const textLayerDiv =
                container?.querySelector<HTMLDivElement>('.text-layer');
            const annotationLayerDiv =
                container?.querySelector<HTMLElement>('.annotation-layer');
            const annotationEditorLayerDiv = container?.querySelector<HTMLElement>(
                '.annotation-editor-layer',
            );

            if (canvasHost) {
                canvasHost.innerHTML = '';
            }

            if (skeleton) {
                skeleton.style.display = '';
            }

            if (textLayerDiv) {
                textLayerRenderer.cleanupTextLayerDom(textLayerDiv);
            }

            if (annotationLayerDiv) {
                annotationLayerDiv.innerHTML = '';
            }

            if (annotationEditorLayerDiv) {
                annotationEditorLayerDiv.innerHTML = '';
            }

            if (container) {
                textLayerRenderer.clearOcrDebug(container);
            }
        }

        try {
            evictPage(pageNumber);
        } catch (error) {
            BrowserLogger.error(
                'pdf-renderer',
                'Failed to evict cached PDF page',
                error,
            );
        }
    }

    function shouldKeepStaleRenderedPage(pageNumber: number) {
        return staleRenderedPages.has(pageNumber);
    }

    function cleanupPageIfCurrentRender(pageNumber: number, version: number) {
        if (renderingPages.get(pageNumber) !== version) {
            return;
        }

        if (shouldKeepStaleRenderedPage(pageNumber)) {
            renderingPages.delete(pageNumber);
            return;
        }

        cleanupPage(pageNumber);
    }

    function getTrackedPageNumbersForCleanup() {
        const pagesToCleanup = new Set<number>();
        renderedPages.forEach((page) => pagesToCleanup.add(page));
        renderingPages.forEach((_, page) => pagesToCleanup.add(page));
        pageCanvases.forEach((_, page) => pagesToCleanup.add(page));
        textLayerCleanupFns.forEach((_, page) => pagesToCleanup.add(page));
        return pagesToCleanup;
    }

    function setupPagePlaceholders() {
        const containerRoot = options.container.value;
        const baseWidth = toValue(basePageWidth);
        const baseHeight = toValue(basePageHeight);
        if (!containerRoot || !baseWidth || !baseHeight) {
            return;
        }

        const scale = toValue(options.effectiveScale);
        const normalizedPageMetrics = normalizePageMetrics({
            pageMetrics: pageMetrics.value,
            totalPages: numPages.value,
            fallbackWidth: baseWidth,
            fallbackHeight: baseHeight,
        });
        setupPagePlaceholderSizes(containerRoot, normalizedPageMetrics, scale);
    }

    async function renderPreparedCanvasResult(
        pageNumber: number,
        version: number,
        preparedCanvasRender: NonNullable<Awaited<ReturnType<typeof canvasRenderer.prepareCanvasRender>>>,
    ) {
        const {
            startRender,
            ...preparedRenderResult
        } = preparedCanvasRender;

        return withPageStageTimeout(
            new Promise<typeof preparedRenderResult>((resolve, reject) => {
                const renderTask = startRender();
                if (renderVersion !== version) {
                    try {
                        renderTask.cancel();
                    } catch {
                        // Ignore cancellation failures.
                    }
                    reject(new Error(`Rendering cancelled before canvas paint for page ${pageNumber}`));
                    return;
                }

                const previousTask = activeRenderTasks.get(pageNumber);
                if (previousTask && previousTask.task !== renderTask) {
                    cancelActiveRenderTask(pageNumber);
                }
                activeRenderTasks.set(pageNumber, {
                    version,
                    task: renderTask,
                });

                renderTask.promise.then(
                    () => resolve(preparedRenderResult),
                    reject,
                );
            }),
            {
                pageNumber,
                stage: 'canvas-render',
                timeoutMs: PDF_PAGE_RENDER_TIMEOUT_MS,
            },
            () => renderVersion === version,
            () => {
                cancelActiveRenderTask(pageNumber);
            },
            options.onRenderStall,
        );
    }

    type TCanvasRenderResult = Awaited<ReturnType<typeof renderPreparedCanvasResult>>;
    type TAnnotationLayerInstance = Awaited<
        ReturnType<typeof annotationLayerRenderer.renderAnnotationLayer>
    > | null;

    interface IRenderPageContext {
        container: HTMLElement;
        pdfPage: PDFPageProxy;
        renderResult: TCanvasRenderResult;
        textLayerDiv: HTMLDivElement | null;
        annotationLayerInstance: TAnnotationLayerInstance;
    }

    async function loadPageForRender(
        pageNumber: number,
        version: number,
    ) {
        const pdfPage = await withPageStageTimeout(
            getPage(pageNumber),
            {
                pageNumber,
                stage: 'page-load',
                timeoutMs: PDF_PAGE_LOAD_TIMEOUT_MS,
            },
            () => renderVersion === version,
            undefined,
            options.onRenderStall,
        );
        return renderVersion === version ? pdfPage : null;
    }

    async function prepareCanvasForRender(
        pdfPage: PDFPageProxy,
        pageNumber: number,
        version: number,
        scale: number,
        renderOptions?: IRenderVisiblePagesOptions,
    ) {
        const canvasRenderOptions: Parameters<typeof canvasRenderer.prepareCanvasRender>[2] = {};
        const hiddenAnnotationIds = toValue(options.hiddenAnnotationIds);
        if (hiddenAnnotationIds !== undefined) {
            canvasRenderOptions.hiddenAnnotationIds = hiddenAnnotationIds;
        }
        if (renderOptions?.maxCanvasPixelsOverride !== undefined) {
            canvasRenderOptions.maxCanvasPixels = renderOptions.maxCanvasPixelsOverride;
        }
        const preparedCanvasRender = await canvasRenderer.prepareCanvasRender(
            pdfPage,
            scale,
            canvasRenderOptions,
        );
        if (!preparedCanvasRender) {
            return null;
        }

        if (renderVersion !== version) {
            canvasRenderer.cleanupCanvas(preparedCanvasRender.canvas);
            return null;
        }

        return renderPreparedCanvasResult(
            pageNumber,
            version,
            preparedCanvasRender,
        );
    }

    function mountRenderedCanvas(
        pageNumber: number,
        container: HTMLElement,
        canvasHost: HTMLDivElement,
        renderResult: TCanvasRenderResult,
        scale: number,
    ) {
        const {
            canvas,
            viewport,
            userUnit,
            totalScaleFactor,
        } = renderResult;

        canvasRenderer.applyContainerDimensions(
            container,
            viewport,
            scale,
            userUnit,
            totalScaleFactor,
        );
        const previousCanvas = pageCanvases.get(pageNumber);
        canvasRenderer.mountCanvas(
            canvasHost,
            canvas,
            container,
            RENDERED_CONTAINER_CLASS,
        );
        if (previousCanvas && previousCanvas !== canvas) {
            canvasRenderer.cleanupCanvas(previousCanvas);
        }
        pageCanvases.set(pageNumber, canvas);
    }

    async function renderTextLayerForPage(
        pageNumber: number,
        version: number,
        context: IRenderPageContext,
        scale: number,
    ) {
        const {
            container,
            pdfPage,
            renderResult,
            textLayerDiv,
        } = context;
        if (!textLayerDiv) {
            return true;
        }
        if (renderVersion !== version) {
            cleanupPageIfCurrentRender(pageNumber, version);
            return false;
        }

        const {
            canvas,
            viewport,
            scaleX,
            scaleY,
            rawDims,
            userUnit,
            totalScaleFactor,
        } = renderResult;

        cleanupTextLayer(pageNumber);
        cancelActiveTextLayerRender(pageNumber);
        let isTextLayerRendered = false;

        try {
            const controller = new AbortController();
            activeTextLayerAbortControllers.set(pageNumber, {
                version,
                controller,
            });
            await withPageStageTimeout(
                textLayerRenderer.renderTextLayer(
                    pdfPage,
                    textLayerDiv,
                    viewport,
                    scale,
                    userUnit,
                    totalScaleFactor,
                    controller.signal,
                ),
                {
                    pageNumber,
                    stage: 'text-layer',
                    timeoutMs: PDF_PAGE_TEXT_LAYER_TIMEOUT_MS,
                },
                () => renderVersion === version,
                () => {
                    cancelActiveTextLayerRender(pageNumber);
                },
                options.onRenderStall,
            );
            isTextLayerRendered = true;
        } catch (textLayerError) {
            if (isPageRenderTimeoutError(textLayerError)) {
                throw textLayerError;
            }
            if (
                renderVersion !== version
                || (
                    textLayerError
                    && typeof textLayerError === 'object'
                    && (textLayerError as { name?: unknown }).name === 'AbortError'
                )
            ) {
                textLayerRenderer.cleanupTextLayerDom(textLayerDiv);
                cleanupPageIfCurrentRender(pageNumber, version);
                return false;
            }
            logNonCriticalStageError(
                pageNumber,
                'text layer',
                textLayerError,
            );
            textLayerRenderer.cleanupTextLayerDom(textLayerDiv);
        } finally {
            const activeTextLayer = activeTextLayerAbortControllers.get(pageNumber);
            if (activeTextLayer?.version === version) {
                activeTextLayerAbortControllers.delete(pageNumber);
            }
        }

        if (renderVersion !== version) {
            cleanupPageIfCurrentRender(pageNumber, version);
            return false;
        }

        if (!isTextLayerRendered) {
            return true;
        }

        try {
            const cleanup =
                textLayerRenderer.setupTextLayerInteraction(textLayerDiv);
            if (typeof cleanup === 'function') {
                textLayerCleanupFns.set(pageNumber, cleanup);
            }
        } catch (textLayerInteractionError) {
            logNonCriticalStageError(
                pageNumber,
                'text layer interaction',
                textLayerInteractionError,
            );
        }

        try {
            textLayerRenderer.applyPageSearchHighlights(
                container,
                textLayerDiv,
                pageNumber,
                canvas,
                {
                    userUnit,
                    totalScaleFactor,
                    viewportWidth: viewport.width,
                    viewportHeight: viewport.height,
                    rawPageWidth: rawDims.pageWidth,
                    rawPageHeight: rawDims.pageHeight,
                    canvasPixelWidth: canvas.width,
                    canvasPixelHeight: canvas.height,
                    renderScaleX: scaleX,
                    renderScaleY: scaleY,
                },
            );
        } catch (searchHighlightError) {
            logNonCriticalStageError(
                pageNumber,
                'search highlights',
                searchHighlightError,
            );
        }

        return true;
    }

    async function renderAnnotationLayersForPage(
        pageNumber: number,
        version: number,
        context: IRenderPageContext,
    ) {
        const {
            container,
            pdfPage,
            renderResult,
            textLayerDiv,
        } = context;
        const {
            viewport,
            annotationCanvasMap,
        } = renderResult;
        const annotationLayerDiv =
            container.querySelector<HTMLElement>('.annotation-layer');
        let annotationLayerInstance: TAnnotationLayerInstance = null;
        if (annotationLayerDiv && toValue(showAnnotations)) {
            if (renderVersion !== version) {
                cleanupPageIfCurrentRender(pageNumber, version);
                return {
                    shouldContinue: false,
                    annotationLayerInstance: null,
                };
            }

            try {
                annotationLayerInstance =
                    await annotationLayerRenderer.renderAnnotationLayer(
                        pdfPage,
                        annotationLayerDiv,
                        viewport,
                        pageNumber,
                        annotationCanvasMap,
                    );
            } catch (annotationError) {
                logNonCriticalStageError(
                    pageNumber,
                    'annotation layer',
                    annotationError,
                );
            }

            if (renderVersion !== version) {
                cleanupPageIfCurrentRender(pageNumber, version);
                return {
                    shouldContinue: false,
                    annotationLayerInstance: null,
                };
            }
        }

        const annotationEditorLayerDiv =
            container.querySelector<HTMLElement>('.annotation-editor-layer');
        if (
            annotationEditorLayerDiv &&
            toValue(options.annotationUiManager)
        ) {
            try {
                annotationLayerRenderer.renderAnnotationEditorLayer(
                    container,
                    annotationEditorLayerDiv,
                    textLayerDiv,
                    viewport,
                    pageNumber,
                    annotationLayerInstance,
                );
            } catch (annotationEditorError) {
                logNonCriticalStageError(
                    pageNumber,
                    'annotation editor layer',
                    annotationEditorError,
                );
            }
        }

        return {
            shouldContinue: true,
            annotationLayerInstance,
        };
    }

    function finalizePageRender(
        pageNumber: number,
        version: number,
        pdfPage: PDFPageProxy,
    ) {
        if (renderVersion !== version) {
            return;
        }

        // Once the canvas and DOM layers are in place, ask PDF.js to
        // release per-page render resources while keeping the visible
        // output mounted. This reduces retained image/operator memory
        // for raster-heavy documents such as DjVu conversions.
        releasePageResources(pageNumber, pdfPage);
        renderedPages.add(pageNumber);
        staleRenderedPages.delete(pageNumber);
        options.onPageRendered?.(pageNumber);
    }

    function shouldSkipSingleVisiblePageRender(
        pageNumber: number,
        version: number,
        forceRerender: boolean,
    ) {
        if (renderVersion !== version) {
            return true;
        }

        if (renderedPages.has(pageNumber)) {
            const isStaleRender = staleRenderedPages.has(pageNumber);
            if (!forceRerender && !isStaleRender) {
                return true;
            }
        }

        return renderingPages.get(pageNumber) === version;
    }

    function getSinglePageRenderTarget(
        containerRoot: HTMLElement,
        pageNumber: number,
    ): ISinglePageRenderTarget | null {
        const container = getPageContainer(containerRoot, pageNumber - 1);
        if (!container) {
            return null;
        }

        const canvasHost =
            container.querySelector<HTMLDivElement>('.page_canvas');
        if (!canvasHost) {
            return null;
        }

        return {
            container,
            canvasHost,
        };
    }

    async function mountSingleVisiblePageLayers(
        pageNumber: number,
        version: number,
        scale: number,
        target: ISinglePageRenderTarget,
        pdfPage: PDFPageProxy,
        renderResult: Awaited<ReturnType<typeof prepareCanvasForRender>>,
    ) {
        if (!renderResult) {
            return;
        }

        if (renderVersion !== version) {
            canvasRenderer.cleanupCanvas(renderResult.canvas);
            return;
        }

        mountRenderedCanvas(pageNumber, target.container, target.canvasHost, renderResult, scale);

        const textLayerDiv =
            target.container.querySelector<HTMLDivElement>('.text-layer');
        const renderContext: IRenderPageContext = {
            container: target.container,
            pdfPage,
            renderResult,
            textLayerDiv,
            annotationLayerInstance: null,
        };
        const shouldContinueAfterTextLayer = await renderTextLayerForPage(
            pageNumber,
            version,
            renderContext,
            scale,
        );
        if (!shouldContinueAfterTextLayer) {
            return;
        }

        const annotationRenderResult = await renderAnnotationLayersForPage(
            pageNumber,
            version,
            renderContext,
        );
        if (!annotationRenderResult.shouldContinue) {
            return;
        }

        renderContext.annotationLayerInstance =
            annotationRenderResult.annotationLayerInstance;
        textLayerRenderer.scheduleOcrDebugForPage?.(pageNumber, renderContext);
        finalizePageRender(pageNumber, version, pdfPage);
    }

    function scheduleCancelledPageRenderRetry(pageNumber: number, version: number) {
        if (renderVersion !== version) {
            return;
        }

        setTimeout(() => {
            if (renderVersion !== version) {
                return;
            }
            scheduleRenderForSinglePage(pageNumber, {
                preserveRenderedPages: true,
                bufferOverride: 0,
            });
        }, 0);
    }

    function logPageRenderTimeout(error: IPageRenderTimeoutError, version: number) {
        BrowserLogger.warn(
            'pdf-renderer',
            `Timed out waiting for ${error.stage} on page ${error.pageNumber}`,
            {
                pageNumber: error.pageNumber,
                stage: error.stage,
                timeoutMs: error.timeoutMs,
                renderVersion: version,
                currentRenderVersion: renderVersion,
                currentPage: options.currentPage.value,
                totalPages: numPages.value,
            },
        );
    }

    function handleSinglePageRenderError(
        error: unknown,
        pageNumber: number,
        version: number,
    ) {
        if (isRenderingCancelledError(error)) {
            scheduleCancelledPageRenderRetry(pageNumber, version);
            return;
        }

        if (isPageRenderTimeoutError(error)) {
            logPageRenderTimeout(error, version);
            cleanupPageIfCurrentRender(pageNumber, version);
            return;
        }

        BrowserLogger.error(
            'pdf-renderer',
            formatRenderError(error, pageNumber),
        );
        cleanupPageIfCurrentRender(pageNumber, version);
    }

    function clearSinglePageRenderTracking(pageNumber: number, version: number) {
        const activeRenderTask = activeRenderTasks.get(pageNumber);
        if (activeRenderTask && activeRenderTask.version === version) {
            activeRenderTasks.delete(pageNumber);
        }
        if (renderingPages.get(pageNumber) === version) {
            renderingPages.delete(pageNumber);
        }
    }

    async function renderSingleVisiblePage(
        containerRoot: HTMLElement,
        pageNumber: number,
        version: number,
        scale: number,
        forceRerender: boolean,
        renderOptions?: IRenderVisiblePagesOptions,
    ) {
        if (shouldSkipSingleVisiblePageRender(pageNumber, version, forceRerender)) {
            return;
        }

        renderingPages.set(pageNumber, version);

        try {
            const target = getSinglePageRenderTarget(containerRoot, pageNumber);
            if (!target) {
                return;
            }

            const pdfPage = await loadPageForRender(pageNumber, version);
            if (!pdfPage) {
                return;
            }

            const renderResult = await prepareCanvasForRender(
                pdfPage,
                pageNumber,
                version,
                scale,
                renderOptions,
            );
            if (!renderResult) {
                return;
            }

            await mountSingleVisiblePageLayers(
                pageNumber,
                version,
                scale,
                target,
                pdfPage,
                renderResult,
            );
        } catch (error) {
            handleSinglePageRenderError(error, pageNumber, version);
        } finally {
            clearSinglePageRenderTracking(pageNumber, version);
        }
    }

    function getVisibleRenderBounds(
        visibleRange: IPageRange,
        buffer: number,
    ): IVisibleRenderBounds {
        return {
            renderStart: Math.max(1, visibleRange.start - buffer),
            renderEnd: Math.min(numPages.value, visibleRange.end + buffer),
        };
    }

    function getRenderVisiblePagesRequest(
        visibleRange: IPageRange,
        renderOptions?: IRenderVisiblePagesOptions,
    ): IRenderVisiblePagesRequest | null {
        const containerRoot = options.container.value;
        if (!containerRoot || numPages.value === 0) {
            return null;
        }

        const version = renderVersion;
        const buffer = renderOptions?.bufferOverride ?? toValue(bufferPages);
        const forceRerender = renderOptions?.forceRerender ?? false;
        return {
            containerRoot,
            version,
            buffer,
            forceRerender,
            ...getVisibleRenderBounds(visibleRange, buffer),
        };
    }

    async function hydratePageMetricsForVisibleRender(request: IRenderVisiblePagesRequest) {
        const didHydrateMetrics = await ensurePageMetricsInRange(
            request.renderStart,
            request.renderEnd,
        );
        if (renderVersion !== request.version) {
            return false;
        }
        if (didHydrateMetrics) {
            setupPagePlaceholders();
        }
        return true;
    }

    function cleanupRenderedPagesOutside(pagesToKeep: Set<number>) {
        for (const pageNum of renderedPages) {
            if (!pagesToKeep.has(pageNum)) {
                cleanupPage(pageNum);
            }
        }
    }

    function getPagesToRenderNow(
        renderStart: number,
        renderEnd: number,
        forceRerender: boolean,
    ) {
        return range(renderStart, renderEnd + 1).filter(
            (i) => forceRerender || staleRenderedPages.has(i) || !renderedPages.has(i),
        );
    }

    async function waitForMountedPageContainers(
        containerRoot: HTMLElement,
        pagesToRenderNow: number[],
        visibleRange: IPageRange,
        version: number,
    ) {
        let pagesMissingMountedContainer: number[] = [];

        for (let attempt = 0; attempt < 4; attempt += 1) {
            pagesMissingMountedContainer = pagesToRenderNow.filter(
                (pageNumber) => !getPageContainer(containerRoot, pageNumber - 1),
            );
            if (pagesMissingMountedContainer.length === 0 || renderVersion !== version) {
                return;
            }

            await nextTick();
        }

        BrowserLogger.warnThrottled(
            'pdf-renderer',
            'render-visible-wait-for-mounted-pages',
            RERENDER_LOG_THROTTLE_MS,
            'Waiting for virtualized page containers before rendering',
            {
                pagesMissingMountedContainer,
                visibleRange,
                renderVersion: version,
                currentRenderVersion: renderVersion,
                currentPage: options.currentPage.value,
            },
        );
    }

    async function renderVisiblePageBatches(
        containerRoot: HTMLElement,
        pagesToRenderNow: number[],
        version: number,
        scale: number,
        forceRerender: boolean,
        renderOptions?: IRenderVisiblePagesOptions,
    ) {
        for (const batch of chunk(pagesToRenderNow, CONCURRENT_RENDERS)) {
            await Promise.all(
                batch.map((pageNumber) => renderSingleVisiblePage(
                    containerRoot,
                    pageNumber,
                    version,
                    scale,
                    forceRerender,
                    renderOptions,
                )),
            );
        }
    }

    async function renderVisiblePages(
        visibleRange: IPageRange,
        renderOptions?: IRenderVisiblePagesOptions,
    ) {
        if (!toValue(isActive)) {
            return;
        }
        const request = getRenderVisiblePagesRequest(visibleRange, renderOptions);
        if (!request) {
            return;
        }

        const {
            renderStart,
            renderEnd,
            forceRerender,
            containerRoot,
            version,
        } = request;
        if (!await hydratePageMetricsForVisibleRender(request)) {
            return;
        }

        const pagesToKeep = new Set(range(renderStart, renderEnd + 1));

        if (!renderOptions?.preserveRenderedPages) {
            cleanupRenderedPagesOutside(pagesToKeep);
        }

        const pagesToRenderNow = getPagesToRenderNow(renderStart, renderEnd, forceRerender);

        if (pagesToRenderNow.length === 0) {
            return;
        }

        await waitForMountedPageContainers(
            containerRoot,
            pagesToRenderNow,
            visibleRange,
            version,
        );
        if (renderVersion !== version) {
            return;
        }

        const scale = toValue(options.effectiveScale);
        await renderVisiblePageBatches(
            containerRoot,
            pagesToRenderNow,
            version,
            scale,
            forceRerender,
            renderOptions,
        );
    }

    const {
        logRerenderSnapshotCapture,
        restoreScrollAndLog,
    } = createPdfRerenderRestorationLogger({
        container: options.container,
        currentPage: options.currentPage,
        numPages,
        throttleMs: RERENDER_LOG_THROTTLE_MS,
    });

    function normalizeRerenderOptions(
        rerenderOptions?: IRerenderAllVisiblePagesOptionsWithExplicitUndefined,
    ): INormalizedRerenderOptions {
        const {
            preserveExistingPages = false,
            anchorSnapshot = null,
            disableHorizontalAnchorRestore = false,
            disableVerticalAnchorRestore = false,
            disablePageAnchorRestore = false,
            rerenderSource = 'unknown',
            renderBufferOverride,
            maxCanvasPixelsOverride,
        } = rerenderOptions ?? {};

        const normalized: INormalizedRerenderOptions = {
            preserveExistingPages,
            anchorSnapshot,
            disableHorizontalAnchorRestore,
            disableVerticalAnchorRestore,
            disablePageAnchorRestore,
            rerenderSource,
        };
        if (renderBufferOverride !== undefined) {
            normalized.renderBufferOverride = renderBufferOverride;
        }
        if (maxCanvasPixelsOverride !== undefined) {
            normalized.maxCanvasPixelsOverride = maxCanvasPixelsOverride;
        }
        return normalized;
    }

    async function getMountedVisibleRangeAfterRestore(
        version: number,
        getVisibleRange: () => IPageRange,
    ) {
        await nextTick();
        if (renderVersion !== version) {
            return null;
        }
        const range = getVisibleRange();
        await nextTick();
        if (renderVersion !== version) {
            return null;
        }
        return range;
    }

    async function renderMountedVisiblePagesAfterRestore(
        version: number,
        getVisibleRange: () => IPageRange,
        renderBufferOverride: number | undefined,
        maxCanvasPixelsOverride: number | undefined,
        optionsOverride?: {
            preserveRenderedPages?: boolean;
            forceRerender?: boolean;
        },
    ) {
        if (renderVersion !== version) {
            return false;
        }

        const visibleRange = await getMountedVisibleRangeAfterRestore(version, getVisibleRange);
        if (visibleRange === null) {
            return false;
        }
        const renderOptions: IRenderVisiblePagesOptions = {...optionsOverride};
        if (renderBufferOverride !== undefined) {
            renderOptions.bufferOverride = renderBufferOverride;
        }
        if (maxCanvasPixelsOverride !== undefined) {
            renderOptions.maxCanvasPixelsOverride = maxCanvasPixelsOverride;
        }
        await renderVisiblePages(visibleRange, renderOptions);
        return true;
    }

    async function reRenderAllVisiblePages(
        getVisibleRange: () => IPageRange,
        rerenderOptions?: IRerenderAllVisiblePagesOptionsWithExplicitUndefined,
    ): Promise<void>;
    async function reRenderAllVisiblePages(
        getVisibleRange: () => IPageRange,
        rerenderOptions?: IRerenderAllVisiblePagesOptions,
    ): Promise<void>;
    async function reRenderAllVisiblePages(
        getVisibleRange: () => IPageRange,
        rerenderOptions?: IRerenderAllVisiblePagesOptionsWithExplicitUndefined,
    ) {
        if (!toValue(isActive)) {
            return;
        }
        const normalizedOptions = normalizeRerenderOptions(rerenderOptions);
        const { preserveExistingPages } = normalizedOptions;
        const version = bumpRenderVersion();
        const containerAtCapture = options.container.value;
        const snapshot = captureScrollSnapshot(containerAtCapture);
        const restoreContext: IRerenderRestoreContext = {
            ...normalizedOptions,
            version,
            snapshotToRestore: normalizedOptions.anchorSnapshot ?? snapshot,
        };

        logRerenderSnapshotCapture(
            version,
            preserveExistingPages,
            normalizedOptions.anchorSnapshot,
            snapshot,
            containerAtCapture,
        );

        await renderMutex.acquire();

        try {
            if (renderVersion !== version) {
                return;
            }

            if (preserveExistingPages) {
                renderedPages.forEach((page) => staleRenderedPages.add(page));

                setupPagePlaceholders();

                if (renderVersion === version) {
                    restoreScrollAndLog('preserve', restoreContext);
                }

                await renderMountedVisiblePagesAfterRestore(
                    version,
                    getVisibleRange,
                    normalizedOptions.renderBufferOverride,
                    normalizedOptions.maxCanvasPixelsOverride,
                    {
                        preserveRenderedPages: true,
                        forceRerender: true,
                    },
                );
                return;
            }

            getTrackedPageNumbersForCleanup().forEach((page) => cleanupPage(page));

            setupPagePlaceholders();

            if (renderVersion === version) {
                restoreScrollAndLog('full', restoreContext);
            }
            await renderMountedVisiblePagesAfterRestore(
                version,
                getVisibleRange,
                normalizedOptions.renderBufferOverride,
                normalizedOptions.maxCanvasPixelsOverride,
            );
        } finally {
            renderMutex.release();
        }
    }

    function cleanupAllPages() {
        bumpRenderVersion();

        getTrackedPageNumbersForCleanup().forEach((page) => cleanupPage(page));

        for (const [
            , canvas,
        ] of pageCanvases) {
            canvasRenderer.cleanupCanvas(canvas);
        }

        pageCanvases.clear();
        renderedPages.clear();
        staleRenderedPages.clear();
        renderingPages.clear();
        textLayerCleanupFns.clear();
        annotationLayerRenderer.clearAllLayers();

        searchMatchScroller.invalidatePendingRequests();

        try {
            cleanupPageCache();
        } catch (error) {
            BrowserLogger.error(
                'pdf-renderer',
                'Failed to clean up PDF page cache',
                error,
            );
        }
    }

    function applySearchHighlights() {
        const containerRoot = options.container.value;
        if (!containerRoot) {
            return;
        }
        try {
            textLayerRenderer.applyAllSearchHighlights(containerRoot);
        } catch (error) {
            BrowserLogger.error(
                'pdf-renderer',
                'Failed to apply search highlights',
                error,
            );
        }
    }

    function scrollToCurrentMatch() {
        const containerRoot = options.container.value;
        if (!containerRoot) {
            return false;
        }

        let result = false;
        try {
            result = textLayerRenderer.scrollToCurrentMatch(containerRoot);
        } catch (error) {
            BrowserLogger.error(
                'pdf-renderer',
                'Failed to scroll to current match',
                error,
            );
            return false;
        }
        logPdfNav(`[PDF-NAV] scrollToCurrentMatch result=${result}`);
        if (result) {
            options.suppressSnap?.();
        }
        return result;
    }

    let lastHandledSearchNavigationId = 0;

    watch(
        () => {
            const match = toValue(currentSearchMatch);
            return [
                isLoading.value,
                toValue(searchPageMatches),
                match?.pageIndex ?? -1,
                match?.matchIndex ?? -1,
                match?.startOffset ?? -1,
                match?.endOffset ?? -1,
            ] as const;
        },
        () => {
            if (!toValue(isActive)) {
                return;
            }
            if (isLoading.value) {
                return;
            }

            applySearchHighlights();
        },
    );

    watch(
        () => [
            toValue(isActive),
            isLoading.value,
            toValue(currentSearchMatchNavigationId),
        ] as const,
        ([
            active,
            loading,
            navigationId,
        ]) => {
            if (!active) {
                return;
            }
            if (navigationId <= 0 || navigationId === lastHandledSearchNavigationId) {
                return;
            }
            if (loading) {
                return;
            }

            const currentMatchValue = toValue(currentSearchMatch);
            const matchPageIndex = currentMatchValue && numPages.value > 0
                ? clamp(currentMatchValue.pageIndex, 0, numPages.value - 1)
                : null;

            if (matchPageIndex === null) {
                searchMatchScroller.invalidatePendingRequests();
                lastHandledSearchNavigationId = navigationId;
                return;
            }

            logPdfNav(`[PDF-NAV] navigation watcher: requestScrollToMatch(${matchPageIndex})`);
            lastHandledSearchNavigationId = navigationId;
            searchMatchScroller.requestScrollToMatch(matchPageIndex);
        },
    );

    function invalidatePages(pages: number[]) {
        bumpRenderVersion();
        for (const pageNumber of pages) {
            cleanupPage(pageNumber);
        }
    }

    function cancelInFlightRenders() {
        bumpRenderVersion();
    }

    function requestScrollToCurrentResult() {
        if (!toValue(isActive)) {
            return;
        }
        const currentMatchValue = toValue(currentSearchMatch);
        if (!currentMatchValue) {
            return;
        }
        searchMatchScroller.requestScrollToMatch(currentMatchValue.pageIndex);
    }

    return {
        setupPagePlaceholders,
        renderVisiblePages,
        reRenderAllVisiblePages,
        cleanupAllPages,
        invalidatePages,
        applySearchHighlights,
        hideManagedAnnotationEditors: (pageNumber?: number) => {
            annotationLayerRenderer.hideHiddenManagedEditors(pageNumber);
        },
        isPageRendered: (pageNumber: number) => renderedPages.has(pageNumber),
        requestScrollToCurrentResult,
        cancelPendingSearchScroll: searchMatchScroller.invalidatePendingRequests,
        cancelInFlightRenders,
    };
};
