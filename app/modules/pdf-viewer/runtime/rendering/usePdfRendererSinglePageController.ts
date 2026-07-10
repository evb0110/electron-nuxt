import type {
    IActivePdfRenderTask,
    ICancelableRenderTask,
    IRenderVisiblePagesOptions,
    TClearSelectionBeforePageLayerTeardown,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import type { IPageRange } from '@app/types/pdfUi';
import type { IPdfViewerTransactionRenderRequest } from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';
import type { MaybeRefOrGetter } from 'vue';
import type { PDFPageProxy } from 'pdfjs-dist';
import type {
    IArmPdfRenderSupervisorTimerOptions,
    IPdfRenderSupervisor,
} from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';
import type { TAnnotationEditorLayerRenderResult } from '@app/modules/pdf-viewer/runtime/rendering/usePdfAnnotationLayerRenderer';
import { getPageContainer } from '@app/modules/pdf-viewer/engine/pdf-page-buffer-manager/getPageContainer';
import { formatRenderError } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/formatRenderError';
import { isRenderingCancelledError } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/isRenderingCancelledError';
import { isPageRenderTimeoutError } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/isPageRenderTimeoutError';
import type { IPageRenderTimeoutError } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/pdfPageRenderTimeoutTypes';
import { withPageStageTimeout } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/withPageStageTimeout';
import { PDF_PAGE_RENDER_TIMEOUT_MS } from '@app/constants/timeouts';
import { pdfViewerDomClasses } from '@app/modules/pdf-viewer/dom/pdf-viewer-dom/pdfViewerDomClasses';
import { BrowserLogger } from '@app/utils/browserLogger';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';


const TEXT_LAYER_FIRST_NAVIGATION_YIELD_MS = 50;

interface ISinglePageRenderTarget {
    container: HTMLElement;
    canvasHost: HTMLDivElement;
}

interface IRenderPageContext<TRenderResult> {
    container: HTMLElement;
    pdfPage: PDFPageProxy;
    renderResult: TRenderResult;
    textLayerDiv: HTMLDivElement | null;
    annotationLayerInstance: unknown;
}

interface IPdfPageRenderLease {
    pdfPage: PDFPageProxy;
    release: () => void;
}

interface IUsePdfRendererSinglePageControllerOptions<TRenderResult> {
    isActive: MaybeRefOrGetter<boolean>;
    effectiveScale: MaybeRefOrGetter<number>;
    annotationUiManager: MaybeRefOrGetter<unknown>;
    getContainerRoot: () => HTMLElement | null;
    renderedPages: Set<number>;
    staleRenderedPages: Set<number>;
    renderingPages: Map<number, number>;
    renderingPageRequestIds: Map<number, number>;
    activeRenderTasks: Map<number, IActivePdfRenderTask>;
    getRenderVersion: () => number;
    getRenderDocumentToken: () => string;
    getVisibleRenderRequestId: () => number;
    summarizePageDom: (pageNumber: number) => Record<string, unknown>;
    clearSelectionBeforePageLayerTeardown: TClearSelectionBeforePageLayerTeardown;
    cleanupPageIfCurrentRender: (pageNumber: number, version: number, requestId?: number) => void;
    cleanupCanvasRenderResult: (renderResult: TRenderResult) => void;
    releasePageResources: (pageNumber: number, pdfPage: PDFPageProxy) => void;
    loadPageForRender: (
        pageNumber: number,
        version: number,
        shouldContinue: () => boolean,
    ) => Promise<PDFPageProxy | null>;
    prepareCanvasForRender: (
        pdfPage: PDFPageProxy,
        pageNumber: number,
        version: number,
        requestId: number,
        scale: number,
        shouldContinue: () => boolean,
        renderOptions?: IRenderVisiblePagesOptions,
    ) => Promise<TRenderResult | null>;
    prepareCanvasRenderForPage: (
        pdfPage: PDFPageProxy,
        pageNumber: number,
        version: number,
        requestId: number,
        scale: number,
        shouldContinue: () => boolean,
        renderOptions?: IRenderVisiblePagesOptions,
    ) => Promise<(TRenderResult & { startRender: () => ICancelableRenderTask }) | null>;
    renderPreparedCanvasForPage: (
        pdfPage: PDFPageProxy,
        pageNumber: number,
        version: number,
        requestId: number,
        preparedCanvasRender: TRenderResult & { startRender: () => ICancelableRenderTask },
        shouldContinue: () => boolean,
    ) => Promise<TRenderResult | null>;
    applyContainerDimensions: (
        container: HTMLElement,
        renderResult: TRenderResult,
        scale: number,
    ) => void;
    mountRenderedCanvas: (
        pageNumber: number,
        container: HTMLElement,
        canvasHost: HTMLDivElement,
        renderResult: TRenderResult,
        scale: number,
    ) => void;
    scheduleRenderForSinglePage: (
        pageNumber: number,
        optionsOverride: IRenderVisiblePagesOptions,
        transactionRequest?: IPdfViewerTransactionRenderRequest | undefined,
    ) => void;
    scheduleMissingRenderTargetRetry: (
        pageNumber: number,
        version: number,
        requestId: number,
        shouldRetry: boolean,
        visibleRange: IPageRange,
        documentToken: string,
        transactionRequest?: IPdfViewerTransactionRenderRequest | undefined,
    ) => void;
    clearMissingRenderTargetRetry: (pageNumber: number) => void;
    waitForRenderLifecycleDelay: (
        timerOptions: Omit<IArmPdfRenderSupervisorTimerOptions, 'onFire'>,
    ) => Promise<boolean>;
    renderTextLayerForPage: (
        pageNumber: number,
        version: number,
        requestId: number,
        context: IRenderPageContext<TRenderResult>,
        scale: number,
        shouldContinue: () => boolean,
    ) => Promise<boolean>;
    renderAnnotationLayersForPage: (
        pageNumber: number,
        version: number,
        requestId: number,
        context: IRenderPageContext<TRenderResult>,
        shouldContinue: () => boolean,
    ) => Promise<{
        shouldContinue: boolean;
        annotationLayerInstance: unknown;
    }>;
    renderAnnotationEditorLayer: (
        container: HTMLElement,
        annotationEditorLayerDiv: HTMLElement,
        textLayerDiv: HTMLDivElement | null,
        viewport: ReturnType<PDFPageProxy['getViewport']>,
        pageNumber: number,
        annotationLayerInstance: null,
        options?: {
            shouldContinue?: () => boolean;
            signal?: AbortSignal;
        },
    ) => Promise<TAnnotationEditorLayerRenderResult>;
    getViewportForAnnotationEditorLayer: (pdfPage: PDFPageProxy, scale: number) => ReturnType<PDFPageProxy['getViewport']>;
    scheduleOcrDebugForPage: (pageNumber: number, context: IRenderPageContext<TRenderResult>) => void;
    onPageCanvasMounted?: ((pageNumber: number) => void) | undefined;
    onPageRendered?: ((pageNumber: number) => void) | undefined;
    onRenderedPageStateChanged?: (() => void) | undefined;
    logNonCriticalStageError: (pageNumber: number, stage: string, error: unknown) => void;
    renderSupervisor?: IPdfRenderSupervisor | undefined;
}

export const usePdfRendererSinglePageController = <TRenderResult>(
    options: IUsePdfRendererSinglePageControllerOptions<TRenderResult>,
) => {
    const {
        isActive,
        effectiveScale,
        annotationUiManager: annotationUiManagerRef,
        getContainerRoot,
        renderedPages,
        staleRenderedPages,
        renderingPages,
        renderingPageRequestIds,
        activeRenderTasks,
        getRenderVersion,
        getRenderDocumentToken,
        getVisibleRenderRequestId,
        summarizePageDom,
        clearSelectionBeforePageLayerTeardown,
        cleanupPageIfCurrentRender,
        cleanupCanvasRenderResult,
        releasePageResources,
        loadPageForRender,
        prepareCanvasRenderForPage,
        renderPreparedCanvasForPage,
        prepareCanvasForRender,
        applyContainerDimensions,
        mountRenderedCanvas,
        scheduleRenderForSinglePage,
        scheduleMissingRenderTargetRetry,
        clearMissingRenderTargetRetry,
        waitForRenderLifecycleDelay,
        renderTextLayerForPage,
        renderAnnotationLayersForPage,
        renderAnnotationEditorLayer,
        getViewportForAnnotationEditorLayer,
        scheduleOcrDebugForPage,
        onPageCanvasMounted,
        onPageRendered,
        onRenderedPageStateChanged,
        logNonCriticalStageError,
    } = options;

    function cleanupStaleMountedPageRender(
        pageNumber: number,
        version: number,
        requestId: number,
        pageLease: IPdfPageRenderLease,
    ) {
        cleanupPageIfCurrentRender(pageNumber, version, requestId);
        pageLease.release();
    }

    function createPageRenderLease(
        pageNumber: number,
        pdfPage: PDFPageProxy,
    ): IPdfPageRenderLease {
        let released = false;
        return {
            pdfPage,
            release: () => {
                if (released) {
                    return;
                }
                released = true;
                releasePageResources(pageNumber, pdfPage);
            },
        };
    }

    function finalizePageRender(
        pageNumber: number,
        version: number,
        pageLease: IPdfPageRenderLease,
        pageContainer: HTMLElement,
        shouldContinue: () => boolean,
    ) {
        if (getRenderVersion() !== version || !shouldContinue()) {
            logPdfRenderTrace('renderer-finalize-page-skip-stale', {
                pageNumber,
                version,
                renderVersion: getRenderVersion(),
                pageBeforeSkip: summarizePageDom(pageNumber),
            });
            return false;
        }

        pageLease.release();
        renderedPages.add(pageNumber);
        staleRenderedPages.delete(pageNumber);
        pageContainer.classList.add(pdfViewerDomClasses.renderedPageContainer);
        logPdfRenderTrace('renderer-finalize-page', {
            pageNumber,
            version,
            renderVersion: getRenderVersion(),
            pageBeforeNotify: summarizePageDom(pageNumber),
        });
        onPageRendered?.(pageNumber);
        onRenderedPageStateChanged?.();
        return true;
    }

    function shouldSkipSingleVisiblePageRender(
        pageNumber: number,
        version: number,
        forceRerender: boolean,
        target: ISinglePageRenderTarget,
        requestId: number,
    ) {
        if (getRenderVersion() !== version) {
            return true;
        }

        if (renderingPages.get(pageNumber) === version) {
            return renderingPageRequestIds.get(pageNumber) === requestId;
        }

        if (renderedPages.has(pageNumber)) {
            const isStaleRender = staleRenderedPages.has(pageNumber);
            const hasMountedCanvas = Boolean(
                target.container.querySelector<HTMLCanvasElement>('.page_canvas canvas'),
            );
            if (!forceRerender && !isStaleRender && hasMountedCanvas) {
                return true;
            }
        }

        return false;
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
        pageLease: IPdfPageRenderLease,
        renderResult: TRenderResult | null,
        requestId: number,
        shouldContinue: () => boolean,
    ) {
        const { pdfPage } = pageLease;
        if (!renderResult) {
            return;
        }

        if (getRenderVersion() !== version || !shouldContinue()) {
            cleanupCanvasRenderResult(renderResult);
            pageLease.release();
            return;
        }
        if (!isCurrentMountedRenderTarget(pageNumber, version, target, shouldContinue)) {
            cleanupCanvasRenderResult(renderResult);
            pageLease.release();
            clearSinglePageRenderTracking(pageNumber, version, requestId);
            return;
        }

        mountRenderedCanvas(pageNumber, target.container, target.canvasHost, renderResult, scale);
        logPdfRenderTrace('renderer-canvas-mounted', {
            pageNumber,
            version,
            requestId,
            page: summarizePageDom(pageNumber),
        });
        onPageCanvasMounted?.(pageNumber);

        const textLayerDiv =
            target.container.querySelector<HTMLDivElement>('.text-layer');
        const renderContext: IRenderPageContext<TRenderResult> = {
            container: target.container,
            pdfPage,
            renderResult,
            textLayerDiv,
            annotationLayerInstance: null,
        };
        const shouldContinueAfterTextLayer = await renderTextLayerForPage(
            pageNumber,
            version,
            requestId,
            renderContext,
            scale,
            shouldContinue,
        );
        if (!shouldContinueAfterTextLayer) {
            cleanupStaleMountedPageRender(pageNumber, version, requestId, pageLease);
            return;
        }
        if (!shouldContinue()) {
            cleanupStaleMountedPageRender(pageNumber, version, requestId, pageLease);
            return;
        }

        const annotationRenderResult = await renderAnnotationLayersForPage(
            pageNumber,
            version,
            requestId,
            renderContext,
            shouldContinue,
        );
        if (!annotationRenderResult.shouldContinue) {
            cleanupStaleMountedPageRender(pageNumber, version, requestId, pageLease);
            return;
        }
        if (!shouldContinue()) {
            cleanupStaleMountedPageRender(pageNumber, version, requestId, pageLease);
            return;
        }

        renderContext.annotationLayerInstance =
            annotationRenderResult.annotationLayerInstance;
        scheduleOcrDebugForPage(pageNumber, renderContext);
        finalizePageRender(pageNumber, version, pageLease, target.container, shouldContinue);
    }

    async function yieldForSearchNavigation(
        pageNumber: number,
        version: number,
        requestId: number,
        documentToken: string,
    ) {
        await waitForRenderLifecycleDelay({
            cause: 'navigation-search-settle',
            delayMs: TEXT_LAYER_FIRST_NAVIGATION_YIELD_MS,
            key: `text-layer-first-navigation-yield:${pageNumber}:${version}:${requestId}:${documentToken}`,
            metadata: {
                documentToken,
                pageNumber,
                requestId,
                version,
            },
        });
    }

    async function mountTextLayerBeforeCanvas(
        pageNumber: number,
        version: number,
        scale: number,
        target: ISinglePageRenderTarget,
        pageLease: IPdfPageRenderLease,
        preparedCanvasRender: TRenderResult & { startRender: () => ICancelableRenderTask },
        requestId: number,
        documentToken: string,
        shouldContinue: () => boolean,
    ) {
        const { pdfPage } = pageLease;
        if (getRenderVersion() !== version || !shouldContinue()) {
            cleanupCanvasRenderResult(preparedCanvasRender);
            pageLease.release();
            return;
        }

        applyContainerDimensions(target.container, preparedCanvasRender, scale);
        const textLayerDiv =
            target.container.querySelector<HTMLDivElement>('.text-layer');
        const renderContext: IRenderPageContext<TRenderResult> = {
            container: target.container,
            pdfPage,
            renderResult: preparedCanvasRender,
            textLayerDiv,
            annotationLayerInstance: null,
        };
        let shouldContinueCanvasRender = true;
        const shouldContinueSearchCanvasRender = () => (
            shouldContinueCanvasRender && shouldContinue()
        );
        const canvasRenderPromise = renderPreparedCanvasForPage(
            pdfPage,
            pageNumber,
            version,
            requestId,
            preparedCanvasRender,
            shouldContinueSearchCanvasRender,
        );

        async function cancelPreparedCanvasRender() {
            shouldContinueCanvasRender = false;
            const renderResult = await canvasRenderPromise.catch(() => null);
            if (renderResult) {
                cleanupCanvasRenderResult(renderResult);
            }
        }

        try {
            const shouldContinueAfterTextLayer = await renderTextLayerForPage(
                pageNumber,
                version,
                requestId,
                renderContext,
                scale,
                shouldContinue,
            );
            if (!shouldContinueAfterTextLayer) {
                await cancelPreparedCanvasRender();
                pageLease.release();
                return;
            }
        } catch (error) {
            await cancelPreparedCanvasRender();
            pageLease.release();
            throw error;
        }

        await yieldForSearchNavigation(pageNumber, version, requestId, documentToken);
        if (getRenderVersion() !== version || getRenderDocumentToken() !== documentToken || !shouldContinue()) {
            await cancelPreparedCanvasRender();
            cleanupStaleMountedPageRender(pageNumber, version, requestId, pageLease);
            return;
        }

        const renderResult = await canvasRenderPromise;
        if (!renderResult) {
            pageLease.release();
            return;
        }
        if (getRenderVersion() !== version || getRenderDocumentToken() !== documentToken || !shouldContinue()) {
            cleanupCanvasRenderResult(renderResult);
            cleanupStaleMountedPageRender(pageNumber, version, requestId, pageLease);
            return;
        }

        mountRenderedCanvas(pageNumber, target.container, target.canvasHost, renderResult, scale);
        logPdfRenderTrace('renderer-canvas-mounted', {
            pageNumber,
            version,
            requestId,
            page: summarizePageDom(pageNumber),
            textLayerFirst: true,
        });
        onPageCanvasMounted?.(pageNumber);

        renderContext.renderResult = renderResult;
        const annotationRenderResult = await renderAnnotationLayersForPage(
            pageNumber,
            version,
            requestId,
            renderContext,
            shouldContinue,
        );
        if (!annotationRenderResult.shouldContinue) {
            cleanupStaleMountedPageRender(pageNumber, version, requestId, pageLease);
            return;
        }
        if (!shouldContinue()) {
            cleanupStaleMountedPageRender(pageNumber, version, requestId, pageLease);
            return;
        }

        renderContext.annotationLayerInstance =
            annotationRenderResult.annotationLayerInstance;
        scheduleOcrDebugForPage(pageNumber, renderContext);
        finalizePageRender(pageNumber, version, pageLease, target.container, shouldContinue);
    }

    function scheduleCancelledPageRenderRetry(
        pageNumber: number,
        version: number,
        requestId: number,
        documentToken: string,
    ) {
        if (
            getRenderVersion() !== version
            || requestId !== getVisibleRenderRequestId()
            || getRenderDocumentToken() !== documentToken
        ) {
            logPdfRenderTrace('renderer-cancelled-page-retry-skip-stale', {
                pageNumber,
                version,
                requestId,
                currentRenderVersion: getRenderVersion(),
                activeRequestId: getVisibleRenderRequestId(),
            });
            return;
        }

        void waitForRenderLifecycleDelay({
            cause: 'mounted-page-recovery',
            delayMs: 0,
            key: `cancelled-page-render-retry:${pageNumber}:${version}:${requestId}:${documentToken}`,
            metadata: {
                documentToken,
                pageNumber,
                requestId,
                version,
            },
        }).then((didFire) => {
            if (
                !didFire
                || getRenderVersion() !== version
                || requestId !== getVisibleRenderRequestId()
                || getRenderDocumentToken() !== documentToken
            ) {
                logPdfRenderTrace('renderer-cancelled-page-retry-skip-timeout-stale', {
                    pageNumber,
                    version,
                    requestId,
                    currentRenderVersion: getRenderVersion(),
                    activeRequestId: getVisibleRenderRequestId(),
                });
                return;
            }
            scheduleRenderForSinglePage(pageNumber, {
                preserveRenderedPages: true,
                bufferOverride: 0,
            });
        });
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
                currentRenderVersion: getRenderVersion(),
            },
        );
    }

    function handleSinglePageRenderError(
        pageNumber: number,
        error: unknown,
        version: number,
        requestId: number,
    ) {
        if (isRenderingCancelledError(error)) {
            scheduleCancelledPageRenderRetry(
                pageNumber,
                version,
                requestId,
                getRenderDocumentToken(),
            );
            return;
        }

        if (isPageRenderTimeoutError(error)) {
            logPageRenderTimeout(error, version);
            cleanupPageIfCurrentRender(pageNumber, version, requestId);
            return;
        }

        BrowserLogger.error(
            'pdf-renderer',
            formatRenderError(error, pageNumber),
        );
        cleanupPageIfCurrentRender(pageNumber, version, requestId);
    }

    function clearSinglePageRenderTracking(
        pageNumber: number,
        version: number,
        requestId?: number,
    ) {
        if (
            requestId !== undefined
            && renderingPageRequestIds.get(pageNumber) !== requestId
        ) {
            return;
        }
        const activeRenderTask = activeRenderTasks.get(pageNumber);
        if (
            activeRenderTask
            && activeRenderTask.version === version
            && (
                requestId === undefined
                || activeRenderTask.requestId === requestId
            )
        ) {
            activeRenderTasks.delete(pageNumber);
        }
        if (renderingPages.get(pageNumber) === version) {
            renderingPages.delete(pageNumber);
            renderingPageRequestIds.delete(pageNumber);
        }
    }

    function isCurrentMountedRenderTarget(
        pageNumber: number,
        version: number,
        target: ISinglePageRenderTarget,
        shouldContinue: () => boolean,
    ) {
        if (
            getRenderVersion() !== version
            || renderingPages.get(pageNumber) !== version
            || !shouldContinue()
        ) {
            return false;
        }
        if (target.container.isConnected === false || target.canvasHost.isConnected === false) {
            return false;
        }
        if (target.container.dataset.page !== String(pageNumber)) {
            return false;
        }
        if (
            typeof target.canvasHost.closest === 'function'
            && target.canvasHost.closest('.page_container') !== target.container
        ) {
            return false;
        }
        return true;
    }

    async function renderSingleVisiblePage(
        containerRoot: HTMLElement,
        pageNumber: number,
        version: number,
        scale: number,
        forceRerender: boolean,
        requestId: number,
        shouldContinue: () => boolean,
        requiredPages: Set<number>,
        visibleRange: IPageRange,
        renderOptions?: IRenderVisiblePagesOptions,
    ) {
        const documentToken = getRenderDocumentToken();
        const transactionRequest = renderOptions?.transactionRequest;
        const shouldContinuePage = () => (
            shouldContinue()
            && renderingPages.get(pageNumber) === version
            && renderingPageRequestIds.get(pageNumber) === requestId
            && getRenderDocumentToken() === documentToken
        );
        const target = getSinglePageRenderTarget(containerRoot, pageNumber);
        if (!target) {
            logPdfRenderTrace('renderer-single-page-missing-target', {
                pageNumber,
                version,
                requestId,
                required: requiredPages.has(pageNumber),
            });
            scheduleMissingRenderTargetRetry(
                pageNumber,
                version,
                requestId,
                requiredPages.has(pageNumber),
                visibleRange,
                documentToken,
                transactionRequest,
            );
            return;
        }
        clearMissingRenderTargetRetry(pageNumber);

        if (shouldSkipSingleVisiblePageRender(pageNumber, version, forceRerender, target, requestId)) {
            logPdfRenderTrace('renderer-single-page-skip', {
                pageNumber,
                version,
                requestId,
                forceRerender,
                page: summarizePageDom(pageNumber),
            });
            return;
        }

        logPdfRenderTrace('renderer-single-page-begin', {
            pageNumber,
            version,
            requestId,
            forceRerender,
            scale,
            page: summarizePageDom(pageNumber),
        });
        renderingPages.set(pageNumber, version);
        renderingPageRequestIds.set(pageNumber, requestId);
        clearSelectionBeforePageLayerTeardown(pageNumber);
        let pageLease: IPdfPageRenderLease | null = null;
        try {
            logPdfRenderTrace('renderer-page-load-begin', {
                pageNumber,
                version,
                requestId,
            });
            const pdfPage = await loadPageForRender(pageNumber, version, shouldContinuePage);
            if (!pdfPage) {
                logPdfRenderTrace('renderer-page-load-stale', {
                    pageNumber,
                    version,
                    requestId,
                    renderVersion: getRenderVersion(),
                });
                return;
            }
            pageLease = createPageRenderLease(pageNumber, pdfPage);
            logPdfRenderTrace('renderer-page-load-end', {
                pageNumber,
                version,
                requestId,
            });
            if (!shouldContinuePage()) {
                logPdfRenderTrace('renderer-page-load-skip-stale', {
                    pageNumber,
                    version,
                    requestId,
                    renderVersion: getRenderVersion(),
                });
                pageLease.release();
                return;
            }
            if (
                renderOptions?.prioritizeTextLayer === true
                && target.container.querySelector('.text-layer')
            ) {
                logPdfRenderTrace('renderer-text-layer-first-prepare-begin', {
                    pageNumber,
                    version,
                    requestId,
                    scale,
                });
                const preparedCanvasRender = await prepareCanvasRenderForPage(
                    pdfPage,
                    pageNumber,
                    version,
                    requestId,
                    scale,
                    shouldContinuePage,
                    renderOptions,
                );
                if (!preparedCanvasRender) {
                    logPdfRenderTrace('renderer-text-layer-first-prepare-stale', {
                        pageNumber,
                        version,
                        requestId,
                        renderVersion: getRenderVersion(),
                    });
                    pageLease.release();
                    return;
                }
                await mountTextLayerBeforeCanvas(
                    pageNumber,
                    version,
                    scale,
                    target,
                    pageLease,
                    preparedCanvasRender,
                    requestId,
                    documentToken,
                    shouldContinuePage,
                );
                return;
            }
            logPdfRenderTrace('renderer-canvas-prepare-begin', {
                pageNumber,
                version,
                requestId,
                scale,
            });
            const renderResult = await prepareCanvasForRender(
                pdfPage,
                pageNumber,
                version,
                requestId,
                scale,
                shouldContinuePage,
                renderOptions,
            );
            if (!renderResult) {
                logPdfRenderTrace('renderer-canvas-prepare-stale', {
                    pageNumber,
                    version,
                    requestId,
                    renderVersion: getRenderVersion(),
                });
                pageLease.release();
                return;
            }
            logPdfRenderTrace('renderer-canvas-prepare-end', {
                pageNumber,
                version,
                requestId,
            });
            await mountSingleVisiblePageLayers(
                pageNumber,
                version,
                scale,
                target,
                pageLease,
                renderResult,
                requestId,
                shouldContinuePage,
            );
        } catch (error) {
            logPdfRenderTrace('renderer-single-page-error', {
                pageNumber,
                version,
                requestId,
                errorName: error instanceof Error ? error.name : null,
                errorMessage: error instanceof Error ? error.message : String(error),
            });
            handleSinglePageRenderError(
                pageNumber,
                error,
                version,
                requestId,
            );
        } finally {
            pageLease?.release();
            clearSinglePageRenderTracking(pageNumber, version, requestId);
            logPdfRenderTrace('renderer-single-page-end', {
                pageNumber,
                version,
                requestId,
                page: summarizePageDom(pageNumber),
            });
        }
    }

    return {
        renderSingleVisiblePage,
        renderAnnotationEditorLayerForPage: async (pageNumber: number) => {
            if (!toValue(isActive)) {
                return false;
            }
            const containerRoot = getContainerRoot();
            const annotationUiManager = toValue(annotationUiManagerRef) ?? null;
            if (!containerRoot || !annotationUiManager) {
                return false;
            }
            const target = getSinglePageRenderTarget(containerRoot, pageNumber);
            if (!target) {
                return false;
            }
            const version = getRenderVersion();
            const scale = toValue(effectiveScale);
            const pdfPage = await loadPageForRender(
                pageNumber,
                version,
                () => getRenderVersion() === version,
            );
            if (!pdfPage) {
                return false;
            }
            const pageLease = createPageRenderLease(pageNumber, pdfPage);
            try {
                const shouldContinueEditorLayerRender = () => (
                    getRenderVersion() === version
                    && toValue(isActive)
                    && target.container.isConnected !== false
                    && target.canvasHost.isConnected !== false
                    && target.container.dataset.page === String(pageNumber)
                );
                if (!shouldContinueEditorLayerRender()) {
                    return false;
                }
                const textLayerDiv =
                    target.container.querySelector<HTMLDivElement>('.text-layer');
                const annotationEditorLayerDiv =
                    target.container.querySelector<HTMLElement>('.annotation-editor-layer');
                if (!annotationEditorLayerDiv) {
                    return false;
                }
                const viewport = getViewportForAnnotationEditorLayer(pdfPage, scale);
                const annotationEditorAbortController = new AbortController();
                const editorLayerResult = await withPageStageTimeout(
                    renderAnnotationEditorLayer(
                        target.container,
                        annotationEditorLayerDiv,
                        textLayerDiv,
                        viewport,
                        pageNumber,
                        null,
                        {
                            shouldContinue: shouldContinueEditorLayerRender,
                            signal: annotationEditorAbortController.signal,
                        },
                    ),
                    {
                        pageNumber,
                        stage: 'annotation-editor-layer',
                        timeoutMs: PDF_PAGE_RENDER_TIMEOUT_MS,
                    },
                    shouldContinueEditorLayerRender,
                    () => annotationEditorAbortController.abort(),
                    undefined,
                    options.renderSupervisor,
                );
                return editorLayerResult.ok
                    && editorLayerResult.rendered
                    && shouldContinueEditorLayerRender();
            } catch (error) {
                logNonCriticalStageError(
                    pageNumber,
                    'annotation editor layer',
                    error,
                );
                return false;
            } finally {
                pageLease.release();
            }
        },
    };
};
