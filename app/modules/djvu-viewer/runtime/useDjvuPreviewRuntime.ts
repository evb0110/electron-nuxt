import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import { createDjvuPagePreviewSourceFromPath } from '@app/platform/browser-api/public';
import { BrowserLogger } from '@app/utils/browserLogger';
import { resolveDjvuPreviewResolutionPlan } from '@app/utils/djvuPreviewResolution';
import type {
    IDocumentPreviewPageState,
    IPagePreviewSource,
    IPreviewPageSize,
} from '@app/utils/document-viewer/pagePreviewSource';
import {
    createDjvuPageRenderList,
    type TDjvuScrollDirection,
} from '@app/modules/djvu-viewer/createDjvuPageRenderList';
import type { IDjvuContinuousScrollWindow } from '@app/modules/djvu-viewer/resolveDjvuContinuousScrollWindow';

export type IDjvuPageState = IDocumentPreviewPageState;


interface IDjvuPreviewRuntimeState {
    currentPage: Ref<number>;
    isLoading: Ref<boolean>;
    pageSizes: Ref<IPreviewPageSize[]>;
    pageStates: Ref<IDjvuPageState[]>;
    viewerError: Ref<string | null>;
}

interface IDjvuPreviewRuntimeSource {
    getInitialVisualPageNumbers?: (() => number[]) | undefined;
    getNeededDeviceWidth: (pageNumber: number) => number;
    getOpenErrorMessage: () => string;
    getSrc: () => TDocumentRef | null;
    isActive: ComputedRef<boolean>;
    isContinuousScroll: ComputedRef<boolean>;
    resolveContinuousScrollWindow: () => IDjvuContinuousScrollWindow | null;
    scrollDirection: Ref<TDjvuScrollDirection>;
    totalPages: ComputedRef<number>;
}

interface IPagePreviewRenderPlan {
    subsample: number;
    targetPx: number;
}

type TCreatePagePreviewSourceFromPath = (src: TDocumentRef) => Promise<IPagePreviewSource>;

interface IDjvuPreviewRuntimeEffects {
    clearPageElements: () => void;
    emitCurrentPage: (pageNumber: number) => void;
    emitDocument: (value: null) => void;
    emitInitialVisualPending: () => void;
    emitInitialVisualReady: (payload: {pageNumber: number;}) => void;
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
    createPagePreviewSourceFromPath?: TCreatePagePreviewSourceFromPath;
    documentLabel?: string;
    effects: IDjvuPreviewRuntimeEffects;
    environment?: IDjvuPreviewRuntimeEnvironment;
    getPagePreviewRenderOptions?: (
        pageNumber: number,
        plan: IPagePreviewRenderPlan,
    ) => unknown;
    logScope?: string;
    source: IDjvuPreviewRuntimeSource;
    state: IDjvuPreviewRuntimeState;
}

const DJVU_ZOOM_SETTLE_RERENDER_MS = 200;
const DJVU_SCROLL_SETTLE_PREVIEW_RERENDER_MS = 180;
const DJVU_CONTINUOUS_PREFETCH_AHEAD_PAGES = 8;
const DJVU_CONTINUOUS_PREFETCH_BEHIND_PAGES = 3;
const DJVU_CONTINUOUS_SCROLLING_PREFETCH_AHEAD_PAGES = 2;
const DJVU_CONTINUOUS_SCROLLING_PREFETCH_BEHIND_PAGES = 1;
const DJVU_CONTINUOUS_RETAINED_PAGE_EPOCHS = 3;
const DJVU_CONTINUOUS_RETAINED_PAGE_LIMIT = 24;
const DJVU_CONTINUOUS_RETAINED_PIXEL_LIMIT = 24_000_000;
const DJVU_CONTINUOUS_PREVIEW_MAX_TARGET_PX = 1_024;
const DJVU_PAGE_FLIP_PREFETCH_PAGES = 2;
const DJVU_SCROLLING_PREVIEW_HEADROOM = 1;
const DJVU_SCROLLING_PREVIEW_MAX_TARGET_PX = 768;
const DJVU_RENDER_QUEUE_TARGET_CONCURRENCY = 2;
const DJVU_RENDER_QUEUE_MAX_CONCURRENCY = 4;
const DJVU_SCROLLING_RENDER_QUEUE_TARGET_CONCURRENCY = 1;
const DJVU_SCROLLING_RENDER_QUEUE_MAX_CONCURRENCY = 2;

