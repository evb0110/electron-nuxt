import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TPdfViewMode } from '@contracts/shared';
import type { IDjvuPageSize } from '@app/platform/browser-api/public';
import type { IScrollSnapshot } from '@app/types/pdfUi';
import type { IDocumentPageRange } from '@app/utils/document-viewer/documentPageRange';
import { normalizeDocumentPageNumber } from '@app/utils/document-viewer/documentPageRange';
import {
    getSpreadStartForPage,
    isStandaloneSpreadPage,
} from '@app/utils/pdfViewMode';
import type { TDocumentViewerPageDirection } from '@app/utils/document-viewer/virtualization/pageVirtualization';
import {
    capturePageAnchorScrollSnapshot,
    restorePageAnchorScrollSnapshot,
} from '@app/utils/document-viewer/page-anchor-scroll-snapshot/pageAnchorScrollSnapshot';
import { useDjvuContinuousScrollController } from '@app/modules/djvu-viewer/runtime/useDjvuContinuousScrollController';
import type {
    IDjvuContinuousScrollGeometry,
    IDjvuContinuousScrollWindow,
} from '@app/modules/djvu-viewer/resolveDjvuContinuousScrollWindow';

export interface IDjvuViewportController {
    currentPage: Ref<number>;
    visibleRange: Ref<IDocumentPageRange>;
    renderedPageNumbers: ComputedRef<number[]>;
    scrollDirection: Ref<TDocumentViewerPageDirection>;
    resolveContinuousScrollWindow: () => IDjvuContinuousScrollWindow | null;
    resolveRawContinuousScrollWindow: () => IDjvuContinuousScrollWindow | null;
    resolveContinuousScrollGeometry: () => IDjvuContinuousScrollGeometry;
    handleViewerScroll: () => boolean;
    handleProjectedWheelScroll: (event: WheelEvent) => boolean;
    scrollToPage: (pageNumber: number) => void;
    captureScrollSnapshot: () => IScrollSnapshot | null;
    restoreScrollSnapshot: (snapshot: IScrollSnapshot | null, options?: { fallbackPage?: number | null }) => void;
    notifyZoomChanged: (source: 'zoom' | 'zoom-mode' | 'view-mode') => void;
    cancelViewportWork: (reason: 'reload' | 'inactive' | 'disposed' | 'superseded') => void;
    dispose: () => void;
    beginProgrammaticScrollGuard: () => void;
    detectCurrentPageFromViewport: () => void;
    getContinuousDocumentHeight: () => number;
    getContinuousPageTop: (pageNumber: number) => number;
    invalidateContinuousScrollWindowCache: () => void;
    resetContainerScrollPosition: () => void;
    resetScrollState: () => void;
    scheduleViewportSync: () => void;
    updateScrollPositionFromContainer: () => void;
}

interface IUseDjvuViewportControllerOptions {
    clearPageFlipWheelAccumulator: () => void;
    containerHeight: Ref<number>;
    currentPage: Ref<number>;
    emitCurrentPage: (pageNumber: number) => void;
    getPageDisplayScale: (pageNumber: number) => number;
    isActive: ComputedRef<boolean>;
    isContinuousScroll: ComputedRef<boolean>;
    pageGapPx: number;
    pageSizes: Ref<IDjvuPageSize[]>;
    pageSnapshotSelector: string;
    renderMarginPages: number;
    overscanViewports: number;
    scrollActiveSpreadIntoView: () => void;
    syncLoadedPages: () => void;
    totalPages: ComputedRef<number>;
    viewMode: ComputedRef<TPdfViewMode>;
    viewerContainer: Ref<HTMLElement | null>;
}

