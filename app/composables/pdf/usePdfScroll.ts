import type { IScrollSnapshot } from '@app/types/pdf';
import { clamp } from 'es-toolkit/math';
import { logPdfNav } from '@app/utils/pdf-nav-log';
import {
    getMostVisiblePageFromDom,
    getPageContainerByNumber,
    getVisiblePageRangeFromDom,
} from '@app/composables/pdf/pdfScrollVisibility';
import type { IPdfPageLayoutMetrics } from '@app/composables/pdf/pdfPageLayout';
import {
    getPageHeight,
    getPageTop,
} from '@app/composables/pdf/pdfPageLayout';

type TPageLayoutMetrics = IPdfPageLayoutMetrics;

export const usePdfScroll = () => {
    const currentPage = ref(1);
    const visibleRange = ref({
        start: 1,
        end: 1,
    });
    const pageLayoutMetrics = ref<TPageLayoutMetrics | null>(null);

    function setPageLayoutMetrics(metrics: TPageLayoutMetrics | null) {
        pageLayoutMetrics.value = metrics;
    }

    function getVisiblePageRangeFromLayout(
        container: HTMLElement,
        totalPages: number,
    ) {
        const metrics = pageLayoutMetrics.value;
        if (!metrics || metrics.totalPages !== totalPages) {
            return null;
        }

        const viewportTop = Math.max(0, container.scrollTop - metrics.paddingTop);
        const viewportBottom = viewportTop + container.clientHeight;
        let start: number | null = null;
        let end: number | null = null;

        for (let index = 0; index < metrics.pageTops.length; index += 1) {
            const pageTop = Math.max(0, metrics.pageTops[index]! - metrics.paddingTop);
            const pageHeight = metrics.pageHeights[index] ?? 0;
            const pageBottom = pageTop + pageHeight;

            if (pageBottom > viewportTop && start === null) {
                start = index + 1;
            }

            if (pageTop < viewportBottom) {
                end = index + 1;
                continue;
            }

            break;
        }

        if (start === null || end === null) {
            return null;
        }

        return {
            start: clamp(start, 1, totalPages),
            end: clamp(Math.max(start, end), 1, totalPages),
        };
    }

    function getMostVisiblePageFromLayout(
        container: HTMLElement,
        totalPages: number,
    ) {
        const metrics = pageLayoutMetrics.value;
        if (!metrics || metrics.totalPages !== totalPages) {
            return null;
        }

        const viewportCenter = Math.max(
            0,
            container.scrollTop - metrics.paddingTop + container.clientHeight / 2,
        );
        for (let index = 0; index < metrics.pageTops.length; index += 1) {
            const pageTop = Math.max(0, metrics.pageTops[index]! - metrics.paddingTop);
            const pageHeight = metrics.pageHeights[index] ?? 0;
            const pageBottom = pageTop + pageHeight;

            if (viewportCenter >= pageTop && viewportCenter <= pageBottom) {
                return clamp(index + 1, 1, totalPages);
            }

            if (viewportCenter < pageTop) {
                return clamp(index + 1, 1, totalPages);
            }
        }

        return totalPages > 0 ? totalPages : null;
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

        const domRange = getVisiblePageRangeFromDom(container, totalPages);
        if (domRange) {
            return domRange;
        }

        const layoutRange = getVisiblePageRangeFromLayout(container, totalPages);
        if (layoutRange) {
            return layoutRange;
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

        const domPage = getMostVisiblePageFromDom(container, totalPages);
        if (domPage !== null) {
            return domPage;
        }

        const layoutPage = getMostVisiblePageFromLayout(container, totalPages);
        if (layoutPage !== null) {
            return layoutPage;
        }

        return 1;
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
        setPageLayoutMetrics,
        scrollToPage,
        captureScrollSnapshot,
        restoreScrollFromSnapshot,
        updateVisibleRange,
        updateCurrentPage,
    };
};
