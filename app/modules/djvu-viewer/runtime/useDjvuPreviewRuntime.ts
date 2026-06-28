import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IDjvuPageSize } from '@app/platform/browser-api/public';
import { createDjvuPagePreviewSourceFromPath } from '@app/platform/browser-api/public';
import { BrowserLogger } from '@app/utils/browserLogger';
import { resolveDjvuPreviewResolutionPlan } from '@app/utils/djvuPreviewResolution';
import {
    createDjvuPageRenderList,
    type TDjvuScrollDirection,
} from '@app/modules/djvu-viewer/createDjvuPageRenderList';
import type { IDjvuContinuousScrollWindow } from '@app/modules/djvu-viewer/resolveDjvuContinuousScrollWindow';

export interface IDjvuPageState {
    failedRenderPx: number;
    objectUrl: string | null;
    renderedPx: number;
    status: 'idle' | 'loading' | 'loaded' | 'error';
    token: number;
}

interface IDjvuPreviewRuntimeState {
    currentPage: Ref<number>;
    isLoading: Ref<boolean>;
    pageSizes: Ref<IDjvuPageSize[]>;
    pageStates: Ref<IDjvuPageState[]>;
    viewerError: Ref<string | null>;
}

interface IDjvuPreviewRuntimeSource {
    getNeededDeviceWidth: (pageNumber: number) => number;
    getOpenErrorMessage: () => string;
    getSrc: () => TDocumentRef | null;
    isActive: ComputedRef<boolean>;
    isContinuousScroll: ComputedRef<boolean>;
    resolveContinuousScrollWindow: () => IDjvuContinuousScrollWindow | null;
    scrollDirection: Ref<TDjvuScrollDirection>;
    totalPages: ComputedRef<number>;
}

interface IDjvuPreviewRuntimeEffects {
    clearPageElements: () => void;
    emitCurrentPage: (pageNumber: number) => void;
    emitDocument: (value: null) => void;
    emitLoading: (value: boolean) => void;
    emitTotalPages: (value: number) => void;
    invalidateContinuousScrollWindowCache: () => void;
    measureContainer: () => void;
    resetScrollState: () => void;
    resetViewerScrollPosition: () => void;
    scheduleViewportSync: () => void;
    syncHorizontalScrollForZoomMode: () => void;
}

interface IDjvuPreviewRuntimeEnvironment {
    getWindow?: () => Pick<Window, 'clearTimeout' | 'setTimeout'> | undefined;
    isClient?: () => boolean;
}

interface IUseDjvuPreviewRuntimeOptions {
    effects: IDjvuPreviewRuntimeEffects;
    environment?: IDjvuPreviewRuntimeEnvironment;
    source: IDjvuPreviewRuntimeSource;
    state: IDjvuPreviewRuntimeState;
}

const DJVU_ZOOM_SETTLE_RERENDER_MS = 200;
const DJVU_SCROLL_SETTLE_PREVIEW_RERENDER_MS = 180;
const DJVU_CONTINUOUS_PREFETCH_PAGES = 4;
const DJVU_PAGE_FLIP_PREFETCH_PAGES = 2;
const DJVU_SCROLLING_PREVIEW_HEADROOM = 0.9;
const DJVU_RENDER_QUEUE_TARGET_CONCURRENCY = 2;
const DJVU_RENDER_QUEUE_MAX_CONCURRENCY = 4;

type TDjvuPagePreviewSource = Awaited<ReturnType<typeof createDjvuPagePreviewSourceFromPath>>;

