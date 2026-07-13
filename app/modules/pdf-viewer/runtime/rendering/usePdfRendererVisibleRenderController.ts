import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import type { IPdfViewerTransactionRenderRequest } from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';
import type {
    MaybeRefOrGetter,
    Ref,
} from 'vue';
import { chunk } from 'es-toolkit/array';
import { range } from 'es-toolkit/math';
import type { IPageRange } from '@app/types/pdfUi';
import { getPageContainer } from '@app/modules/pdf-viewer/engine/pdf-page-buffer-manager/getPageContainer';
import { BrowserLogger } from '@app/utils/browserLogger';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import type {
    IPdfPageNumberStateMap,
    IPdfPageNumberStateSet,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfPageRenderState';


interface IVisibleRenderBounds {
    renderStart: number;
    renderEnd: number;
}

interface IRenderVisiblePagesRequest extends IVisibleRenderBounds {
    containerRoot: HTMLElement;
    version: number;
    buffer: number;
    forceRerender: boolean;
}

interface IUsePdfRendererVisibleRenderControllerOptions {
    container: Ref<HTMLElement | null>;
    currentPage: Ref<number>;
    numPages: Ref<number>;
    isActive: MaybeRefOrGetter<boolean>;
    bufferPages: MaybeRefOrGetter<number>;
    renderConcurrency: MaybeRefOrGetter<number>;
    effectiveScale: MaybeRefOrGetter<number>;
    renderedPages: IPdfPageNumberStateSet;
    renderingPages: IPdfPageNumberStateMap;
    renderingPageRequestIds: IPdfPageNumberStateMap;
    getRenderVersion: () => number;
    getRenderDocumentToken: () => string;
    getVisibleRenderRequestId: () => number;
    nextVisibleRenderRequestId: () => number;
    setVisibleRenderRequestId?: ((requestId: number) => number) | undefined;
    isRenderRequestCurrent?: ((request: IPdfViewerTransactionRenderRequest) => boolean) | undefined;
    ensurePageMetricsInRange: (startPage: number, endPage: number) => Promise<boolean>;
    setupPagePlaceholders: () => void;
    cleanupPage: (pageNumber: number) => void;
    cancelObsoleteInFlightRenders: (pagesToKeepRendering: Set<number>, requestId: number) => void;
    renderSingleVisiblePage: (
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
    ) => Promise<void>;
    isVisibleRenderRangeCurrent?: ((visibleRange: IPageRange) => boolean) | undefined;
    scheduleMissingRenderTargetRetry: (
        pageNumber: number,
        version: number,
        requestId: number,
        shouldRetry: boolean,
        visibleRange: IPageRange,
        documentToken: string,
        transactionRequest?: IPdfViewerTransactionRenderRequest | undefined,
    ) => void;
    throttleMs: number;
}

export const usePdfRendererVisibleRenderController = (options: IUsePdfRendererVisibleRenderControllerOptions) => {
    const {
        container,
        currentPage,
        numPages,
        isActive,
        bufferPages,
        renderConcurrency,
        effectiveScale,
        renderedPages,
        renderingPages,
        renderingPageRequestIds,
        getRenderVersion,
        getRenderDocumentToken,
        getVisibleRenderRequestId,
        nextVisibleRenderRequestId,
        setVisibleRenderRequestId,
        isRenderRequestCurrent,
        ensurePageMetricsInRange,
        setupPagePlaceholders,
        cleanupPage,
        cancelObsoleteInFlightRenders,
        renderSingleVisiblePage,
        isVisibleRenderRangeCurrent,
        scheduleMissingRenderTargetRetry,
        throttleMs,
    } = options;

    function getVisibleRenderBounds(
        visibleRange: IPageRange,
        buffer: number,
        renderOptions?: IRenderVisiblePagesOptions,
    ): IVisibleRenderBounds {
        const bufferedStart = visibleRange.start - buffer;
        const bufferedEnd = visibleRange.end + buffer;
        const override = renderOptions?.renderWindowOverride;
        const overrideStart = override
            && Number.isFinite(override.start)
            ? override.start
            : bufferedStart;
        const overrideEnd = override
            && Number.isFinite(override.end)
            ? override.end
            : bufferedEnd;
        return {
            renderStart: Math.max(1, Math.min(visibleRange.start, bufferedStart, overrideStart)),
            renderEnd: Math.min(numPages.value, Math.max(visibleRange.end, bufferedEnd, overrideEnd)),
        };
    }

    function getRenderVisiblePagesRequest(
        visibleRange: IPageRange,
        renderOptions?: IRenderVisiblePagesOptions,
    ): IRenderVisiblePagesRequest | null {
        const containerRoot = container.value;
        if (!containerRoot || numPages.value === 0) {
            return null;
        }

        const version = getRenderVersion();
        const buffer = renderOptions?.bufferOverride ?? toValue(bufferPages);
        const forceRerender = renderOptions?.forceRerender ?? false;
        return {
            containerRoot,
            version,
            buffer,
            forceRerender,
            ...getVisibleRenderBounds(visibleRange, buffer, renderOptions),
        };
    }

    async function hydratePageMetricsForVisibleRender(request: IRenderVisiblePagesRequest) {
        const didHydrateMetrics = await ensurePageMetricsInRange(
            request.renderStart,
            request.renderEnd,
        );
        if (getRenderVersion() !== request.version) {
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
        for (const pageNum of Array.from(renderingPages.keys())) {
            if (!pagesToKeep.has(pageNum)) {
                cleanupPage(pageNum);
            }
        }
    }

    function cleanupUnmountedTrackedPages(containerRoot: HTMLElement) {
        const trackedPages = new Set<number>(renderedPages);
        for (const pageNumber of renderingPages.keys()) {
            trackedPages.add(pageNumber);
        }
        for (const pageNumber of trackedPages) {
            if (!getPageContainer(containerRoot, pageNumber - 1)) {
                cleanupPage(pageNumber);
            }
        }
    }

    function hasMountedPageCanvas(containerRoot: HTMLElement, pageNumber: number) {
        return Boolean(
            getPageContainer(containerRoot, pageNumber - 1)
                ?.querySelector<HTMLCanvasElement>('.page_canvas canvas'),
        );
    }

    function isBufferPageForRange(pageNumber: number, visibleRange: IPageRange) {
        return pageNumber < visibleRange.start || pageNumber > visibleRange.end;
    }

    function getBufferPageDistance(pageNumber: number, visibleRange: IPageRange) {
        return pageNumber < visibleRange.start
            ? visibleRange.start - pageNumber
            : pageNumber - visibleRange.end;
    }

    /**
     * Required pages keep their order and render first. Buffer pages render by
     * distance from the visible range, preferring the higher page at equal
     * distance so the forward neighbor warms before the backward one.
     */
    function orderPagesForRender(pages: number[], visibleRange: IPageRange) {
        const requiredPages: number[] = [];
        const bufferPages: number[] = [];
        for (const pageNumber of pages) {
            if (isBufferPageForRange(pageNumber, visibleRange)) {
                bufferPages.push(pageNumber);
            } else {
                requiredPages.push(pageNumber);
            }
        }
        bufferPages.sort((left, right) => {
            const leftDistance = getBufferPageDistance(left, visibleRange);
            const rightDistance = getBufferPageDistance(right, visibleRange);
            if (leftDistance !== rightDistance) {
                return leftDistance - rightDistance;
            }
            return right - left;
        });
        return [
            ...requiredPages,
            ...bufferPages,
        ];
    }

    function getPagesToRenderNow(
        containerRoot: HTMLElement,
        renderStart: number,
        renderEnd: number,
        forceRerender: boolean,
        version: number,
        requestId: number,
        visibleRange: IPageRange,
    ) {
        const pagesToRender = range(renderStart, renderEnd + 1).filter((pageNumber) => {
            const renderingVersion = renderingPages.get(pageNumber);
            const renderingRequestId = renderingPageRequestIds.get(pageNumber);
            if (
                renderingVersion === version
                && renderingRequestId !== undefined
                && renderingRequestId !== requestId
            ) {
                return true;
            }

            return forceRerender
                || !renderedPages.has(pageNumber)
                || !hasMountedPageCanvas(containerRoot, pageNumber);
        });
        return orderPagesForRender(pagesToRender, visibleRange);
    }

    function isRequestedVisibleRangeCurrent(visibleRange: IPageRange) {
        return isVisibleRenderRangeCurrent?.(visibleRange) !== false;
    }

    function isTransactionRenderRequestCurrent(
        transactionRequest: IPdfViewerTransactionRenderRequest | undefined,
    ) {
        if (!transactionRequest) {
            return true;
        }
        return isRenderRequestCurrent?.(transactionRequest) !== false;
    }

    function isRequestedRenderCurrent(
        visibleRange: IPageRange,
        transactionRequest: IPdfViewerTransactionRenderRequest | undefined,
    ) {
        return isRequestedVisibleRangeCurrent(visibleRange)
            && isTransactionRenderRequestCurrent(transactionRequest);
    }

    function createRenderOptionsForTransactionRequest(
        transactionRequest: IPdfViewerTransactionRenderRequest,
    ): IRenderVisiblePagesOptions {
        return {
            preserveRenderedPages: transactionRequest.preserveRenderedPages,
            bufferOverride: transactionRequest.buffer,
            forceRerender: transactionRequest.forceRerender,
            preserveInFlightRequiredPages: transactionRequest.preserveInFlightRequiredPages,
            transactionRequest,
            ...(transactionRequest.renderWindowOverride
                ? { renderWindowOverride: transactionRequest.renderWindowOverride }
                : {}),
            ...(transactionRequest.prioritizeTextLayer !== undefined
                ? { prioritizeTextLayer: transactionRequest.prioritizeTextLayer }
                : {}),
        };
    }

    async function waitForMountedPageContainers(
        containerRoot: HTMLElement,
        requiredPagesToRender: number[],
        visibleRange: IPageRange,
        version: number,
    ) {
        let pagesMissingMountedContainer: number[] = [];

        for (let attempt = 0; attempt < 4; attempt += 1) {
            if (!isRequestedVisibleRangeCurrent(visibleRange)) {
                logPdfRenderTrace('renderer-visible-render-abort-stale-mounted-page-wait', {
                    visibleRange,
                    renderVersion: version,
                    currentRenderVersion: getRenderVersion(),
                    currentPage: currentPage.value,
                });
                return false;
            }

            pagesMissingMountedContainer = requiredPagesToRender.filter(
                (pageNumber) => !getPageContainer(containerRoot, pageNumber - 1),
            );
            if (pagesMissingMountedContainer.length === 0 || getRenderVersion() !== version) {
                return true;
            }

            await nextTick();
        }

        if (!isRequestedVisibleRangeCurrent(visibleRange)) {
            logPdfRenderTrace('renderer-visible-render-skip-stale-mounted-page-warning', {
                pagesMissingMountedContainer,
                visibleRange,
                renderVersion: version,
                currentRenderVersion: getRenderVersion(),
                currentPage: currentPage.value,
            });
            return false;
        }

        BrowserLogger.warnThrottled(
            'pdf-renderer',
            'render-visible-wait-for-mounted-pages',
            throttleMs,
            'Waiting for virtualized page containers before rendering',
            {
                pagesMissingMountedContainer,
                visibleRange,
                renderVersion: version,
                currentRenderVersion: getRenderVersion(),
                currentPage: currentPage.value,
            },
        );
        return true;
    }

    async function renderSinglePageWithPriority(
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
        const isBufferPage = isBufferPageForRange(pageNumber, visibleRange);
        const bufferDistance = isBufferPage
            ? getBufferPageDistance(pageNumber, visibleRange)
            : 0;
        const continuationPriority = renderOptions?.transactionRequest?.priority === 'authoritative'
            && requiredPages.has(pageNumber)
            ? 'navigation-target'
            : isBufferPage
                ? bufferDistance <= 1 ? 'nearby' : 'prefetch'
                : renderOptions?.prioritizeTextLayer === true ? 'visible-text' : 'visible';
        const pageRenderOptions = {
            ...renderOptions,
            continuationPriority,
        } satisfies IRenderVisiblePagesOptions;
        await renderSingleVisiblePage(
            containerRoot,
            pageNumber,
            version,
            scale,
            forceRerender,
            requestId,
            shouldContinue,
            requiredPages,
            visibleRange,
            pageRenderOptions,
        );
    }

    async function renderVisiblePageBatches(
        containerRoot: HTMLElement,
        pagesToRenderNow: number[],
        version: number,
        scale: number,
        forceRerender: boolean,
        requestId: number,
        requiredPages: Set<number>,
        visibleRange: IPageRange,
        shouldContinue: () => boolean,
        renderOptions?: IRenderVisiblePagesOptions,
    ) {
        const transactionRequest = renderOptions?.transactionRequest;
        const concurrentRenders = Math.max(1, Math.trunc(toValue(renderConcurrency)));
        for (const batch of chunk(pagesToRenderNow, concurrentRenders)) {
            if (!shouldContinue()) {
                logPdfRenderTrace('renderer-visible-render-abort-stale-batch', {
                    version,
                    currentRenderVersion: getRenderVersion(),
                    pagesToRenderNow,
                });
                return;
            }
            await Promise.all(
                batch.map((pageNumber) => renderSinglePageWithPriority(
                    containerRoot,
                    pageNumber,
                    version,
                    scale,
                    forceRerender,
                    requestId,
                    shouldContinue,
                    requiredPages,
                    visibleRange,
                    transactionRequest
                        ? {
                            ...renderOptions,
                            transactionRequest,
                        }
                        : renderOptions,
                )),
            );
            if (!shouldContinue()) {
                logPdfRenderTrace('renderer-visible-render-abort-after-batch', {
                    version,
                    currentRenderVersion: getRenderVersion(),
                    pagesToRenderNow,
                });
                return;
            }
        }
    }

    async function renderVisiblePagesForRequest(
        visibleRange: IPageRange,
        renderOptions?: IRenderVisiblePagesOptions,
    ) {
        if (!toValue(isActive)) {
            return;
        }
        const request = getRenderVisiblePagesRequest(visibleRange, renderOptions);
        if (!request) {
            logPdfRenderTrace('renderer-visible-render-skipped-no-request', {
                visibleRange,
                renderOptions,
                renderVersion: getRenderVersion(),
            });
            return;
        }

        if (!isRequestedRenderCurrent(visibleRange, renderOptions?.transactionRequest)) {
            logPdfRenderTrace('renderer-visible-render-skipped-stale-range', {
                visibleRange,
                renderOptions,
                renderVersion: getRenderVersion(),
                currentPage: currentPage.value,
            });
            return;
        }

        const activeRequestId = getVisibleRenderRequestId();
        const inFlightRequiredPages = renderOptions?.preserveInFlightRequiredPages === true && !request.forceRerender
            ? range(visibleRange.start, visibleRange.end + 1).filter(
                (pageNumber) => (
                    renderingPages.get(pageNumber) === request.version
                    && renderingPageRequestIds.get(pageNumber) === activeRequestId
                ),
            )
            : [];
        if (inFlightRequiredPages.length > 0) {
            logPdfRenderTrace('renderer-visible-render-preserve-in-flight-required-pages', {
                activeRequestId,
                version: request.version,
                visibleRange,
                renderStart: request.renderStart,
                renderEnd: request.renderEnd,
                inFlightRequiredPages,
                renderedPages: Array.from(renderedPages),
                renderingPages: Array.from(renderingPages.entries()),
                renderingPageRequestIds: Array.from(renderingPageRequestIds.entries()),
            });
            return;
        }

        const requestId = renderOptions?.transactionRequest
            ? setVisibleRenderRequestId?.(renderOptions.transactionRequest.renderRequestId)
                ?? renderOptions.transactionRequest.renderRequestId
            : nextVisibleRenderRequestId();
        const documentToken = getRenderDocumentToken();
        const transactionRequest = renderOptions?.transactionRequest;
        const activeRenderOptions = renderOptions;

        const {
            renderStart,
            renderEnd,
            forceRerender,
            containerRoot,
            version,
        } = request;
        logPdfRenderTrace('renderer-visible-render-begin', {
            requestId,
            version,
            currentRenderVersion: getRenderVersion(),
            visibleRange,
            renderStart,
            renderEnd,
            forceRerender,
            transactionId: transactionRequest?.transactionId ?? null,
            preserveRenderedPages: activeRenderOptions?.preserveRenderedPages === true,
            bufferOverride: activeRenderOptions?.bufferOverride ?? null,
            renderWindowOverride: activeRenderOptions?.renderWindowOverride ?? null,
            renderedPages: Array.from(renderedPages),
        });
        if (!await hydratePageMetricsForVisibleRender(request)) {
            logPdfRenderTrace('renderer-visible-render-abort-hydrate', {
                requestId,
                version,
                currentRenderVersion: getRenderVersion(),
                visibleRange,
                renderStart,
                renderEnd,
            });
            return;
        }
        if (!isRequestedRenderCurrent(visibleRange, transactionRequest)) {
            logPdfRenderTrace('renderer-visible-render-abort-stale-range', {
                requestId,
                activeRequestId: getVisibleRenderRequestId(),
                version,
                currentRenderVersion: getRenderVersion(),
                visibleRange,
                renderStart,
                renderEnd,
                currentPage: currentPage.value,
            });
            return;
        }
        if (
            requestId !== getVisibleRenderRequestId()
            || !isTransactionRenderRequestCurrent(transactionRequest)
        ) {
            logPdfRenderTrace('renderer-visible-render-abort-stale-request', {
                requestId,
                activeRequestId: getVisibleRenderRequestId(),
                transactionId: transactionRequest?.transactionId ?? null,
                version,
                currentRenderVersion: getRenderVersion(),
                visibleRange,
                renderStart,
                renderEnd,
            });
            return;
        }

        const pagesToKeep = new Set(range(renderStart, renderEnd + 1));
        cancelObsoleteInFlightRenders(pagesToKeep, requestId);
        cleanupUnmountedTrackedPages(containerRoot);

        if (!activeRenderOptions?.preserveRenderedPages && requestId === getVisibleRenderRequestId()) {
            logPdfRenderTrace('renderer-visible-render-cleanup-outside', {
                requestId,
                version,
                pagesToKeep: Array.from(pagesToKeep),
                renderedPages: Array.from(renderedPages),
                renderingPages: Array.from(renderingPages.entries()),
            });
            cleanupRenderedPagesOutside(pagesToKeep);
        } else if (!activeRenderOptions?.preserveRenderedPages) {
            logPdfRenderTrace('renderer-visible-render-skip-stale-cleanup', {
                requestId,
                activeRequestId: getVisibleRenderRequestId(),
                version,
                pagesToKeep: Array.from(pagesToKeep),
            });
        }

        const pagesToRenderNow = getPagesToRenderNow(
            containerRoot,
            renderStart,
            renderEnd,
            forceRerender,
            version,
            requestId,
            visibleRange,
        );

        if (pagesToRenderNow.length === 0) {
            logPdfRenderTrace('renderer-visible-render-no-pages', {
                requestId,
                version,
                renderStart,
                renderEnd,
                forceRerender,
                renderedPages: Array.from(renderedPages),
            });
            return;
        }
        logPdfRenderTrace('renderer-visible-render-pages', {
            requestId,
            version,
            pagesToRenderNow,
            forceRerender,
        });

        const requiredPagesToRender = pagesToRenderNow.filter(
            (pageNumber) => pageNumber >= visibleRange.start && pageNumber <= visibleRange.end,
        );
        const requiredPages = new Set(requiredPagesToRender);
        const mountedPageWaitStillCurrent = await waitForMountedPageContainers(
            containerRoot,
            requiredPagesToRender,
            visibleRange,
            version,
        );
        if (
            !mountedPageWaitStillCurrent
            || getRenderVersion() !== version
            || requestId !== getVisibleRenderRequestId()
            || getRenderDocumentToken() !== documentToken
            || !isTransactionRenderRequestCurrent(transactionRequest)
        ) {
            logPdfRenderTrace('renderer-visible-render-abort-before-batches', {
                requestId,
                activeRequestId: getVisibleRenderRequestId(),
                version,
                currentRenderVersion: getRenderVersion(),
                pagesToRenderNow,
            });
            return;
        }

        const mountedPagesToRenderNow = pagesToRenderNow.filter(
            (pageNumber) => getPageContainer(containerRoot, pageNumber - 1),
        );
        const missingRequiredPages = requiredPagesToRender.filter(
            (pageNumber) => !mountedPagesToRenderNow.includes(pageNumber),
        );
        if (missingRequiredPages.length > 0) {
            logPdfRenderTrace('renderer-visible-render-missing-required-targets', {
                requestId,
                version,
                visibleRange,
                missingRequiredPages,
            });
            for (const pageNumber of missingRequiredPages) {
                scheduleMissingRenderTargetRetry(
                    pageNumber,
                    version,
                    requestId,
                    true,
                    visibleRange,
                    documentToken,
                    transactionRequest,
                );
            }
        }
        if (mountedPagesToRenderNow.length === 0) {
            logPdfRenderTrace('renderer-visible-render-no-mounted-pages', {
                requestId,
                version,
                pagesToRenderNow,
                visibleRange,
            });
            return;
        }

        const scale = toValue(effectiveScale);
        await renderVisiblePageBatches(
            containerRoot,
            mountedPagesToRenderNow,
            version,
            scale,
            forceRerender,
            requestId,
            requiredPages,
            visibleRange,
            () => (
                getRenderVersion() === version
                && requestId === getVisibleRenderRequestId()
                && getRenderDocumentToken() === documentToken
                && isTransactionRenderRequestCurrent(transactionRequest)
            ),
            activeRenderOptions,
        );
        logPdfRenderTrace('renderer-visible-render-end', {
            requestId,
            version,
            pagesToRenderNow: mountedPagesToRenderNow,
            renderedPages: Array.from(renderedPages),
        });
    }

    async function renderVisiblePages(
        visibleRange: IPageRange,
        renderOptions?: IRenderVisiblePagesOptions,
    ) {
        await renderVisiblePagesForRequest(visibleRange, renderOptions);
    }

    async function renderTransactionPages(request: IPdfViewerTransactionRenderRequest) {
        await renderVisiblePagesForRequest(
            request.range,
            createRenderOptionsForTransactionRequest(request),
        );
    }

    return Object.assign(renderVisiblePages, { renderTransactionPages });
};
