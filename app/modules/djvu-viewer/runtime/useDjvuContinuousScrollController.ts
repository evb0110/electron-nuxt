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
    resolveDjvuContinuousScrollGeometry,
    resolveDjvuContinuousScrollWindow,
    type IDjvuContinuousScrollGeometry,
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

interface IInvalidateContinuousScrollWindowCacheOptions {resetStabilizedWindow?: boolean;}

interface IUseDjvuContinuousScrollControllerOptions {
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
    syncLoadedPages: () => void;
    totalPages: ComputedRef<number>;
    viewerContainer: Ref<HTMLElement | null>;
}

const DJVU_SCROLL_STABILIZATION_SETTLE_MS = 180;
const DJVU_PROGRAMMATIC_SCROLL_GUARD_MS = 180;
const DJVU_MAX_STABILIZED_WINDOW_PAGES = 36;
const DJVU_WHEEL_DELTA_EPSILON = 0.01;
const DJVU_WHEEL_VERTICAL_INTENT_RATIO = 1.1;
const WHEEL_DELTA_LINE_MODE = 1;
const WHEEL_DELTA_PAGE_MODE = 2;

export const useDjvuContinuousScrollController = (options: IUseDjvuContinuousScrollControllerOptions) => {
    const scrollTop = ref(0);
    const scrollDirection = ref<0 | 1 | -1>(0);
    const isProgrammaticScrollGuardActive = ref(false);
    const isUserScrollStabilizing = ref(false);
    const stabilizedScrollWindow = ref<IDjvuContinuousScrollWindow | null>(null);
    const continuousScrollGeometry = computed<IDjvuContinuousScrollGeometry>(() => (
        resolveDjvuContinuousScrollGeometry({
            pageGapPx: options.pageGapPx,
            pageHeights: getContinuousPageHeights(),
            totalPages: options.totalPages.value,
        })
    ));

    let continuousScrollWindowCache: IDjvuContinuousScrollWindowCacheEntry | null = null;
    let scrollRafId = 0;
    let programmaticScrollGuardTimer: number | null = null;
    let userScrollSettleTimer: number | null = null;

    function createContinuousScrollPageNumbers(start: number, end: number) {
        return Array.from({ length: end - start + 1 }, (_, index) => start + index);
    }

    function createMergedContinuousScrollWindow(
        previousWindow: IDjvuContinuousScrollWindow | null,
        rawWindow: IDjvuContinuousScrollWindow,
    ): IDjvuContinuousScrollWindow {
        if (!previousWindow) {
            return rawWindow;
        }

        const start = Math.max(1, Math.min(previousWindow.start, rawWindow.start));
        const end = Math.min(options.totalPages.value, Math.max(previousWindow.end, rawWindow.end));
        if (end - start + 1 > DJVU_MAX_STABILIZED_WINDOW_PAGES) {
            return rawWindow;
        }

        return {
            start,
            end,
            mostVisiblePage: rawWindow.mostVisiblePage,
            pageNumbers: createContinuousScrollPageNumbers(start, end),
        };
    }

    function clearProgrammaticScrollGuardTimer() {
        if (programmaticScrollGuardTimer === null || typeof window === 'undefined') {
            programmaticScrollGuardTimer = null;
            return;
        }

        window.clearTimeout(programmaticScrollGuardTimer);
        programmaticScrollGuardTimer = null;
    }

    function clearUserScrollSettleTimer() {
        if (userScrollSettleTimer === null || typeof window === 'undefined') {
            userScrollSettleTimer = null;
            return;
        }

        window.clearTimeout(userScrollSettleTimer);
        userScrollSettleTimer = null;
    }

    function clearStabilizedScrollWindow() {
        clearUserScrollSettleTimer();
        isUserScrollStabilizing.value = false;
        stabilizedScrollWindow.value = null;
    }

    function beginProgrammaticScrollGuard() {
        clearStabilizedScrollWindow();
        isProgrammaticScrollGuardActive.value = true;
        clearProgrammaticScrollGuardTimer();
        if (typeof window === 'undefined') {
            return;
        }

        programmaticScrollGuardTimer = window.setTimeout(() => {
            programmaticScrollGuardTimer = null;
            isProgrammaticScrollGuardActive.value = false;
        }, DJVU_PROGRAMMATIC_SCROLL_GUARD_MS);
    }

    function scheduleUserScrollSettle() {
        if (typeof window === 'undefined') {
            isUserScrollStabilizing.value = false;
            stabilizedScrollWindow.value = null;
            return;
        }

        clearUserScrollSettleTimer();
        userScrollSettleTimer = window.setTimeout(() => {
            userScrollSettleTimer = null;
            isUserScrollStabilizing.value = false;
            stabilizedScrollWindow.value = null;
            invalidateContinuousScrollWindowCache({ resetStabilizedWindow: false });
        }, DJVU_SCROLL_STABILIZATION_SETTLE_MS);
    }

    function isMeasuredPage(pageNumber: number) {
        return Number.isFinite(pageNumber)
            && pageNumber >= 1
            && pageNumber <= options.totalPages.value
            && getContinuousPageHeight(pageNumber) > 0;
    }

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

    function getContinuousPageHeights() {
        return options.pageSizes.value.map((_, index) => getContinuousPageHeight(index + 1));
    }

    function resolveContinuousScrollGeometry(): IDjvuContinuousScrollGeometry {
        return continuousScrollGeometry.value;
    }

    function getContinuousPageTop(pageNumber: number) {
        if (options.totalPages.value <= 0) {
            return 0;
        }

        const normalizedPage = clamp(pageNumber, 1, options.totalPages.value);
        return resolveContinuousScrollGeometry().pageTops[normalizedPage - 1] ?? 0;
    }

    function getContinuousDocumentHeight() {
        return resolveContinuousScrollGeometry().totalHeight;
    }

    function resolveRawContinuousScrollWindow(): IDjvuContinuousScrollWindow | null {
        if (!options.isContinuousScroll.value || options.totalPages.value <= 0) {
            return null;
        }

        const containerHeightValue = getContinuousScrollViewportHeight();
        const usesFallback = containerHeightValue <= 0;
        const cached = getCachedContinuousScrollWindow(containerHeightValue, usesFallback);
        if (cached) {
            return cached;
        }

        const geometry = resolveContinuousScrollGeometry();
        const result = resolveDjvuContinuousScrollWindow({
            currentPage: options.currentPage.value,
            geometry,
            pageGapPx: options.pageGapPx,
            pageHeights: geometry.pageHeights,
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

    function resolveContinuousScrollWindow(): IDjvuContinuousScrollWindow | null {
        const rawWindow = resolveRawContinuousScrollWindow();
        if (!rawWindow) {
            return null;
        }

        if (!isUserScrollStabilizing.value) {
            return rawWindow;
        }

        return createMergedContinuousScrollWindow(stabilizedScrollWindow.value, rawWindow);
    }

    function invalidateContinuousScrollWindowCache(
        cacheOptions: IInvalidateContinuousScrollWindowCacheOptions = {},
    ) {
        continuousScrollWindowCache = null;
        if (cacheOptions.resetStabilizedWindow ?? true) {
            clearStabilizedScrollWindow();
        }
    }

    function resetScrollState() {
        scrollTop.value = 0;
        scrollDirection.value = 0;
        isProgrammaticScrollGuardActive.value = false;
        clearProgrammaticScrollGuardTimer();
        invalidateContinuousScrollWindowCache();
    }

    function resetContainerScrollPosition() {
        const container = options.viewerContainer.value;
        if (!container) {
            resetScrollState();
            return;
        }

        beginProgrammaticScrollGuard();
        container.scrollTop = 0;
        scrollTop.value = 0;
        scrollDirection.value = 0;
        invalidateContinuousScrollWindowCache();
    }

    function updateScrollPositionFromContainer() {
        const nextScrollTop = options.viewerContainer.value?.scrollTop ?? 0;
        if (nextScrollTop > scrollTop.value) {
            scrollDirection.value = 1;
        } else if (nextScrollTop < scrollTop.value) {
            scrollDirection.value = -1;
        }
        scrollTop.value = nextScrollTop;
        invalidateContinuousScrollWindowCache({ resetStabilizedWindow: false });
    }

    function applyUserScrollWindow(previousWindow: IDjvuContinuousScrollWindow | null) {
        const rawWindow = resolveRawContinuousScrollWindow();
        if (rawWindow) {
            stabilizedScrollWindow.value = createMergedContinuousScrollWindow(previousWindow, rawWindow);
            isUserScrollStabilizing.value = true;
            scheduleUserScrollSettle();
        }
        scheduleViewportSync();
        return Boolean(rawWindow);
    }

    function normalizeContinuousWheelDelta(event: WheelEvent, container: HTMLElement) {
        if (event.deltaMode === WHEEL_DELTA_PAGE_MODE) {
            return event.deltaY * container.clientHeight;
        }
        if (event.deltaMode === WHEEL_DELTA_LINE_MODE) {
            return event.deltaY * 16;
        }
        return event.deltaY;
    }

    function hasProjectedVerticalWheelIntent(event: WheelEvent) {
        const absoluteDeltaX = Math.abs(event.deltaX);
        const absoluteDeltaY = Math.abs(event.deltaY);

        if (absoluteDeltaY < DJVU_WHEEL_DELTA_EPSILON) {
            return false;
        }

        if (absoluteDeltaX < DJVU_WHEEL_DELTA_EPSILON) {
            return true;
        }

        return absoluteDeltaY > absoluteDeltaX * DJVU_WHEEL_VERTICAL_INTENT_RATIO;
    }

    function detectCurrentPageFromViewport() {
        if (!options.isContinuousScroll.value) {
            options.emitCurrentPage(options.currentPage.value);
            return;
        }

        if (options.totalPages.value <= 0) {
            return;
        }

        const scrollWindow = resolveRawContinuousScrollWindow();
        const bestPage = scrollWindow?.mostVisiblePage ?? options.currentPage.value;

        if (bestPage !== options.currentPage.value && isMeasuredPage(bestPage)) {
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

        if (isProgrammaticScrollGuardActive.value) {
            updateScrollPositionFromContainer();
            return false;
        }

        const previousWindow = resolveContinuousScrollWindow();
        updateScrollPositionFromContainer();
        applyUserScrollWindow(previousWindow);
        return true;
    }

    function handleProjectedWheelScroll(event: WheelEvent) {
        if (
            !options.isActive.value
            || !options.isContinuousScroll.value
            || isProgrammaticScrollGuardActive.value
            || event.ctrlKey
            || event.metaKey
            || !hasProjectedVerticalWheelIntent(event)
        ) {
            return false;
        }

        const container = options.viewerContainer.value;
        if (!container) {
            return false;
        }

        const delta = normalizeContinuousWheelDelta(event, container);
        if (!Number.isFinite(delta) || Math.abs(delta) < DJVU_WHEEL_DELTA_EPSILON) {
            return false;
        }

        const previousWindow = resolveContinuousScrollWindow();
        const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        const projectedScrollTop = clamp(container.scrollTop + delta, 0, maxScrollTop);
        if (projectedScrollTop > scrollTop.value) {
            scrollDirection.value = 1;
        } else if (projectedScrollTop < scrollTop.value) {
            scrollDirection.value = -1;
        }
        scrollTop.value = projectedScrollTop;
        invalidateContinuousScrollWindowCache({ resetStabilizedWindow: false });
        return applyUserScrollWindow(previousWindow);
    }

    function scrollToContinuousPage(pageNumber: number) {
        const normalizedPage = clamp(pageNumber, 1, options.totalPages.value || 1);
        beginProgrammaticScrollGuard();

        if (normalizedPage !== options.currentPage.value) {
            options.currentPage.value = normalizedPage;
            options.emitCurrentPage(normalizedPage);
            invalidateContinuousScrollWindowCache();
        }

        const container = options.viewerContainer.value;
        if (!container) {
            return;
        }

        const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        const targetScrollTop = clamp(getContinuousPageTop(normalizedPage), 0, maxScrollTop);
        scrollDirection.value = targetScrollTop > scrollTop.value ? 1 : targetScrollTop < scrollTop.value ? -1 : 0;
        container.scrollTop = targetScrollTop;
        scrollTop.value = targetScrollTop;
        invalidateContinuousScrollWindowCache();
        void nextTick(() => {
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

        beginProgrammaticScrollGuard();
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

    function dispose() {
        cancelViewportSync();
        clearStabilizedScrollWindow();
        clearProgrammaticScrollGuardTimer();
        isProgrammaticScrollGuardActive.value = false;
    }

    return {
        cancelViewportSync,
        beginProgrammaticScrollGuard,
        captureScrollSnapshot,
        detectCurrentPageFromViewport,
        dispose,
        getContinuousDocumentHeight,
        getContinuousPageHeight,
        getContinuousPageTop,
        handleProjectedWheelScroll,
        handleViewerScroll,
        invalidateContinuousScrollWindowCache,
        isProgrammaticScrollGuardActive,
        resetContainerScrollPosition,
        resetScrollState,
        resolveContinuousScrollWindow,
        resolveContinuousScrollGeometry,
        resolveRawContinuousScrollWindow,
        restoreScrollSnapshot,
        scheduleViewportSync,
        scrollDirection,
        scrollToContinuousPage,
        scrollTop,
        updateScrollPositionFromContainer,
    };
};
