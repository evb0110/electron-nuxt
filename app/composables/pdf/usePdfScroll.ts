import type { IScrollSnapshot } from '@app/types/pdf';
import { clamp } from 'es-toolkit/math';
import { logPdfNav } from '@app/utils/pdf-nav-log';
import {
    getPageContainerByNumber,
    getViewportVisibilityFromDom,
    type IViewportVisibilityResult,
} from '@app/composables/pdf/pdfScrollVisibility';
import type { IPdfPageLayoutMetrics } from '@app/composables/pdf/pdfPageLayout';
import {
    getPageHeight,
    getPageTop,
} from '@app/composables/pdf/pdfPageLayout';

type TPageLayoutMetrics = IPdfPageLayoutMetrics;

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

export const usePdfScroll = () => {
    const currentPage = ref(1);
    const visibleRange = ref({
        start: 1,
        end: 1,
    });
    const pageLayoutMetrics = ref<TPageLayoutMetrics | null>(null);
    let viewportVisibilityCache: IViewportVisibilityCacheEntry | null = null;

    function setPageLayoutMetrics(metrics: TPageLayoutMetrics | null) {
        pageLayoutMetrics.value = metrics;
        viewportVisibilityCache = null;
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
        let start: number | null = null;
        let end: number | null = null;
        let mostVisiblePage: number | null = null;
        let maxVisibleArea = 0;

        for (let index = 0; index < metrics.pageTops.length; index += 1) {
            const pageTop = Math.max(0, metrics.pageTops[index]! - metrics.paddingTop);
            const pageHeight = metrics.pageHeights[index] ?? 0;
            const pageBottom = pageTop + pageHeight;
            const visibleTop = Math.max(pageTop, viewportTop);
            const visibleBottom = Math.min(pageBottom, viewportBottom);
            const visibleArea = Math.max(0, visibleBottom - visibleTop);

            if (pageBottom > viewportTop && start === null) {
                start = index + 1;
            }

            if (pageTop < viewportBottom) {
                end = index + 1;
            } else {
                break;
            }

            if (visibleArea > maxVisibleArea) {
                maxVisibleArea = visibleArea;
                mostVisiblePage = index + 1;
            }
        }

        if (start === null || end === null) {
            return null;
        }

        return {
            range: {
                start: clamp(start, 1, totalPages),
                end: clamp(Math.max(start, end), 1, totalPages),
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
        if (!container || totalPages === 0) {
            return {
                start: 1,
                end: 1,
            };
        }

        const visibility = getViewportVisibility(container, totalPages);
        if (visibility.range) {
            return visibility.range;
        }

        return {
            start: 1,
            end: 1,
        };
    }

    function getMostVisiblePage(
        container: HTMLElement | null,
        totalPages: number,
    ): number {
        if (!container || totalPages === 0) {
            return 1;
        }

        const visibility = getViewportVisibility(container, totalPages);
        if (visibility.mostVisiblePage !== null) {
            return visibility.mostVisiblePage;
        }

        return 1;
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
        const cached = viewportVisibilityCache;
        if (
            cached &&
            cached.container === container &&
            cached.totalPages === totalPages &&
            cached.scrollTop === container.scrollTop &&
            cached.scrollLeft === container.scrollLeft &&
            cached.clientWidth === container.clientWidth &&
            cached.clientHeight === container.clientHeight &&
            cached.layoutMetrics === metrics
        ) {
            return cached.result;
        }

        const layoutVisibility = getViewportVisibilityFromLayout(container, totalPages);
        const result = layoutVisibility ?? getViewportVisibilityFromDom(container, totalPages);
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
        return result;
    }

    function scrollToPage(
        container: HTMLElement | null,
        pageNumber: number,
        totalPages: number,
        margin: number,
        options?: {preferExactDom?: boolean;},
    ) {
        if (!container || totalPages === 0) {
            return;
        }

        const targetPage = clamp(pageNumber, 1, totalPages);
        const targetEl = getPageContainerByNumber(container, targetPage);

        if (targetEl) {
            const nextTop = targetEl.offsetTop - margin;
            logPdfNav(
                `[PDF-NAV] usePdfScroll.scrollToPage source=dom targetPage=${targetPage}`
                + ` offsetTop=${targetEl.offsetTop.toFixed(1)} margin=${margin.toFixed(1)}`
                + ` nextTop=${nextTop.toFixed(1)} scrollTop(before)=${container.scrollTop.toFixed(1)}`,
            );
            container.scrollTop = nextTop;
            currentPage.value = targetPage;
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
            const nextTop = Math.max(0, top - margin);
            logPdfNav(
                `[PDF-NAV] usePdfScroll.scrollToPage source=layout targetPage=${targetPage}`
                + ` pageHeight=${pageHeight.toFixed(1)} gap=${metrics.gap.toFixed(1)}`
                + ` paddingTop=${metrics.paddingTop.toFixed(1)}`
                + ` top=${top.toFixed(1)} margin=${margin.toFixed(1)}`
                + ` nextTop=${nextTop.toFixed(1)} scrollTop(before)=${container.scrollTop.toFixed(1)}`,
            );
            container.scrollTop = nextTop;
            currentPage.value = targetPage;
            return;
        }

        logPdfNav(
            '[PDF-NAV] usePdfScroll.scrollToPage failed: no DOM target and no layout metrics'
            + ` targetPage=${targetPage} totalPages=${totalPages}`,
        );
    }

    function captureScrollSnapshot(container: HTMLElement | null): IScrollSnapshot | null {
        if (!container) {
            return null;
        }

        const {
            scrollWidth,
            scrollHeight,
        } = container;

        if (!scrollWidth || !scrollHeight) {
            return null;
        }

        return {
            width: scrollWidth,
            height: scrollHeight,
            centerX: container.scrollLeft + container.clientWidth / 2,
            centerY: container.scrollTop + container.clientHeight / 2,
        };
    }

    function restoreScrollFromSnapshot(
        container: HTMLElement | null,
        snapshot: IScrollSnapshot | null,
    ) {
        if (!snapshot || !container) {
            return;
        }

        const newWidth = container.scrollWidth;
        const newHeight = container.scrollHeight;

        if (!newWidth || !newHeight || !snapshot.width || !snapshot.height) {
            return;
        }

        const targetLeft = (snapshot.centerX / snapshot.width) * newWidth - container.clientWidth / 2;
        const targetTop = (snapshot.centerY / snapshot.height) * newHeight - container.clientHeight / 2;

        container.scrollLeft = Math.max(0, targetLeft);
        container.scrollTop = Math.max(0, targetTop);
    }

    function updateVisibleRange(container: HTMLElement | null, totalPages: number) {
        visibleRange.value = getVisiblePageRange(container, totalPages);
    }

    function updateCurrentPage(container: HTMLElement | null, totalPages: number) {
        const page = getMostVisiblePage(container, totalPages);
        if (page !== currentPage.value) {
            currentPage.value = page;
        }
        return page;
    }

    return {
        currentPage,
        visibleRange,
        getVisiblePageRange,
        getMostVisiblePage,
        getViewportVisibility,
        setPageLayoutMetrics,
        scrollToPage,
        captureScrollSnapshot,
        restoreScrollFromSnapshot,
        updateVisibleRange,
        updateCurrentPage,
    };
};