export const useDjvuPreviewRuntime = (options: IUseDjvuPreviewRuntimeOptions) => {
    const {
        effects,
        source,
        state,
    } = options;
    const createPagePreviewSource = options.createPagePreviewSourceFromPath ?? createDjvuPagePreviewSourceFromPath;
    const documentLabel = options.documentLabel ?? 'DjVu';
    const logScope = options.logScope ?? 'djvu-viewer';

    const isScrollingPreviewMode = ref(false);

    let activeWorker: IPagePreviewSource | null = null;
    let loadGeneration = 0;
    let pendingInitialVisualGeneration: number | null = null;
    let readyInitialVisualGeneration: number | null = null;
    let initialVisualSettlePromise: Promise<void> | null = null;
    let resolveInitialVisualSettlePromise: (() => void) | null = null;
    let queuedPageNumbers: number[] = [];
    let queuedPagePriorities = new Map<number, number>();
    let lastRenderedPageSet = new Set<number>();
    let retainedPageEpochs = new Map<number, number>();
    let retainedPageEpoch = 0;
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

    function resolveInitialVisualSettle() {
        resolveInitialVisualSettlePromise?.();
        initialVisualSettlePromise = null;
        resolveInitialVisualSettlePromise = null;
    }

    function ensureInitialVisualSettlePromise() {
        initialVisualSettlePromise ??= new Promise<void>((resolve) => {
            resolveInitialVisualSettlePromise = resolve;
        });

        return initialVisualSettlePromise;
    }

    function beginInitialVisualWait(generation: number) {
        resolveInitialVisualSettle();
        pendingInitialVisualGeneration = generation;
        readyInitialVisualGeneration = null;
        effects.emitInitialVisualPending();
    }

    function markInitialVisualReady(generation: number, pageNumber: number) {
        if (
            !isCurrentLoadGeneration(generation)
            || pendingInitialVisualGeneration !== generation
            || readyInitialVisualGeneration === generation
        ) {
            return;
        }

        pendingInitialVisualGeneration = null;
        readyInitialVisualGeneration = generation;
        effects.emitInitialVisualReady({ pageNumber });
        resolveInitialVisualSettle();
    }

    function waitForViewerLoadSettled() {
        if (
            !source.isActive.value
            || !state.isLoading.value
            || state.viewerError.value
            || readyInitialVisualGeneration === loadGeneration
        ) {
            return Promise.resolve();
        }

        return ensureInitialVisualSettlePromise();
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
        const neededDevicePx = source.getNeededDeviceWidth(pageNumber);
        const maxTargetPx = isScrollingPreviewMode.value
            ? DJVU_SCROLLING_PREVIEW_MAX_TARGET_PX
            : source.isContinuousScroll.value
                ? DJVU_CONTINUOUS_PREVIEW_MAX_TARGET_PX
                : undefined;

        return resolveDjvuPreviewResolutionPlan({
            ...(isScrollingPreviewMode.value ? { headroom: DJVU_SCROLLING_PREVIEW_HEADROOM } : {}),
            ...(maxTargetPx === undefined ? {} : { maxTargetPx }),
            nativeWidth: pageSize?.width ?? 1,
            neededDevicePx,
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
            BrowserLogger.warn(logScope, `Failed to revoke ${documentLabel} page URL`, {
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
        retainedPageEpochs = new Map<number, number>();
        retainedPageEpoch = 0;
        activeRenderPageNumbers.clear();
        queuedPageNumbers = [];
        queuedPagePriorities = new Map();
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
        queuedPagePriorities = new Map();
        lastRenderedPageSet = new Set<number>();
    }

    function stopWorker() {
        resolveInitialVisualSettle();
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
        resolveInitialVisualSettle();
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
        worker: IPagePreviewSource,
        url: string,
    ) {
        worker.revokeObjectURL(url);
    }

    function discardStaleWorker(worker: IPagePreviewSource) {
        if (worker === activeWorker) {
            activeWorker = null;
        }
        worker.terminate();
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
            const directionalPrefetchPages = isScrollingPreviewMode.value
                ? DJVU_CONTINUOUS_SCROLLING_PREFETCH_AHEAD_PAGES
                : DJVU_CONTINUOUS_PREFETCH_AHEAD_PAGES;
            const prefetchPages = isScrollingPreviewMode.value
                ? DJVU_CONTINUOUS_SCROLLING_PREFETCH_BEHIND_PAGES
                : DJVU_CONTINUOUS_PREFETCH_BEHIND_PAGES;

            return createDjvuPageRenderList({
                anchorPage: scrollWindow.mostVisiblePage ?? state.currentPage.value,
                directionalPrefetchPages,
                direction: source.scrollDirection.value,
                endPage: scrollWindow.end,
                prefetchPages,
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

    function getInitialVisualPageNumbers() {
        const pageNumbers = source.getInitialVisualPageNumbers?.() ?? getPreferredRenderedPageNumbers();
        return pageNumbers.filter((pageNumber, index, list) => (
            pageNumber >= 1
            && pageNumber <= source.totalPages.value
            && list.indexOf(pageNumber) === index
        ));
    }

    function finishInitialPreviewLoadIfSettled() {
        if (!source.isActive.value) {
            return;
        }
        if (!state.isLoading.value) {
            return;
        }

        const initialPageNumbers = getInitialVisualPageNumbers();
        if (initialPageNumbers.length === 0) {
            return;
        }

        const loadedPageNumber = initialPageNumbers.find((pageNumber) => {
            const pageState = state.pageStates.value[pageNumber - 1];
            return Boolean(pageState?.objectUrl);
        });
        if (loadedPageNumber !== undefined) {
            markInitialVisualReady(loadGeneration, loadedPageNumber);
            emitLoading(false);
            return;
        }

        const initialPagesSettled = initialPageNumbers.every((pageNumber) => {
            const pageState = state.pageStates.value[pageNumber - 1];
            return pageState?.status === 'error';
        });
        if (initialPagesSettled) {
            markInitialVisualReady(loadGeneration, initialPageNumbers[0] ?? state.currentPage.value);
            emitLoading(false);
        }
    }

    function getCurrentPagePreviewLoadState(
        pageNumber: number,
        token: number,
        generation: number,
        worker: IPagePreviewSource,
    ) {
        const currentState = state.pageStates.value[pageNumber - 1];
        if (
            !source.isActive.value
            || !isCurrentLoadGeneration(generation)
            || !currentState
            || currentState.token !== token
            || worker !== activeWorker
        ) {
            return null;
        }

        return currentState;
    }

    function shouldDeferPagePreviewDecodeDuringScroll(
        pageNumber: number,
        pageState: IDjvuPageState,
        renderedPx: number,
    ) {
        if (
            !isScrollingPreviewMode.value
            || !source.isContinuousScroll.value
            || !pageState.objectUrl
            || pageState.renderedPx <= 0
        ) {
            return false;
        }

        return renderedPx > getPreviewResolutionPlan(pageNumber).targetPx;
    }

    function commitLoadedPagePreview(
        pageNumber: number,
        token: number,
        generation: number,
        worker: IPagePreviewSource,
        objectUrl: string,
        renderedPx: number,
    ) {
        const currentState = getCurrentPagePreviewLoadState(pageNumber, token, generation, worker);
        if (!currentState) {
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
                BrowserLogger.warn(logScope, `Failed to revoke previous ${documentLabel} page URL`, {
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
        worker: IPagePreviewSource,
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
            BrowserLogger.warn(logScope, `Failed to refresh ${documentLabel} page preview`, {
                pageNumber,
                error,
            });
        } else {
            currentState.status = 'error';
            finishInitialPreviewLoadIfSettled();
            BrowserLogger.warn(logScope, `Failed to load ${documentLabel} page preview`, {
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
            image.onerror = () => reject(new Error(`Failed to decode ${documentLabel} page preview`));
            image.src = objectUrl;
        });
    }

    function withPreviewRequestMetadata(
        renderOptions: unknown,
        metadata: {
            previewPriority: number;
            previewRequestId: string;
        },
    ) {
        if (renderOptions && typeof renderOptions === 'object' && !Array.isArray(renderOptions)) {
            return {
                ...renderOptions,
                previewPriority: metadata.previewPriority,
                previewRequestId: metadata.previewRequestId,
            };
        }

        return metadata;
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
        const previewRequestId = `${generation}:${pageNumber}:${token}`;
        const previewPriority = queuedPagePriorities.get(pageNumber) ?? 0;
        const previewPlan = getPreviewResolutionPlan(pageNumber);

        try {
            const renderOptions = options.getPagePreviewRenderOptions
                ? options.getPagePreviewRenderOptions(pageNumber, previewPlan)
                : { subsample: previewPlan.subsample };
            const {
                objectUrl,
                renderedPx,
            } = await worker.renderPageObjectUrl(pageNumber, withPreviewRequestMetadata(renderOptions, {
                previewPriority,
                previewRequestId,
            }));
            const currentState = getCurrentPagePreviewLoadState(pageNumber, token, generation, worker);
            if (!currentState) {
                discardStalePageObjectUrl(worker, objectUrl);
                return;
            }
            if (shouldDeferPagePreviewDecodeDuringScroll(pageNumber, currentState, renderedPx)) {
                discardStalePageObjectUrl(worker, objectUrl);
                currentState.status = 'loaded';
                finishInitialPreviewLoadIfSettled();
                return;
            }
            if (!isScrollingPreviewMode.value) {
                await preloadPageObjectUrl(objectUrl);
            }
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
        queuedPagePriorities = new Map(
            queuedPageNumbers.map((pageNumber, index) => [
                pageNumber,
                queuedPageNumbers.length - index,
            ]),
        );
    }

    function estimatePagePreviewPixelCost(pageNumber: number) {
        const pageSize = state.pageSizes.value[pageNumber - 1];
        if (!pageSize?.width || !pageSize.height) {
            return 1;
        }

        const pageState = state.pageStates.value[pageNumber - 1];
        const pageRenderedPx = pageState?.renderedPx ?? 0;
        const renderedWidth = Math.max(
            1,
            pageRenderedPx > 0 ? pageRenderedPx : getPreviewResolutionPlan(pageNumber).targetPx,
        );
        const renderedHeight = Math.max(1, Math.round(renderedWidth * pageSize.height / pageSize.width));

        return renderedWidth * renderedHeight;
    }

    function sumEstimatedPreviewPixelCost(pageNumbers: Iterable<number>) {
        let total = 0;
        for (const pageNumber of pageNumbers) {
            total += estimatePagePreviewPixelCost(pageNumber);
        }
        return total;
    }

    function createActiveContinuousRenderPageSet(desiredPageNumbers: number[]) {
        retainedPageEpoch += 1;
        const desiredPages = new Set(desiredPageNumbers);
        for (const pageNumber of desiredPages) {
            retainedPageEpochs.set(pageNumber, retainedPageEpoch);
        }

        const activePages = new Set(desiredPages);
        let retainedPixelCost = sumEstimatedPreviewPixelCost(activePages);
        const retainedEntries = Array.from(retainedPageEpochs.entries())
            .filter(([pageNumber]) => pageNumber >= 1 && pageNumber <= source.totalPages.value)
            .sort((left, right) => right[1] - left[1]);
        const nextRetainedPageEpochs = new Map<number, number>();

        for (const [
            pageNumber,
            pageEpoch,
        ] of retainedEntries) {
            const isDesired = desiredPages.has(pageNumber);
            const isRecent = retainedPageEpoch - pageEpoch <= DJVU_CONTINUOUS_RETAINED_PAGE_EPOCHS;
            if (!isDesired && (!isRecent || activePages.size >= DJVU_CONTINUOUS_RETAINED_PAGE_LIMIT)) {
                continue;
            }
            const pagePixelCost = estimatePagePreviewPixelCost(pageNumber);
            if (
                !isDesired
                && retainedPixelCost + pagePixelCost > DJVU_CONTINUOUS_RETAINED_PIXEL_LIMIT
            ) {
                continue;
            }

            activePages.add(pageNumber);
            if (!isDesired) {
                retainedPixelCost += pagePixelCost;
            }
            nextRetainedPageEpochs.set(pageNumber, pageEpoch);
        }

        retainedPageEpochs = nextRetainedPageEpochs;
        return activePages;
    }

    function createActiveRenderPageSet(desiredPageNumbers: number[]) {
        if (!source.isContinuousScroll.value) {
            retainedPageEpochs = new Map<number, number>();
            retainedPageEpoch = 0;
            return new Set(desiredPageNumbers);
        }

        return createActiveContinuousRenderPageSet(desiredPageNumbers);
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

    function getRenderQueueTargetConcurrency() {
        return isScrollingPreviewMode.value
            ? DJVU_SCROLLING_RENDER_QUEUE_TARGET_CONCURRENCY
            : DJVU_RENDER_QUEUE_TARGET_CONCURRENCY;
    }

    function getRenderQueueMaxConcurrency() {
        return isScrollingPreviewMode.value
            ? DJVU_SCROLLING_RENDER_QUEUE_MAX_CONCURRENCY
            : DJVU_RENDER_QUEUE_MAX_CONCURRENCY;
    }

    function processRenderQueue() {
        if (!source.isActive.value || !activeWorker) {
            return;
        }

        let launchedRender = false;
        let activeQueuedRenderCount = countActiveQueuedRenderPages();
        const targetConcurrency = getRenderQueueTargetConcurrency();
        const maxConcurrency = getRenderQueueMaxConcurrency();

        while (
            activeRenderPageNumbers.size < maxConcurrency
            && activeQueuedRenderCount < targetConcurrency
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
        const activePages = createActiveRenderPageSet(desiredPageNumbers);
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
        const worker = await createPagePreviewSource(src);
        if (!isCurrentLoadGeneration(generation)) {
            discardStaleWorker(worker);
            return;
        }

        let sizes: IPreviewPageSize[];
        try {
            sizes = await worker.getPageSizes();
        } catch (error) {
            discardStaleWorker(worker);
            throw error;
        }
        if (!isCurrentLoadGeneration(generation)) {
            discardStaleWorker(worker);
            return;
        }

        activeWorker = worker;
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

            beginInitialVisualWait(generation);
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
                    markInitialVisualReady(generation, 1);
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
                BrowserLogger.error(logScope, `Failed to initialize native ${documentLabel} viewer`, {
                    src,
                    error,
                });
                markInitialVisualReady(generation, state.currentPage.value);
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
                beginInitialVisualWait(generation);
                emitLoading(true, { force: true });

                try {
                    await loadSource(src, generation);
                    if (!isCurrentLoadGeneration(generation) || !activeWorker) {
                        return;
                    }

                    effects.invalidateContinuousScrollWindowCache();
                    effects.emitTotalPages(state.pageSizes.value.length);
                    state.viewerError.value = null;
                    if (state.pageSizes.value.length === 0) {
                        markInitialVisualReady(generation, 1);
                        emitLoading(false);
                        return;
                    }
                    await nextTick();
                    effects.measureContainer();
                    syncLoadedPages();
                } catch (error) {
                    if (!isCurrentLoadGeneration(generation)) {
                        return;
                    }

                    state.viewerError.value = error instanceof Error ? error.message : source.getOpenErrorMessage();
                    BrowserLogger.error(logScope, `Failed to resume native ${documentLabel} viewer`, {
                        src,
                        error,
                    });
                    markInitialVisualReady(generation, state.currentPage.value);
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
        waitForViewerLoadSettled,
    };
};
