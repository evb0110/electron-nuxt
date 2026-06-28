import type {
    ComputedRef,
    Ref,
} from 'vue';
import { clamp } from 'es-toolkit/math';
import type { IDjvuPageSize } from '@app/platform/browser-api/public';
import type { IScrollSnapshot } from '@app/types/pdf';
import {
    capturePageAnchorScrollSnapshot,
    restorePageAnchorScrollSnapshot,
} from '@app/utils/document-viewer/page-anchor-scroll-snapshot/pageAnchorScrollSnapshot';
import {
    resolveDjvuContinuousScrollWindow,
    type IDjvuContinuousScrollWindow,
} from '@app/modules/djvu-viewer/resolveDjvuContinuousScrollWindow';

interface IDjvuContinuousScrollWindowCacheEntry {
    scrollTop: number;
    containerHeight: number;
    totalPages: number;
    pageSizes: IDjvuPageSize[];
    usesFallback: boolean;
    result: IDjvuContinuousScrollWindow;
}

interface IUseDjvuContinuousScrollControllerOptions {
    containerHeight: Ref<number>;
    currentPage: Ref<number>;
    emitCurrentPage: (pageNumber: number) => void;
    getPageDisplayScale: (pageNumber: number) => number;
    isActive: ComputedRef<boolean>;
    isContinuousScroll: ComputedRef<boolean>;
    pageElements: Map<number, HTMLElement>;
    pageGapPx: number;
    pageSizes: Ref<IDjvuPageSize[]>;
    pageSnapshotSelector: string;
    renderMarginPages: number;
    overscanViewports: number;
    syncLoadedPages: () => void;
    totalPages: ComputedRef<number>;
    viewerContainer: Ref<HTMLElement | null>;
}

