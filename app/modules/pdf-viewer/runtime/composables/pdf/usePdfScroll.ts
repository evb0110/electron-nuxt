import type { IAnnotationMarkerRect } from '@app/types/annotations';
import { clamp } from 'es-toolkit/math';
import { logPdfNav } from '@app/utils/logPdfNav';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/scrollToPageOptions';
import { getPageContainerByNumber } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getPageContainerByNumber';
import { getViewportVisibilityFromDom } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getViewportVisibilityFromDom';
import type { IViewportVisibilityResult } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/pdfScrollVisibilityTypes';
import type { IPdfPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';
import { getPageHeight } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageHeight';
import { getPageTop } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageTop';
import { resolvePageBoundedHorizontalScroll } from '@app/modules/pdf-viewer/engine/pdf-horizontal-scroll-clamp/resolvePageBoundedHorizontalScroll';
import type { IPdfViewportWritePort } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportWritePort';

export type { IScrollToPageOptions } from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/scrollToPageOptions';

type TPageLayoutMetrics = IPdfPageLayoutMetrics;

interface IUsePdfScrollOptions {
    getPinnedMostVisiblePage?: () => number | null;
    viewportWritePort: IPdfViewportWritePort;
}

interface IViewportVisibilityCacheEntry {
    container: HTMLElement;
    totalPages: number;
    scrollTop: number;
    scrollLeft: number;
    clientWidth: number;
    clientHeight: number;
    layoutMetrics: TPageLayoutMetrics | null;
    result: IViewportVisibilityResult;
}

function getLayoutPageTop(
    metrics: TPageLayoutMetrics,
    index: number,
) {
    return Math.max(0, (metrics.pageTops[index] ?? 0) - metrics.paddingTop);
}

function getLayoutRowTop(
    metrics: TPageLayoutMetrics,
    rowIndex: number,
) {
    const rowStartPage = metrics.rowStartPages[rowIndex] ?? 1;
    return getLayoutPageTop(metrics, Math.max(0, rowStartPage - 1));
}

function getLayoutRowBottom(
    metrics: TPageLayoutMetrics,
    rowIndex: number,
) {
    const rowTop = getLayoutRowTop(metrics, rowIndex);
    const rowHeight = metrics.rowHeights[rowIndex] ?? 0;
    return rowTop + rowHeight;
}

function getLayoutRowWidth(
    metrics: TPageLayoutMetrics,
    rowIndex: number,
) {
    const rowStartPage = metrics.rowStartPages[rowIndex] ?? 1;
    const rowEndPage = metrics.rowEndPages[rowIndex] ?? rowStartPage;
    let width = 0;

    for (let pageNumber = rowStartPage; pageNumber <= rowEndPage; pageNumber += 1) {
        width += metrics.pageWidths[pageNumber - 1] ?? 0;
    }

    return width;
}

function getLayoutPageLeft(
    metrics: TPageLayoutMetrics,
    index: number,
    containerWidth: number,
) {
    const rowIndex = metrics.pageRowIndices[index] ?? 0;
    const rowStartPage = metrics.rowStartPages[rowIndex] ?? index + 1;
    const rowWidth = getLayoutRowWidth(metrics, rowIndex);
    let pageLeft = Math.max(0, (containerWidth - rowWidth) / 2);

    for (let pageNumber = rowStartPage; pageNumber < index + 1; pageNumber += 1) {
        pageLeft += metrics.pageWidths[pageNumber - 1] ?? 0;
    }

    return pageLeft;
}

function getMarkerCenter(markerRect: IAnnotationMarkerRect | null | undefined) {
    if (!markerRect) {
        return null;
    }

    return {
        x: clamp(markerRect.left + markerRect.width / 2, 0, 1),
        y: clamp(markerRect.top + markerRect.height / 2, 0, 1),
    };
}

function resolveMarkerScrollTop(options: {
    pageTop: number;
    pageHeight: number;
    containerHeight: number;
    margin: number;
    pageYRatio?: number | null | undefined;
    markerRect?: IAnnotationMarkerRect | null | undefined;
}) {
    if (typeof options.pageYRatio === 'number' && Number.isFinite(options.pageYRatio)) {
        return Math.max(
            0,
            options.pageTop + clamp(options.pageYRatio, 0, 1) * options.pageHeight - options.margin,
        );
    }

    const markerCenter = getMarkerCenter(options.markerRect);
    if (!markerCenter) {
        return Math.max(0, options.pageTop - options.margin);
    }

    return clampMarkerScrollTopToPageBounds({
        desiredTop: Math.max(
            0,
            options.pageTop + markerCenter.y * options.pageHeight - options.containerHeight / 2,
        ),
        pageTop: options.pageTop,
        pageHeight: options.pageHeight,
        containerHeight: options.containerHeight,
        margin: options.margin,
    });
}

function clampMarkerScrollTopToPageBounds(options: {
    desiredTop: number;
    pageTop: number;
    pageHeight: number;
    containerHeight: number;
    margin: number;
}) {
    const minTop = Math.max(0, options.pageTop - options.margin);
    const maxTop = Math.max(
        minTop,
        options.pageTop + options.pageHeight + options.margin - options.containerHeight,
    );

    return clamp(options.desiredTop, minTop, maxTop);
}

function resolveMarkerScrollLeft(options: {
    pageLeft: number;
    pageWidth: number;
    containerWidth: number;
    margin: number;
    markerRect?: IAnnotationMarkerRect | null | undefined;
}) {
    const markerCenter = getMarkerCenter(options.markerRect);
    if (!markerCenter) {
        return null;
    }

    const markerTargetLeft = Math.max(
        0,
        options.pageLeft + markerCenter.x * options.pageWidth - options.containerWidth / 2,
    );
    const scrollClamp = resolvePageBoundedHorizontalScroll({
        scrollLeft: markerTargetLeft,
        viewportWidth: options.containerWidth,
        pageLeft: options.pageLeft,
        pageWidth: options.pageWidth,
        margin: options.margin,
    });

    return scrollClamp?.scrollLeft ?? markerTargetLeft;
}

function findFirstVisibleLayoutRowIndex(
    metrics: TPageLayoutMetrics,
    viewportTop: number,
) {
    let low = 0;
    let high = metrics.rowHeights.length - 1;
    let result = -1;

    while (low <= high) {
        const mid = low + Math.floor((high - low) / 2);
        if (getLayoutRowBottom(metrics, mid) > viewportTop) {
            result = mid;
            high = mid - 1;
        } else {
            low = mid + 1;
        }
    }

    return result;
}

function findLastVisibleLayoutRowIndex(
    metrics: TPageLayoutMetrics,
    viewportBottom: number,
) {
    let low = 0;
    let high = metrics.rowHeights.length - 1;
    let result = -1;

    while (low <= high) {
        const mid = low + Math.floor((high - low) / 2);
        if (getLayoutRowTop(metrics, mid) < viewportBottom) {
            result = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    return result;
}

export const usePdfScroll = (options: IUsePdfScrollOptions) => {
    const currentPageProjection = shallowRef<{projection: Readonly<Ref<number>>} | null>(null);
    const currentPage = computed(() => currentPageProjection.value?.projection.value ?? 1);
    const visibleRange = ref({
        start: 1,
        end: 1,
    });
    const pageLayoutMetrics = ref<TPageLayoutMetrics | null>(null);
    let viewportVisibilityCache: IViewportVisibilityCacheEntry | null = null;
    const viewportWritePort = options.viewportWritePort;
    let viewportIntentSequence = 0;

    function applyViewportWrite(
        container: HTMLElement,
        write: {
            left?: number;
            top?: number
        },
        reason: string,
    ) {
        viewportIntentSequence += 1;
        const intentId = `pdf-scroll-${viewportIntentSequence}`;
        viewportWritePort.apply(container, {
            intent: viewportWritePort.beginIntent(intentId),
            reason,
            ...write,
        });
    }

    function applyDomScrollToPage(
        container: HTMLElement,
        targetPage: number,
        margin: number,
        options: IScrollToPageOptions | undefined,
        reason: 'scroll',
    ) {
        const targetEl = getPageContainerByNumber(container, targetPage);
        if (!targetEl) {
            return null;
        }

        const pageHeight = targetEl.offsetHeight || targetEl.clientHeight;
        const pageWidth = targetEl.offsetWidth || targetEl.clientWidth;
        const nextTop = resolveMarkerScrollTop({
            pageTop: targetEl.offsetTop,
            pageHeight,
            containerHeight: container.clientHeight,
            margin,
            pageYRatio: options?.pageYRatio,
            markerRect: options?.markerRect,
        });
        const nextLeft = resolveMarkerScrollLeft({
            pageLeft: targetEl.offsetLeft,
            pageWidth,
            containerWidth: container.clientWidth,
            margin,
            markerRect: options?.markerRect,
        });
        logPdfNav(
            `[PDF-NAV] usePdfScroll.scrollToPage source=dom targetPage=${targetPage}`
            + ` reason=${reason}`
            + ` offsetTop=${targetEl.offsetTop.toFixed(1)} margin=${margin.toFixed(1)}`
            + ` marker=${options?.markerRect ? 'true' : 'false'}`
            + ` pageY=${typeof options?.pageYRatio === 'number' ? options.pageYRatio.toFixed(3) : 'none'}`
            + ` nextTop=${nextTop.toFixed(1)} scrollTop(before)=${container.scrollTop.toFixed(1)}`,
        );
        applyViewportWrite(container, {
            ...(nextLeft !== null ? {left: nextLeft} : {}),
            top: nextTop,
        }, `navigate:${reason}`);
        return targetEl;
    }

    function getPreviousPageFallback(totalPages: number) {
        return totalPages > 0
            ? clamp(currentPage.value, 1, totalPages)
            : currentPage.value;
    }

    function setPageLayoutMetrics(metrics: TPageLayoutMetrics | null) {
        pageLayoutMetrics.value = metrics;
        viewportVisibilityCache = null;
    }

    function isViewportVisibilityCacheValid(
        cached: IViewportVisibilityCacheEntry | null,
        container: HTMLElement,
        totalPages: number,
        metrics: TPageLayoutMetrics | null,
    ): cached is IViewportVisibilityCacheEntry {
        return !!cached
            && cached.container === container
            && cached.totalPages === totalPages
            && cached.scrollTop === container.scrollTop
            && cached.scrollLeft === container.scrollLeft
            && cached.clientWidth === container.clientWidth
            && cached.clientHeight === container.clientHeight
            && cached.layoutMetrics === metrics;
    }

    function cacheViewportVisibility(
        container: HTMLElement,
        totalPages: number,
        metrics: TPageLayoutMetrics | null,
        result: IViewportVisibilityResult,
    ) {
        viewportVisibilityCache = {
            container,
            totalPages,
            scrollTop: container.scrollTop,
            scrollLeft: container.scrollLeft,
            clientWidth: container.clientWidth,
            clientHeight: container.clientHeight,
            layoutMetrics: metrics,
            result,
        };
    }

    function resolveViewportVisibility(
        container: HTMLElement,
        totalPages: number,
    ) {
        const domVisibility = getViewportVisibilityFromDom(container, totalPages);
        return domVisibility.range || domVisibility.mostVisiblePage !== null
            ? domVisibility
            : getViewportVisibilityFromLayout(container, totalPages) ?? domVisibility;
    }

    function getViewportVisibilityFromLayout(
        container: HTMLElement,
        totalPages: number,
    ): IViewportVisibilityResult | null {
        const metrics = pageLayoutMetrics.value;
        if (!metrics || metrics.totalPages !== totalPages) {
            return null;
        }

        const viewportTop = Math.max(0, container.scrollTop - metrics.paddingTop);
        const viewportBottom = viewportTop + container.clientHeight;
        const layoutPageCount = Math.min(
            totalPages,
            metrics.pageTops.length,
            metrics.pageHeights.length,
        );
        if (layoutPageCount <= 0) {
            return null;
        }

        const firstVisibleRowIndex = findFirstVisibleLayoutRowIndex(
            metrics,
            viewportTop,
        );
        if (firstVisibleRowIndex === -1) {
            return null;
        }

        const lastVisibleRowIndex = findLastVisibleLayoutRowIndex(
            metrics,
            viewportBottom,
        );
        if (
            lastVisibleRowIndex === -1
            || lastVisibleRowIndex < firstVisibleRowIndex
        ) {
            return null;
        }

        const viewportLeft = Math.max(0, container.scrollLeft);
        const viewportRight = viewportLeft + container.clientWidth;
        let firstVisiblePage: number | null = null;
        let lastVisiblePage: number | null = null;
        let mostVisiblePage: number | null = null;
        let maxVisibleArea = 0;

        const firstVisibleIndex = clamp(
            (metrics.rowStartPages[firstVisibleRowIndex] ?? 1) - 1,
            0,
            layoutPageCount - 1,
        );
        const lastVisibleIndex = clamp(
            (metrics.rowEndPages[lastVisibleRowIndex] ?? layoutPageCount) - 1,
            0,
            layoutPageCount - 1,
        );

        for (let index = firstVisibleIndex; index <= lastVisibleIndex; index += 1) {
            const pageTop = getLayoutPageTop(metrics, index);
            const pageHeight = metrics.pageHeights[index] ?? 0;
            const pageBottom = pageTop + pageHeight;
            const pageLeft = getLayoutPageLeft(metrics, index, container.clientWidth);
            const pageWidth = metrics.pageWidths[index] ?? 0;
            const pageRight = pageLeft + pageWidth;
            const visibleTop = Math.max(pageTop, viewportTop);
            const visibleBottom = Math.min(pageBottom, viewportBottom);
            const visibleLeft = Math.max(pageLeft, viewportLeft);
            const visibleRight = Math.min(pageRight, viewportRight);
            const visibleArea = Math.max(0, visibleBottom - visibleTop)
                * Math.max(0, visibleRight - visibleLeft);

            if (visibleArea > 0) {
                firstVisiblePage ??= index + 1;
                lastVisiblePage = index + 1;

                if (visibleArea > maxVisibleArea) {
                    maxVisibleArea = visibleArea;
                    mostVisiblePage = index + 1;
                }
            }
        }

        if (firstVisiblePage === null || lastVisiblePage === null) {
            return null;
        }

        return {
            range: {
                start: clamp(firstVisiblePage, 1, totalPages),
                end: clamp(lastVisiblePage, 1, totalPages),
            },
            mostVisiblePage:
                maxVisibleArea > 0 && mostVisiblePage !== null
                    ? clamp(mostVisiblePage, 1, totalPages)
                    : null,
        };
    }

    function getVisiblePageRange(
        container: HTMLElement | null,
        totalPages: number,
    ): {
        start: number;
        end: number
    } {
        if (totalPages === 0) {
            return {
                start: 1,
                end: 1,
            };
        }

        if (!container) {
            return {
                start: clamp(visibleRange.value.start, 1, totalPages),
                end: clamp(visibleRange.value.end, 1, totalPages),
            };
        }

        const visibility = getViewportVisibility(container, totalPages);
        if (visibility.range) {
            return visibility.range;
        }

        return {
            start: clamp(visibleRange.value.start, 1, totalPages),
            end: clamp(visibleRange.value.end, 1, totalPages),
        };
    }

    function resolveMostVisiblePage(
        container: HTMLElement | null,
        totalPages: number,
    ) {
        if (!container || totalPages === 0) {
            return {
                page: getPreviousPageFallback(totalPages),
                authoritative: false,
            };
        }

        const pinnedPage = options.getPinnedMostVisiblePage?.();
        if (pinnedPage !== null && pinnedPage !== undefined) {
            return {
                page: clamp(pinnedPage, 1, totalPages),
                authoritative: true,
            };
        }

        const visibility = getViewportVisibility(container, totalPages);
        if (visibility.mostVisiblePage !== null) {
            return {
                page: visibility.mostVisiblePage,
                authoritative: true,
            };
        }

        return {
            page: getPreviousPageFallback(totalPages),
            authoritative: false,
        };
    }

    function getMostVisiblePage(
        container: HTMLElement | null,
        totalPages: number,
    ) {
        return resolveMostVisiblePage(container, totalPages).page;
    }

    function getViewportVisibility(
        container: HTMLElement | null,
        totalPages: number,
    ): IViewportVisibilityResult {
        if (!container || totalPages <= 0) {
            return {
                range: null,
                mostVisiblePage: null,
            };
        }

        const metrics = pageLayoutMetrics.value;
        if (isViewportVisibilityCacheValid(viewportVisibilityCache, container, totalPages, metrics)) {
            return viewportVisibilityCache.result;
        }

        const result = resolveViewportVisibility(container, totalPages);
        cacheViewportVisibility(container, totalPages, metrics, result);
        return result;
    }

    function scrollToPage(
        container: HTMLElement | null,
        pageNumber: number,
        totalPages: number,
        margin: number,
        options?: IScrollToPageOptions,
    ) {
        if (!container || totalPages === 0) {
            return;
        }
        const targetPage = clamp(pageNumber, 1, totalPages);
        const targetEl = getPageContainerByNumber(container, targetPage);

        if (targetEl) {
            applyDomScrollToPage(container, targetPage, margin, options, 'scroll');
            return;
        }

        const metrics = pageLayoutMetrics.value;
        if (metrics && metrics.totalPages === totalPages) {
            if (options?.preferExactDom) {
                logPdfNav(
                    `[PDF-NAV] usePdfScroll.scrollToPage source=anchor-only targetPage=${targetPage}`
                    + ` reason=dom-missing scrollTop(before)=${container.scrollTop.toFixed(1)}`,
                );
                return;
            }
            const top = getPageTop(metrics, targetPage);
            const pageHeight = getPageHeight(metrics, targetPage);
            if (top === null || pageHeight === null) {
                return;
            }
            const nextTop = resolveMarkerScrollTop({
                pageTop: top,
                pageHeight,
                containerHeight: container.clientHeight,
                margin,
                pageYRatio: options?.pageYRatio,
                markerRect: options?.markerRect,
            });
            const pageIndex = targetPage - 1;
            const nextLeft = resolveMarkerScrollLeft({
                pageLeft: getLayoutPageLeft(metrics, pageIndex, container.clientWidth),
                pageWidth: metrics.pageWidths[pageIndex] ?? 0,
                containerWidth: container.clientWidth,
                margin,
                markerRect: options?.markerRect,
            });
            logPdfNav(
                `[PDF-NAV] usePdfScroll.scrollToPage source=layout targetPage=${targetPage}`
                + ` pageHeight=${pageHeight.toFixed(1)} gap=${metrics.gap.toFixed(1)}`
                + ` paddingTop=${metrics.paddingTop.toFixed(1)}`
                + ` top=${top.toFixed(1)} margin=${margin.toFixed(1)}`
                + ` marker=${options?.markerRect ? 'true' : 'false'}`
                + ` pageY=${typeof options?.pageYRatio === 'number' ? options.pageYRatio.toFixed(3) : 'none'}`
                + ` nextLeft=${nextLeft === null ? 'none' : nextLeft.toFixed(1)}`
                + ` nextTop=${nextTop.toFixed(1)} scrollTop(before)=${container.scrollTop.toFixed(1)}`,
            );
            applyViewportWrite(container, {
                ...(nextLeft !== null ? {left: nextLeft} : {}),
                top: nextTop,
            }, 'navigate:layout');
            return;
        }

        logPdfNav(
            '[PDF-NAV] usePdfScroll.scrollToPage failed: no DOM target and no layout metrics'
            + ` targetPage=${targetPage} totalPages=${totalPages}`,
        );
    }

    function updateVisibleRange(container: HTMLElement | null, totalPages: number) {
        visibleRange.value = getVisiblePageRange(container, totalPages);
    }

    function updateCurrentPage(
        container: HTMLElement | null,
        totalPages: number,
        options?: { requireAuthoritative?: boolean; },
    ) {
        const resolved = resolveMostVisiblePage(container, totalPages);
        if (options?.requireAuthoritative && !resolved.authoritative) {
            return currentPage.value;
        }
        return resolved.page;
    }

    function bindCurrentPageProjection(projection: Readonly<Ref<number>>) {
        currentPageProjection.value = {projection};
    }

    return {
        currentPage,
        visibleRange,
        getVisiblePageRange,
        getMostVisiblePage,
        getViewportVisibility,
        setPageLayoutMetrics,
        getPageLayoutMetrics: () => pageLayoutMetrics.value,
        scrollToPage,
        updateVisibleRange,
        updateCurrentPage,
        bindCurrentPageProjection,
        viewportWritePort,
    };
};