export const useDjvuPreviewRuntime = (options: IUseDjvuPreviewRuntimeOptions) => {
    const {
        effects,
        source,
        state,
    } = options;

    const isScrollingPreviewMode = ref(false);

    let activeWorker: TDjvuPagePreviewSource | null = null;
    let loadGeneration = 0;
    let queuedPageNumbers: number[] = [];
    let lastRenderedPageSet = new Set<number>();
    let zoomSettleRerenderTimer: number | null = null;
    let scrollSettlePreviewTimer: number | null = null;

    const activeRenderPageNumbers = new Set<number>();

    function isClientRuntime() {
        return options.environment?.isClient?.() ?? import.meta.client;
    }

    function getTimerWindow() {
        return options.environment?.getWindow?.() ?? (typeof window === 'undefined' ? undefined : window);
    }

    function isCurrentLoadGeneration(generation: number) {
        return generation === loadGeneration;
    }

    function emitLoading(nextLoading: boolean, emitOptions: { force?: boolean } = {}) {
        if (!emitOptions.force && state.isLoading.value === nextLoading) {
            return;
        }

        state.isLoading.value = nextLoading;
        effects.emitLoading(nextLoading);
    }

    function createIdlePageState(): IDjvuPageState {
        return {
            failedRenderPx: 0,
            objectUrl: null,
            renderedPx: 0,
            status: 'idle',
            token: 0,
        };
    }

    function clearZoomSettleRerenderTimer() {
        const timerWindow = getTimerWindow();
        if (zoomSettleRerenderTimer === null || !timerWindow) {
            return;
        }

        timerWindow.clearTimeout(zoomSettleRerenderTimer);
        zoomSettleRerenderTimer = null;
    }

    function clearScrollSettlePreviewTimer() {
        const timerWindow = getTimerWindow();
        if (scrollSettlePreviewTimer === null || !timerWindow) {
            return;
        }

        timerWindow.clearTimeout(scrollSettlePreviewTimer);
        scrollSettlePreviewTimer = null;
    }

    function getPreviewResolutionPlan(pageNumber: number) {
        const pageSize = state.pageSizes.value[pageNumber - 1];
        const headroom = isScrollingPreviewMode.value ? DJVU_SCROLLING_PREVIEW_HEADROOM : undefined;

        return resolveDjvuPreviewResolutionPlan({
            ...(headroom === undefined ? {} : { headroom }),
            nativeWidth: pageSize?.width ?? 1,
            neededDevicePx: source.getNeededDeviceWidth(pageNumber),
        });
    }

    function revokePageUrl(pageNumber: number) {
        const pageState = state.pageStates.value[pageNumber - 1];
        if (!pageState?.objectUrl || !activeWorker) {
            return;
        }

        try {
            activeWorker.revokeObjectURL(pageState.objectUrl);
        } catch (error) {
            BrowserLogger.warn('djvu-viewer', 'Failed to revoke DjVu page URL', {
                pageNumber,
                error,
            });
        }

        pageState.objectUrl = null;
        pageState.failedRenderPx = 0;
        pageState.renderedPx = 0;
    }

    function resetPageState(pageNumber: number) {
        const pageState = state.pageStates.value[pageNumber - 1];
        if (!pageState) {
            return;
        }

        pageState.token += 1;
        revokePageUrl(pageNumber);
        pageState.failedRenderPx = 0;
        pageState.status = 'idle';
        pageState.renderedPx = 0;
    }

    function resetRenderQueueState() {
        lastRenderedPageSet = new Set<number>();
        activeRenderPageNumbers.clear();
        queuedPageNumbers = [];
    }

    function cleanupViewerState() {
        clearScrollSettlePreviewTimer();
        for (let pageNumber = 1; pageNumber <= state.pageStates.value.length; pageNumber += 1) {
            revokePageUrl(pageNumber);
        }
        state.pageStates.value = [];
        state.pageSizes.value = [];
        effects.clearPageElements();
        resetRenderQueueState();
        effects.resetScrollState();
        isScrollingPreviewMode.value = false;
        effects.invalidateContinuousScrollWindowCache();
        state.currentPage.value = 1;
        state.viewerError.value = null;
        effects.emitDocument(null);
        effects.emitTotalPages(0);
        effects.emitCurrentPage(1);
    }

    function releaseRenderedPagePreviews() {
        activeRenderPageNumbers.clear();
        clearZoomSettleRerenderTimer();
        clearScrollSettlePreviewTimer();
        isScrollingPreviewMode.value = false;

        for (let pageNumber = 1; pageNumber <= state.pageStates.value.length; pageNumber += 1) {
            const pageState = state.pageStates.value[pageNumber - 1];
            if (!pageState) {
                continue;
            }

            pageState.token += 1;
            revokePageUrl(pageNumber);
            pageState.status = 'idle';
        }

        queuedPageNumbers = [];
        lastRenderedPageSet = new Set<number>();
    }

    function stopWorker() {
        clearZoomSettleRerenderTimer();
        clearScrollSettlePreviewTimer();
        isScrollingPreviewMode.value = false;
        if (!activeWorker) {
            return;
        }

        for (let pageNumber = 1; pageNumber <= state.pageStates.value.length; pageNumber += 1) {
            revokePageUrl(pageNumber);
        }

        activeWorker.terminate();
        activeWorker = null;
        resetRenderQueueState();
        effects.invalidateContinuousScrollWindowCache();
    }

    function suspendWorker() {
        releaseRenderedPagePreviews();
        clearScrollSettlePreviewTimer();
        isScrollingPreviewMode.value = false;
        if (!activeWorker) {
            return;
        }

        activeWorker.terminate();
        activeWorker = null;
        resetRenderQueueState();
        effects.invalidateContinuousScrollWindowCache();
    }

    function isPagePreviewUndersized(pageNumber: number, pageState: IDjvuPageState | undefined) {
        const targetPx = getPreviewResolutionPlan(pageNumber).targetPx;

        return Boolean(
            pageState
            && pageState.status === 'loaded'
            && pageState.objectUrl
            && pageState.renderedPx > 0
            && targetPx > pageState.renderedPx
            && targetPx > pageState.failedRenderPx,
        );
    }

    function canLoadPagePreview(pageNumber: number, pageState: IDjvuPageState | undefined): pageState is IDjvuPageState {
        return Boolean(
            pageState
            && pageState.status !== 'loading'
            && (pageState.status !== 'loaded' || isPagePreviewUndersized(pageNumber, pageState)),
        );
    }

    function shouldQueuePagePreview(pageNumber: number, pageState: IDjvuPageState | undefined) {
        return Boolean(
            pageState
            && (
                pageState.status === 'idle'
                || isPagePreviewUndersized(pageNumber, pageState)
            ),
        );
    }

    function discardStalePageObjectUrl(
        worker: TDjvuPagePreviewSource,
        url: string,
    ) {
        worker.revokeObjectURL(url);
    }

    function discardStaleWorker(worker: TDjvuPagePreviewSource) {
        if (worker === activeWorker) {
            activeWorker = null;
        }
        worker.terminate();
    }

    function hasVisiblePagePreview() {
        return state.pageStates.value.some(pageState => Boolean(pageState.objectUrl));
    }

    function getPreferredRenderedPageNumbers() {
        if (source.totalPages.value <= 0) {
            return [] as number[];
        }

        if (source.isContinuousScroll.value) {
            const scrollWindow = source.resolveContinuousScrollWindow();
            if (!scrollWindow) {
                return [] as number[];
            }

            return createDjvuPageRenderList({
                anchorPage: scrollWindow.mostVisiblePage ?? state.currentPage.value,
                direction: source.scrollDirection.value,
                endPage: scrollWindow.end,
                prefetchPages: DJVU_CONTINUOUS_PREFETCH_PAGES,
                startPage: scrollWindow.start,
                totalPages: source.totalPages.value,
            });
        }

        return createDjvuPageRenderList({
            anchorPage: state.currentPage.value,
            direction: 0,
            endPage: state.currentPage.value,
            prefetchPages: DJVU_PAGE_FLIP_PREFETCH_PAGES,
            startPage: state.currentPage.value,
            totalPages: source.totalPages.value,
        });
    }

    function finishInitialPreviewLoadIfSettled() {
        if (!source.isActive.value) {
            return;
        }
        if (!state.isLoading.value) {
            return;
        }

        if (hasVisiblePagePreview()) {
            emitLoading(false);
            return;
        }

        const desiredPageNumbers = getPreferredRenderedPageNumbers();
        if (desiredPageNumbers.length === 0) {
            return;
        }

        const desiredPagesSettled = desiredPageNumbers.every((pageNumber) => {
            const pageState = state.pageStates.value[pageNumber - 1];
            return pageState?.status === 'loaded' || pageState?.status === 'error';
        });
        if (desiredPagesSettled) {
            emitLoading(false);
        }
    }

    function commitLoadedPagePreview(
        pageNumber: number,
        token: number,
        generation: number,
        worker: TDjvuPagePreviewSource,
        objectUrl: string,
        renderedPx: number,
    ) {
        const currentState = state.pageStates.value[pageNumber - 1];
        if (
            !source.isActive.value
            || !isCurrentLoadGeneration(generation)
            || !currentState
            || currentState.token !== token
            || worker !== activeWorker
        ) {
            discardStalePageObjectUrl(worker, objectUrl);
            return false;
        }

        const previousObjectUrl = currentState.objectUrl;
        currentState.objectUrl = objectUrl;
        currentState.failedRenderPx = 0;
        currentState.renderedPx = renderedPx;
        currentState.status = 'loaded';
        if (previousObjectUrl && previousObjectUrl !== objectUrl) {
            try {
                worker.revokeObjectURL(previousObjectUrl);
            } catch (error) {
                BrowserLogger.warn('djvu-viewer', 'Failed to revoke previous DjVu page URL', {
                    pageNumber,
                    error,
                });
            }
        }
        finishInitialPreviewLoadIfSettled();
        return true;
    }

    function markPagePreviewLoadFailed(
        pageNumber: number,
        token: number,
        generation: number,
        worker: TDjvuPagePreviewSource,
        error: unknown,
    ) {
        const currentState = state.pageStates.value[pageNumber - 1];
        if (
            !source.isActive.value
            || !isCurrentLoadGeneration(generation)
            || !currentState
            || currentState.token !== token
            || worker !== activeWorker
        ) {
            return;
        }

        if (currentState.objectUrl) {
            currentState.failedRenderPx = Math.max(currentState.failedRenderPx, getPreviewResolutionPlan(pageNumber).targetPx);
            currentState.status = 'loaded';
            finishInitialPreviewLoadIfSettled();
            BrowserLogger.warn('djvu-viewer', 'Failed to refresh DjVu page preview', {
                pageNumber,
                error,
            });
        } else {
            currentState.status = 'error';
            finishInitialPreviewLoadIfSettled();
            BrowserLogger.warn('djvu-viewer', 'Failed to load DjVu page preview', {
                pageNumber,
                error,
            });
        }
    }

    function preloadPageObjectUrl(objectUrl: string) {
        if (typeof Image === 'undefined') {
            return Promise.resolve();
        }

        return new Promise<void>((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve();
            image.onerror = () => reject(new Error('Failed to decode DjVu page preview'));
            image.src = objectUrl;
        });
    }

    async function ensurePageLoaded(pageNumber: number) {
        const pageState = state.pageStates.value[pageNumber - 1];
        const worker = activeWorker;
        const generation = loadGeneration;
        if (!source.isActive.value || !worker || !canLoadPagePreview(pageNumber, pageState)) {
            return;
        }

        pageState.status = 'loading';
        pageState.token += 1;
        const token = pageState.token;
        const previewPlan = getPreviewResolutionPlan(pageNumber);

        try {
            const {
                objectUrl,
                renderedPx,
            } = await worker.renderPageObjectUrl(pageNumber, { subsample: previewPlan.subsample });
            await preloadPageObjectUrl(objectUrl);
            commitLoadedPagePreview(pageNumber, token, generation, worker, objectUrl, renderedPx);
        } catch (error) {
            markPagePreviewLoadFailed(pageNumber, token, generation, worker, error);
        }
    }

    function queueDesiredPages(pageNumbers: number[]) {
        queuedPageNumbers = pageNumbers.filter((pageNumber, index, list) => (
            pageNumber >= 1
            && pageNumber <= source.totalPages.value
            && list.indexOf(pageNumber) === index
        ));
    }

    function countActiveQueuedRenderPages() {
        const queuedPages = new Set(queuedPageNumbers);
        let count = 0;

        for (const pageNumber of activeRenderPageNumbers) {
            if (queuedPages.has(pageNumber)) {
                count += 1;
            }
        }

        return count;
    }

    function processRenderQueue() {
        if (!source.isActive.value || !activeWorker) {
            return;
        }

        let launchedRender = false;
        let activeQueuedRenderCount = countActiveQueuedRenderPages();

        while (
            activeRenderPageNumbers.size < DJVU_RENDER_QUEUE_MAX_CONCURRENCY
            && activeQueuedRenderCount < DJVU_RENDER_QUEUE_TARGET_CONCURRENCY
        ) {
            const nextPageNumber = queuedPageNumbers.find((pageNumber) => {
                const pageState = state.pageStates.value[pageNumber - 1];
                return !activeRenderPageNumbers.has(pageNumber) && shouldQueuePagePreview(pageNumber, pageState);
            });

            if (!nextPageNumber) {
                break;
            }

            activeRenderPageNumbers.add(nextPageNumber);
            activeQueuedRenderCount += 1;
            launchedRender = true;
            void ensurePageLoaded(nextPageNumber)
                .finally(() => {
                    const wasTracked = activeRenderPageNumbers.delete(nextPageNumber);
                    if (wasTracked) {
                        processRenderQueue();
                    }
                });
        }

        if (!launchedRender && activeRenderPageNumbers.size === 0) {
            finishInitialPreviewLoadIfSettled();
        }
    }

    function syncLoadedPages() {
        if (!source.isActive.value || !activeWorker || source.totalPages.value <= 0) {
            return;
        }

        const desiredPageNumbers = getPreferredRenderedPageNumbers();
        const activePages = new Set(desiredPageNumbers);
        queueDesiredPages(desiredPageNumbers);

        for (const pageNumber of lastRenderedPageSet) {
            if (activePages.has(pageNumber)) {
                continue;
            }

            const pageState = state.pageStates.value[pageNumber - 1];
            if (pageState && pageState.status !== 'idle') {
                resetPageState(pageNumber);
            }
        }

        lastRenderedPageSet = activePages;
        void processRenderQueue();
    }

    function scheduleSettledPreviewRerender() {
        const timerWindow = getTimerWindow();
        if (!isClientRuntime() || !source.isActive.value || source.totalPages.value <= 0 || !timerWindow) {
            return;
        }

        clearZoomSettleRerenderTimer();
        zoomSettleRerenderTimer = timerWindow.setTimeout(() => {
            zoomSettleRerenderTimer = null;
            syncLoadedPages();
        }, DJVU_ZOOM_SETTLE_RERENDER_MS);
    }

    function scheduleScrollSettledPreviewRerender() {
        const timerWindow = getTimerWindow();
        if (
            !isClientRuntime()
            || !source.isActive.value
            || source.totalPages.value <= 0
            || !source.isContinuousScroll.value
            || !timerWindow
        ) {
            return;
        }

        isScrollingPreviewMode.value = true;
        clearScrollSettlePreviewTimer();
        scrollSettlePreviewTimer = timerWindow.setTimeout(() => {
            scrollSettlePreviewTimer = null;
            isScrollingPreviewMode.value = false;
            syncLoadedPages();
        }, DJVU_SCROLL_SETTLE_PREVIEW_RERENDER_MS);
    }

    function retryPage(pageNumber: number) {
        if (!source.isActive.value) {
            return;
        }
        resetPageState(pageNumber);
        void ensurePageLoaded(pageNumber);
    }

    async function loadSource(src: TDocumentRef, generation: number) {
        const worker = await createDjvuPagePreviewSourceFromPath(src);
        if (!isCurrentLoadGeneration(generation)) {
            discardStaleWorker(worker);
            return;
        }

        activeWorker = worker;
        const sizes = await worker.getPageSizes();
        if (!isCurrentLoadGeneration(generation) || worker !== activeWorker) {
            if (worker === activeWorker && state.pageSizes.value.length === 0) {
                discardStaleWorker(worker);
            }
            return;
        }

        state.pageSizes.value = sizes;
        state.pageStates.value = sizes.map(createIdlePageState);
    }

    watch(
        () => source.getSrc(),
        async (src) => {
            loadGeneration += 1;
            const generation = loadGeneration;

            stopWorker();
            cleanupViewerState();

            if (!src || !isClientRuntime()) {
                emitLoading(false);
                return;
            }

            if (!source.isActive.value) {
                emitLoading(false);
                return;
            }

            emitLoading(true, { force: true });

            try {
                await loadSource(src, generation);
                if (!isCurrentLoadGeneration(generation) || !activeWorker) {
                    return;
                }

                effects.invalidateContinuousScrollWindowCache();
                state.currentPage.value = 1;
                state.viewerError.value = null;
                effects.emitDocument(null);
                effects.emitTotalPages(state.pageSizes.value.length);
                effects.emitCurrentPage(1);
                if (state.pageSizes.value.length === 0) {
                    emitLoading(false);
                    return;
                }

                await nextTick();
                effects.measureContainer();
                effects.resetViewerScrollPosition();
                effects.syncHorizontalScrollForZoomMode();
                lastRenderedPageSet = new Set<number>();
                syncLoadedPages();
            } catch (error) {
                if (!isCurrentLoadGeneration(generation)) {
                    return;
                }

                state.viewerError.value = error instanceof Error ? error.message : source.getOpenErrorMessage();
                BrowserLogger.error('djvu-viewer', 'Failed to initialize native DjVu viewer', {
                    src,
                    error,
                });
                emitLoading(false);
            } finally {
                if (isCurrentLoadGeneration(generation)) {
                    finishInitialPreviewLoadIfSettled();
                }
            }
        },
        { immediate: true },
    );

    watch(
        () => source.isActive.value,
        async (active) => {
            if (!active) {
                loadGeneration += 1;
                suspendWorker();
                return;
            }

            const src = source.getSrc();
            if (src && isClientRuntime() && !activeWorker) {
                loadGeneration += 1;
                const generation = loadGeneration;
                emitLoading(true, { force: true });

                try {
                    await loadSource(src, generation);
                    if (!isCurrentLoadGeneration(generation) || !activeWorker) {
                        return;
                    }

                    effects.invalidateContinuousScrollWindowCache();
                    effects.emitTotalPages(state.pageSizes.value.length);
                    state.viewerError.value = null;
                    await nextTick();
                    effects.measureContainer();
                    syncLoadedPages();
                } catch (error) {
                    if (!isCurrentLoadGeneration(generation)) {
                        return;
                    }

                    state.viewerError.value = error instanceof Error ? error.message : source.getOpenErrorMessage();
                    BrowserLogger.error('djvu-viewer', 'Failed to resume native DjVu viewer', {
                        src,
                        error,
                    });
                    emitLoading(false);
                }
                return;
            }

            await nextTick();
            effects.measureContainer();
            syncLoadedPages();
            effects.scheduleViewportSync();
        },
    );

    function dispose() {
        clearZoomSettleRerenderTimer();
        stopWorker();
    }

    return {
        dispose,
        isScrollingPreviewMode,
        resetPageState,
        retryPage,
        scheduleScrollSettledPreviewRerender,
        scheduleSettledPreviewRerender,
        syncLoadedPages,
    };
};