export const useDjvuContinuousScrollController = (options: IUseDjvuContinuousScrollControllerOptions) => {
    const scrollTop = ref(0);
    const scrollDirection = ref<0 | 1 | -1>(0);

    let continuousScrollWindowCache: IDjvuContinuousScrollWindowCacheEntry | null = null;
    let scrollRafId = 0;

    function getContinuousScrollViewportHeight() {
        const measuredHeight = options.containerHeight.value > 0
            ? options.containerHeight.value
            : options.viewerContainer.value?.clientHeight ?? 0;
        return Math.max(0, measuredHeight);
    }

    function cacheContinuousScrollWindow(
        result: IDjvuContinuousScrollWindow,
        containerHeightValue: number,
        usesFallback: boolean,
    ) {
        continuousScrollWindowCache = {
            scrollTop: scrollTop.value,
            containerHeight: containerHeightValue,
            totalPages: options.totalPages.value,
            pageSizes: options.pageSizes.value,
            usesFallback,
            result,
        };
        return result;
    }

    function getCachedContinuousScrollWindow(
        containerHeightValue: number,
        usesFallback: boolean,
    ) {
        const cached = continuousScrollWindowCache;
        if (
            cached
            && cached.scrollTop === scrollTop.value
            && cached.containerHeight === containerHeightValue
            && cached.totalPages === options.totalPages.value
            && cached.usesFallback === usesFallback
            && cached.pageSizes === options.pageSizes.value
        ) {
            if (usesFallback && cached.result.mostVisiblePage !== options.currentPage.value) {
                return null;
            }
            return cached.result;
        }

        return null;
    }

    function getContinuousPageHeight(pageNumber: number) {
        const pageSize = options.pageSizes.value[pageNumber - 1];
        if (!pageSize) {
            return 0;
        }

        return Math.max(1, Math.round(pageSize.height * options.getPageDisplayScale(pageNumber)));
    }

    function getContinuousPagesHeight(startPage: number, endPage: number) {
        if (startPage > endPage || options.totalPages.value <= 0) {
            return 0;
        }

        const normalizedStart = clamp(startPage, 1, options.totalPages.value);
        const normalizedEnd = clamp(endPage, 1, options.totalPages.value);
        let height = 0;
        for (let pageNumber = normalizedStart; pageNumber <= normalizedEnd; pageNumber += 1) {
            height += getContinuousPageHeight(pageNumber);
            if (pageNumber < normalizedEnd) {
                height += options.pageGapPx;
            }
        }
        return height;
    }

    function resolveContinuousScrollWindow(): IDjvuContinuousScrollWindow | null {
        if (!options.isContinuousScroll.value || options.totalPages.value <= 0) {
            return null;
        }

        const containerHeightValue = getContinuousScrollViewportHeight();
        const usesFallback = containerHeightValue <= 0;
        const cached = getCachedContinuousScrollWindow(containerHeightValue, usesFallback);
        if (cached) {
            return cached;
        }

        const result = resolveDjvuContinuousScrollWindow({
            currentPage: options.currentPage.value,
            pageGapPx: options.pageGapPx,
            pageHeights: options.pageSizes.value.map((_, index) => getContinuousPageHeight(index + 1)),
            renderMarginPages: options.renderMarginPages,
            scrollTop: scrollTop.value,
            totalPages: options.totalPages.value,
            viewportHeight: containerHeightValue,
            overscanViewports: options.overscanViewports,
        });
        if (!result) {
            return null;
        }

        return cacheContinuousScrollWindow(
            result,
            containerHeightValue,
            usesFallback,
        );
    }

    function invalidateContinuousScrollWindowCache() {
        continuousScrollWindowCache = null;
    }

    function resetScrollState() {
        scrollTop.value = 0;
        scrollDirection.value = 0;
        invalidateContinuousScrollWindowCache();
    }

    function resetContainerScrollPosition() {
        if (options.viewerContainer.value) {
            options.viewerContainer.value.scrollTop = 0;
        }
        resetScrollState();
    }

    function updateScrollPositionFromContainer() {
        const nextScrollTop = options.viewerContainer.value?.scrollTop ?? 0;
        if (nextScrollTop > scrollTop.value) {
            scrollDirection.value = 1;
        } else if (nextScrollTop < scrollTop.value) {
            scrollDirection.value = -1;
        }
        scrollTop.value = nextScrollTop;
        invalidateContinuousScrollWindowCache();
    }

    function detectCurrentPageFromViewport() {
        if (!options.isContinuousScroll.value) {
            options.emitCurrentPage(options.currentPage.value);
            return;
        }

        if (options.totalPages.value <= 0) {
            return;
        }

        const scrollWindow = resolveContinuousScrollWindow();
        const bestPage = scrollWindow?.mostVisiblePage ?? options.currentPage.value;

        if (bestPage !== options.currentPage.value) {
            options.currentPage.value = bestPage;
            options.emitCurrentPage(bestPage);
        }
    }

    function scheduleViewportSync() {
        if (scrollRafId !== 0 || typeof window === 'undefined') {
            return;
        }

        scrollRafId = window.requestAnimationFrame(() => {
            scrollRafId = 0;
            detectCurrentPageFromViewport();
        });
    }

    function cancelViewportSync() {
        if (scrollRafId === 0 || typeof window === 'undefined') {
            return;
        }

        window.cancelAnimationFrame(scrollRafId);
        scrollRafId = 0;
    }

    function handleViewerScroll() {
        if (!options.isActive.value) {
            return false;
        }

        updateScrollPositionFromContainer();
        scheduleViewportSync();
        return true;
    }

    function scrollToContinuousPage(pageNumber: number) {
        const normalizedPage = clamp(pageNumber, 1, options.totalPages.value || 1);
        const previousPage = options.currentPage.value;

        if (normalizedPage !== options.currentPage.value) {
            options.currentPage.value = normalizedPage;
            options.emitCurrentPage(normalizedPage);
            invalidateContinuousScrollWindowCache();
        }

        const element = options.pageElements.get(normalizedPage);
        if (element) {
            scrollDirection.value = normalizedPage > previousPage ? 1 : normalizedPage < previousPage ? -1 : 0;
            element.scrollIntoView({
                block: 'start',
                inline: 'nearest',
            });
            return;
        }

        const container = options.viewerContainer.value;
        if (!container) {
            return;
        }

        const targetScrollTop = options.pageGapPx
            + getContinuousPagesHeight(1, normalizedPage - 1)
            + (normalizedPage > 1 ? options.pageGapPx : 0);
        scrollDirection.value = targetScrollTop > scrollTop.value ? 1 : targetScrollTop < scrollTop.value ? -1 : 0;
        container.scrollTop = targetScrollTop;
        scrollTop.value = targetScrollTop;
        invalidateContinuousScrollWindowCache();
        void nextTick(() => {
            options.pageElements.get(normalizedPage)?.scrollIntoView({
                block: 'start',
                inline: 'nearest',
            });
            options.syncLoadedPages();
        });
    }

    function getSnapshotPage(value: number | null | undefined) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return null;
        }
        return clamp(Math.floor(value), 1, options.totalPages.value || 1);
    }

    function captureScrollSnapshot(): IScrollSnapshot | null {
        return capturePageAnchorScrollSnapshot(
            options.viewerContainer.value,
            {
                pageSelector: options.pageSnapshotSelector,
                preferredAnchorPage: options.currentPage.value,
            },
        );
    }

    function restoreScrollSnapshot(
        snapshot: IScrollSnapshot | null,
        restoreOptions?: { fallbackPage?: number | null },
    ) {
        const fallbackPage = getSnapshotPage(restoreOptions?.fallbackPage);
        const anchorPage = getSnapshotPage(snapshot?.anchorPage) ?? fallbackPage;
        if (!snapshot) {
            if (fallbackPage !== null) {
                scrollToContinuousPage(fallbackPage);
            }
            return;
        }

        if (anchorPage !== null && anchorPage !== options.currentPage.value) {
            options.currentPage.value = anchorPage;
            options.emitCurrentPage(anchorPage);
            invalidateContinuousScrollWindowCache();
        }

        void nextTick(() => {
            restorePageAnchorScrollSnapshot(
                options.viewerContainer.value,
                snapshot,
                { pageSelector: options.pageSnapshotSelector },
            );
            updateScrollPositionFromContainer();
            detectCurrentPageFromViewport();
            options.syncLoadedPages();
        });
    }

    return {
        cancelViewportSync,
        captureScrollSnapshot,
        detectCurrentPageFromViewport,
        getContinuousPageHeight,
        getContinuousPagesHeight,
        handleViewerScroll,
        invalidateContinuousScrollWindowCache,
        resetContainerScrollPosition,
        resetScrollState,
        resolveContinuousScrollWindow,
        restoreScrollSnapshot,
        scheduleViewportSync,
        scrollDirection,
        scrollToContinuousPage,
        scrollTop,
        updateScrollPositionFromContainer,
    };
};
