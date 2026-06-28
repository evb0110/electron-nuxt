import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import type {
    MaybeRefOrGetter,
    Ref,
} from 'vue';
import { chunk } from 'es-toolkit/array';
import { range } from 'es-toolkit/math';
import type { IPageRange } from '@app/types/pdf';
import { getPageContainer } from '@app/modules/pdf-viewer/engine/pdf-page-buffer-manager/getPageContainer';
import { shouldRenderPageWithPreservedState } from '@app/modules/pdf-viewer/engine/pdf-page-render-preservation/shouldRenderPageWithPreservedState';
import { BrowserLogger } from '@app/utils/browserLogger';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';


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

interface IRenderPageDecisionContext {
    containerRoot: HTMLElement;
    visibleRange: IPageRange;
    renderOptions?: IRenderVisiblePagesOptions | undefined;
    isBufferPage: boolean;
}

interface IBufferPageCanvasClamp {
    maxCanvasPixels: number;
    requestedPixels: number;
}

interface IUsePdfRendererVisibleRenderControllerOptions {
    container: Ref<HTMLElement | null>;
    currentPage: Ref<number>;
    numPages: Ref<number>;
    isActive: MaybeRefOrGetter<boolean>;
    bufferPages: MaybeRefOrGetter<number>;
    renderConcurrency: MaybeRefOrGetter<number>;
    effectiveScale: MaybeRefOrGetter<number>;
    renderedPages: Set<number>;
    staleRenderedPages: Set<number>;
    renderingPages: Map<number, number>;
    renderingPageRequestIds: Map<number, number>;
    getRenderVersion: () => number;
    getVisibleRenderRequestId: () => number;
    nextVisibleRenderRequestId: () => number;
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
    ) => void;
    resolveBufferPageCanvasClamp?: ((
        pageNumber: number,
        context: IRenderPageDecisionContext,
    ) => IBufferPageCanvasClamp | null) | undefined;
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
        staleRenderedPages,
        renderingPages,
        renderingPageRequestIds,
        getRenderVersion,
        getVisibleRenderRequestId,
        nextVisibleRenderRequestId,
        ensurePageMetricsInRange,
        setupPagePlaceholders,
        cleanupPage,
        cancelObsoleteInFlightRenders,
        renderSingleVisiblePage,
        isVisibleRenderRangeCurrent,
        scheduleMissingRenderTargetRetry,
        resolveBufferPageCanvasClamp,
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

            return shouldRenderPageWithPreservedState({
                pageNumber,
                renderedPages,
                staleRenderedPages,
                forceRerender,
                hasMountedCanvas: candidatePage => hasMountedPageCanvas(containerRoot, candidatePage),
            });
        });
        return orderPagesForRender(pagesToRender, visibleRange);
    }

    function isRequestedVisibleRangeCurrent(visibleRange: IPageRange) {
        return isVisibleRenderRangeCurrent?.(visibleRange) !== false;
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

    async function renderSinglePageWithBufferClamp(
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
        const bufferClamp = isBufferPage
            ? resolveBufferPageCanvasClamp?.(pageNumber, {
                containerRoot,
                visibleRange,
                renderOptions,
                isBufferPage,
            }) ?? null
            : null;
        if (bufferClamp) {
            logPdfRenderTrace('renderer-visible-render-clamp-buffer-page', {
                pageNumber,
                visibleRange,
                requestedPixels: bufferClamp.requestedPixels,
                grantedMaxCanvasPixels: bufferClamp.maxCanvasPixels,
            });
        }
        const pageRenderOptions = bufferClamp
            ? {
                ...renderOptions,
                maxCanvasPixelsOverride: bufferClamp.maxCanvasPixels,
            }
            : renderOptions;
        const hadFreshMountedRender = !forceRerender
            && renderedPages.has(pageNumber)
            && !staleRenderedPages.has(pageNumber)
            && hasMountedPageCanvas(containerRoot, pageNumber);
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
        /**
         * A clamped canvas is below full quality on purpose; marking the page
         * stale makes the next render pass that promotes it into the visible
         * range rerender it at full resolution (atomic canvas swap, no flash).
         */
        if (
            (bufferClamp || renderOptions?.markRenderedPageStale === true)
            && !hadFreshMountedRender
            && renderedPages.has(pageNumber)
        ) {
            staleRenderedPages.add(pageNumber);
        }
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
                batch.map((pageNumber) => renderSinglePageWithBufferClamp(
                    containerRoot,
                    pageNumber,
                    version,
                    scale,
                    forceRerender,
                    requestId,
                    shouldContinue,
                    requiredPages,
                    visibleRange,
                    renderOptions,
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

    async function renderVisiblePages(
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

        if (!isRequestedVisibleRangeCurrent(visibleRange)) {
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

        const requestId = nextVisibleRenderRequestId();

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
            preserveRenderedPages: renderOptions?.preserveRenderedPages === true,
            bufferOverride: renderOptions?.bufferOverride ?? null,
            renderWindowOverride: renderOptions?.renderWindowOverride ?? null,
            renderedPages: Array.from(renderedPages),
            staleRenderedPages: Array.from(staleRenderedPages),
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
        if (!isRequestedVisibleRangeCurrent(visibleRange)) {
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
        if (requestId !== getVisibleRenderRequestId()) {
            logPdfRenderTrace('renderer-visible-render-abort-stale-request', {
                requestId,
                activeRequestId: getVisibleRenderRequestId(),
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

        if (!renderOptions?.preserveRenderedPages && requestId === getVisibleRenderRequestId()) {
            logPdfRenderTrace('renderer-visible-render-cleanup-outside', {
                requestId,
                version,
                pagesToKeep: Array.from(pagesToKeep),
                renderedPages: Array.from(renderedPages),
                renderingPages: Array.from(renderingPages.entries()),
            });
            cleanupRenderedPagesOutside(pagesToKeep);
        } else if (!renderOptions?.preserveRenderedPages) {
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
                staleRenderedPages: Array.from(staleRenderedPages),
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
                scheduleMissingRenderTargetRetry(pageNumber, version, requestId, true, visibleRange);
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
            () => getRenderVersion() === version && requestId === getVisibleRenderRequestId(),
            renderOptions,
        );
        logPdfRenderTrace('renderer-visible-render-end', {
            requestId,
            version,
            pagesToRenderNow: mountedPagesToRenderNow,
            renderedPages: Array.from(renderedPages),
            staleRenderedPages: Array.from(staleRenderedPages),
        });
    }

    return renderVisiblePages;
};