export const useDjvuViewportController = (options: IUseDjvuViewportControllerOptions): IDjvuViewportController => {
    const visibleRange = ref<IDocumentPageRange>({
        start: 1,
        end: 1,
    });
    const continuousScrollController = useDjvuContinuousScrollController({
        containerHeight: options.containerHeight,
        currentPage: options.currentPage,
        emitCurrentPage: options.emitCurrentPage,
        getPageDisplayScale: options.getPageDisplayScale,
        isActive: options.isActive,
        isContinuousScroll: options.isContinuousScroll,
        pageGapPx: options.pageGapPx,
        pageSizes: options.pageSizes,
        pageSnapshotSelector: options.pageSnapshotSelector,
        renderMarginPages: options.renderMarginPages,
        overscanViewports: options.overscanViewports,
        syncLoadedPages: options.syncLoadedPages,
        totalPages: options.totalPages,
        viewerContainer: options.viewerContainer,
    });

    function commitVisibleRangeFromWindow(scrollWindow: IDjvuContinuousScrollWindow | null) {
        if (!scrollWindow) {
            return;
        }

        visibleRange.value = {
            start: scrollWindow.start,
            end: scrollWindow.end,
        };
    }

    function resolveContinuousScrollWindow() {
        const scrollWindow = continuousScrollController.resolveContinuousScrollWindow();
        commitVisibleRangeFromWindow(scrollWindow);
        return scrollWindow;
    }

    function resolveRawContinuousScrollWindow() {
        const scrollWindow = continuousScrollController.resolveRawContinuousScrollWindow();
        commitVisibleRangeFromWindow(scrollWindow);
        return scrollWindow;
    }

    const renderedPageNumbers = computed(() => {
        if (options.totalPages.value <= 0) {
            return [] as number[];
        }

        if (options.isContinuousScroll.value) {
            return resolveContinuousScrollWindow()?.pageNumbers ?? [];
        }

        const spreadStart = getSpreadStartForPage(
            options.currentPage.value,
            options.viewMode.value,
            options.totalPages.value,
        );

        if (options.viewMode.value === 'single' || options.totalPages.value === 1) {
            visibleRange.value = {
                start: spreadStart,
                end: spreadStart,
            };
            return [spreadStart];
        }

        if (isStandaloneSpreadPage(spreadStart, options.viewMode.value, options.totalPages.value)) {
            visibleRange.value = {
                start: spreadStart,
                end: spreadStart,
            };
            return [spreadStart];
        }

        const nextPage = spreadStart + 1;
        if (nextPage > options.totalPages.value) {
            visibleRange.value = {
                start: spreadStart,
                end: spreadStart,
            };
            return [spreadStart];
        }

        visibleRange.value = {
            start: spreadStart,
            end: nextPage,
        };
        return [
            spreadStart,
            nextPage,
        ];
    });

    function scrollToPage(pageNumber: number) {
        const normalizedPage = normalizeDocumentPageNumber(pageNumber, options.totalPages.value || 1);

        if (!options.isContinuousScroll.value) {
            options.currentPage.value = normalizedPage;
            options.emitCurrentPage(normalizedPage);
            options.clearPageFlipWheelAccumulator();
            void nextTick().then(() => {
                options.scrollActiveSpreadIntoView();
                options.syncLoadedPages();
            });
            return;
        }

        continuousScrollController.scrollToContinuousPage(normalizedPage);
    }

    function getSnapshotPage(value: number | null | undefined) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return null;
        }
        return normalizeDocumentPageNumber(value, options.totalPages.value || 1);
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
                scrollToPage(fallbackPage);
            }
            return;
        }

        if (anchorPage !== null && anchorPage !== options.currentPage.value) {
            options.currentPage.value = anchorPage;
            options.emitCurrentPage(anchorPage);
            continuousScrollController.invalidateContinuousScrollWindowCache();
        }

        void nextTick(() => {
            continuousScrollController.beginProgrammaticScrollGuard();
            restorePageAnchorScrollSnapshot(
                options.viewerContainer.value,
                snapshot,
                { pageSelector: options.pageSnapshotSelector },
            );
            continuousScrollController.updateScrollPositionFromContainer();
            continuousScrollController.detectCurrentPageFromViewport();
            options.syncLoadedPages();
        });
    }

    function notifyZoomChanged() {
        continuousScrollController.invalidateContinuousScrollWindowCache();
    }

    function cancelViewportWork() {
        continuousScrollController.cancelViewportSync();
    }

    function dispose() {
        continuousScrollController.dispose();
    }

    return {
        currentPage: options.currentPage,
        visibleRange,
        renderedPageNumbers,
        scrollDirection: continuousScrollController.scrollDirection,
        resolveContinuousScrollWindow,
        resolveRawContinuousScrollWindow,
        resolveContinuousScrollGeometry: continuousScrollController.resolveContinuousScrollGeometry,
        handleViewerScroll: continuousScrollController.handleViewerScroll,
        handleProjectedWheelScroll: continuousScrollController.handleProjectedWheelScroll,
        scrollToPage,
        captureScrollSnapshot,
        restoreScrollSnapshot,
        notifyZoomChanged,
        cancelViewportWork,
        dispose,
        beginProgrammaticScrollGuard: continuousScrollController.beginProgrammaticScrollGuard,
        detectCurrentPageFromViewport: continuousScrollController.detectCurrentPageFromViewport,
        getContinuousDocumentHeight: continuousScrollController.getContinuousDocumentHeight,
        getContinuousPageTop: continuousScrollController.getContinuousPageTop,
        invalidateContinuousScrollWindowCache: continuousScrollController.invalidateContinuousScrollWindowCache,
        resetContainerScrollPosition: continuousScrollController.resetContainerScrollPosition,
        resetScrollState: continuousScrollController.resetScrollState,
        scheduleViewportSync: continuousScrollController.scheduleViewportSync,
        updateScrollPositionFromContainer: continuousScrollController.updateScrollPositionFromContainer,
    };
};
