<template>
    <div
        class="relative h-full w-full"
    >
        <div
            v-if="viewerError"
            class="absolute inset-0 flex items-center justify-center bg-muted/30"
        >
            <div class="flex max-w-md flex-col items-center gap-3 px-6 text-center">
                <UIcon
                    name="i-lucide-circle-alert"
                    class="size-8 text-muted"
                />
                <p class="text-sm text-default">
                    {{ viewerError }}
                </p>
            </div>
        </div>

        <div
            v-if="isInitialPreviewPending"
            class="absolute inset-0 z-[1] flex items-center justify-center bg-[var(--ui-bg-muted)]"
            role="status"
            aria-live="polite"
        >
            <div class="flex flex-col items-center gap-2">
                <UIcon
                    name="i-lucide-loader-circle"
                    class="size-5 animate-spin text-[var(--ui-text-muted)]"
                />
                <span class="text-sm text-[var(--ui-text-muted)]">{{ t('common.loading') }}</span>
            </div>
        </div>

        <div
            ref="viewerContainer"
            class="h-full w-full overflow-auto app-scrollbar"
            :class="{
                'cursor-grab': dragMode,
                'cursor-default': !dragMode,
                'djvu-viewer-container--pending': isInitialPreviewPending,
            }"
            @scroll="handleViewerScroll"
            @wheel="handleViewerWheel"
        >
            <div
                class="mx-auto flex min-h-full min-w-full w-fit gap-4 p-4"
                :class="renderedPagesLayoutClass"
            >
                <div
                    v-if="continuousScrollTopSpacerHeight > 0"
                    class="djvu-page-virtual-spacer"
                    :style="{ height: `${continuousScrollTopSpacerHeight}px` }"
                    aria-hidden="true"
                />
                <section
                    v-for="pageNumber in renderedPageNumbers"
                    :key="pageNumber"
                    :ref="(element) => setPageElement(pageNumber, element)"
                    class="djvu-page-shell"
                    :style="getPageShellStyle(pageNumber)"
                    :data-page-number="pageNumber"
                >
                    <img
                        v-if="pageStates[pageNumber - 1]?.objectUrl"
                        :src="pageStates[pageNumber - 1]?.objectUrl ?? undefined"
                        :alt="t('djvu.pageAlt', { page: pageNumber })"
                        class="h-full w-full select-none object-contain"
                        draggable="false"
                    >
                    <div
                        v-else-if="pageStates[pageNumber - 1]?.status === 'error'"
                        class="djvu-page-placeholder"
                    >
                        <UIcon
                            name="i-lucide-circle-alert"
                            class="size-5 text-muted"
                        />
                        <span class="text-sm text-muted">
                            {{ t('errors.djvu.open') }}
                        </span>
                        <UButton
                            size="xs"
                            variant="soft"
                            color="neutral"
                            :label="t('common.retry')"
                            @click="retryPage(pageNumber)"
                        />
                    </div>
                    <div
                        v-else
                        class="djvu-page-placeholder"
                    >
                        <span class="text-sm text-muted">
                            {{ t('common.loading') }}
                        </span>
                    </div>
                    <div class="djvu-page-number">
                        {{ pageNumber }}
                    </div>
                </section>
                <div
                    v-if="continuousScrollBottomSpacerHeight > 0"
                    class="djvu-page-virtual-spacer"
                    :style="{ height: `${continuousScrollBottomSpacerHeight}px` }"
                    aria-hidden="true"
                />
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import type { TDocumentRef } from '@contracts/platform-api';
import type { TPdfViewMode } from '@contracts/shared';
import type {
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { IScrollSnapshot } from '@app/types/pdf';
import type { IDjvuPageSize } from '@app/platform/browser-api/djvujs-loader';
import type { IPdfViewerExpose } from '@app/modules/workspace-shell/composables/workspace-orchestration.types';
import { createDjvuWorkerFromPath } from '@app/platform/browser-api/djvu-worker';
import { BrowserLogger } from '@app/utils/browser-logger';
import { clamp } from 'es-toolkit/math';
import {
    getSpreadStartForPage,
    getViewColumnCount,
    isStandaloneSpreadPage,
    stepBySpread,
} from '@app/utils/pdf-view-mode';
import {
    accumulateWheelForPageFlips,
    createWheelPageAccumulatorState,
    type IWheelPageAccumulatorState,
    normalizePageWheelDelta,
    resolveWheelPageFlipStepDelta,
} from '@app/composables/pdf/usePdfSinglePageScroll';

interface IProps {
    src: TDocumentRef | null;
    zoom?: number;
    zoomMode?: 'custom' | 'fit-width' | 'fit-height';
    fitMode?: 'width' | 'height';
    viewMode?: TPdfViewMode;
    continuousScroll?: boolean;
    dragMode?: boolean;
}

interface IDjvuPageState {
    objectUrl: string | null;
    status: 'idle' | 'loading' | 'loaded' | 'error';
    token: number;
}

const props = defineProps<IProps>();
const emit = defineEmits<{
    (e: 'update:effectiveZoom', value: number): void;
    (e: 'update:currentPage', value: number): void;
    (e: 'update:totalPages', value: number): void;
    (e: 'update:document', value: null): void;
    (e: 'loading', value: boolean): void;
}>();

const { t } = useTypedI18n();
const DJVU_BASE_MARGIN = 16;
const WHEEL_DELTA_EPSILON = 0.01;
const HORIZONTAL_INTENT_REJECT_RATIO = 2.5;
const PAGE_SCROLL_EDGE_EPSILON = 1;

const viewerContainer = ref<HTMLElement | null>(null);
const pageElements = new Map<number, HTMLElement>();
const pageSizes = ref<IDjvuPageSize[]>([]);
const pageStates = ref<IDjvuPageState[]>([]);
const totalPages = computed(() => pageSizes.value.length);
const scrollTop = ref(0);
const currentPage = ref(1);
const viewerError = ref<string | null>(null);
const isLoading = ref(Boolean(props.src));
const hasVisiblePagePreview = computed(() => (
    pageStates.value.some(state => Boolean(state.objectUrl))
));
const isInitialPreviewPending = computed(() => (
    Boolean(props.src)
    && isLoading.value
    && !viewerError.value
    && !hasVisiblePagePreview.value
));
const containerWidth = ref(0);
const containerHeight = ref(0);
const dragMode = computed(() => props.dragMode ?? false);
const isContinuousScroll = computed(() => props.continuousScroll ?? true);
const viewMode = computed<TPdfViewMode>(() => props.viewMode ?? 'single');
const zoomMode = computed(() => props.zoomMode ?? (
    props.fitMode === 'height' ? 'fit-height' : 'fit-width'
));
const renderedPagesLayoutClass = computed(() => (
    isContinuousScroll.value || renderedPageNumbers.value.length <= 1
        ? 'flex-col items-center'
        : 'flex-row items-start justify-center'
));

interface IContinuousScrollWindow {
    start: number;
    end: number;
    mostVisiblePage: number | null;
    pageNumbers: number[];
}

interface IContinuousScrollWindowCacheEntry {
    scrollTop: number;
    containerHeight: number;
    totalPages: number;
    pageSizes: IDjvuPageSize[];
    usesFallback: boolean;
    result: IContinuousScrollWindow;
}

interface IContinuousScrollBoundsState {
    visibleStart: number | null;
    visibleEnd: number | null;
    overscanStart: number | null;
    overscanEnd: number | null;
    mostVisiblePage: number | null;
    maxVisibleHeight: number;
}

let continuousScrollWindowCache: IContinuousScrollWindowCacheEntry | null = null;

function getContinuousScrollViewportHeight() {
    return Math.max(0, containerHeight.value || viewerContainer.value?.clientHeight || 0);
}

function clampPageRangeStart(pageNumber: number) {
    return clamp(pageNumber, 1, totalPages.value);
}

function clampPageRangeEnd(pageNumber: number) {
    return clamp(pageNumber, 1, totalPages.value);
}

function cacheContinuousScrollWindow(
    start: number,
    end: number,
    mostVisiblePage: number | null,
    containerHeightValue: number,
    usesFallback: boolean,
) {
    const result = {
        start,
        end,
        mostVisiblePage,
        pageNumbers: Array.from(
            { length: end - start + 1 },
            (_, index) => start + index,
        ),
    };
    continuousScrollWindowCache = {
        scrollTop: scrollTop.value,
        containerHeight: containerHeightValue,
        totalPages: totalPages.value,
        pageSizes: pageSizes.value,
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
        cached &&
        cached.scrollTop === scrollTop.value &&
        cached.containerHeight === containerHeightValue &&
        cached.totalPages === totalPages.value &&
        cached.usesFallback === usesFallback &&
        cached.pageSizes === pageSizes.value
    ) {
        if (usesFallback && cached.result.mostVisiblePage !== currentPage.value) {
            // Fall through when the anchor page matters.
        } else {
            return cached.result;
        }
    }

    return null;
}

function resolveFallbackContinuousScrollRange(anchorPage: number) {
    return {
        start: Math.max(1, anchorPage - 2),
        end: Math.min(totalPages.value, anchorPage + 2),
    };
}

function expandContinuousScrollRange(
    visibleStart: number | null,
    visibleEnd: number | null,
    overscanStart: number | null,
    overscanEnd: number | null,
    anchorPage: number,
) {
    const baseStart = visibleStart ?? overscanStart ?? anchorPage;
    const baseEnd = visibleEnd ?? overscanEnd ?? anchorPage;
    const minStart = Math.max(1, (visibleStart ?? anchorPage) - 2);
    const minEnd = Math.min(totalPages.value, (visibleEnd ?? anchorPage) + 2);

    return {
        start: clampPageRangeStart(Math.min(baseStart, minStart)),
        end: clampPageRangeEnd(Math.max(baseEnd, minEnd)),
    };
}

function createContinuousScrollBoundsState(anchorPage: number): IContinuousScrollBoundsState {
    return {
        visibleStart: null,
        visibleEnd: null,
        overscanStart: null,
        overscanEnd: null,
        mostVisiblePage: anchorPage,
        maxVisibleHeight: -1,
    };
}

function measureIntersectionHeight(
    top: number,
    bottom: number,
    viewportTop: number,
    viewportBottom: number,
) {
    return Math.max(0, Math.min(bottom, viewportBottom) - Math.max(top, viewportTop));
}

function getContinuousPageHeight(pageNumber: number) {
    const pageSize = pageSizes.value[pageNumber - 1];
    if (!pageSize) {
        return 0;
    }

    const scale = zoomMode.value === 'fit-width' && pageSize.width > 0
        ? Math.max(0.1, fitWidthAvailable() / pageSize.width)
        : effectiveZoom.value;

    return Math.max(1, Math.round(pageSize.height * scale));
}

function getContinuousPagesHeight(startPage: number, endPage: number) {
    if (startPage > endPage || totalPages.value <= 0) {
        return 0;
    }

    const normalizedStart = clamp(startPage, 1, totalPages.value);
    const normalizedEnd = clamp(endPage, 1, totalPages.value);
    let height = 0;
    for (let pageNumber = normalizedStart; pageNumber <= normalizedEnd; pageNumber += 1) {
        height += getContinuousPageHeight(pageNumber);
        if (pageNumber < normalizedEnd) {
            height += DJVU_BASE_MARGIN;
        }
    }
    return height;
}

function applyPageIntersectionToContinuousBounds(
    state: IContinuousScrollBoundsState,
    pageNumber: number,
    visibleHeight: number,
    overscanHeight: number,
) {
    if (overscanHeight > 0) {
        state.overscanStart ??= pageNumber;
        state.overscanEnd = pageNumber;
    }

    if (visibleHeight <= 0) {
        return;
    }

    state.visibleStart ??= pageNumber;
    state.visibleEnd = pageNumber;
    if (visibleHeight > state.maxVisibleHeight) {
        state.maxVisibleHeight = visibleHeight;
        state.mostVisiblePage = pageNumber;
    }
}

function resolveContinuousScrollBounds(
    anchorPage: number,
    viewportTop: number,
    viewportBottom: number,
    overscanTop: number,
    overscanBottom: number,
) {
    const state = createContinuousScrollBoundsState(anchorPage);
    let pageTop = DJVU_BASE_MARGIN;

    for (let pageNumber = 1; pageNumber <= totalPages.value; pageNumber += 1) {
        const pageHeight = getContinuousPageHeight(pageNumber);
        const pageBottom = pageTop + pageHeight;
        const visibleHeight = measureIntersectionHeight(pageTop, pageBottom, viewportTop, viewportBottom);
        const overscanHeight = measureIntersectionHeight(pageTop, pageBottom, overscanTop, overscanBottom);

        applyPageIntersectionToContinuousBounds(
            state,
            pageNumber,
            visibleHeight,
            overscanHeight,
        );

        pageTop = pageBottom + (pageNumber < totalPages.value ? DJVU_BASE_MARGIN : 0);
    }

    return state;
}

function resolveContinuousScrollWindow(): IContinuousScrollWindow | null {
    if (!isContinuousScroll.value || totalPages.value <= 0) {
        return null;
    }

    const containerHeightValue = getContinuousScrollViewportHeight();
    const usesFallback = containerHeightValue <= 0;
    const cached = getCachedContinuousScrollWindow(containerHeightValue, usesFallback);
    if (cached) {
        return cached;
    }

    const anchorPage = clamp(currentPage.value, 1, totalPages.value);
    if (containerHeightValue <= 0) {
        const {
            start,
            end,
        } = resolveFallbackContinuousScrollRange(anchorPage);
        return cacheContinuousScrollWindow(
            start,
            end,
            anchorPage,
            containerHeightValue,
            usesFallback,
        );
    }

    const viewportTop = Math.max(0, scrollTop.value);
    const viewportBottom = viewportTop + containerHeightValue;
    const overscanTop = Math.max(0, viewportTop - containerHeightValue);
    const overscanBottom = viewportBottom + containerHeightValue;
    const bounds = resolveContinuousScrollBounds(
        anchorPage,
        viewportTop,
        viewportBottom,
        overscanTop,
        overscanBottom,
    );

    const {
        start,
        end,
    } = expandContinuousScrollRange(
        bounds.visibleStart,
        bounds.visibleEnd,
        bounds.overscanStart,
        bounds.overscanEnd,
        anchorPage,
    );
    return cacheContinuousScrollWindow(
        start,
        end,
        bounds.mostVisiblePage,
        containerHeightValue,
        usesFallback,
    );
}

function invalidateContinuousScrollWindowCache() {
    continuousScrollWindowCache = null;
}

const renderedPageNumbers = computed(() => {
    if (totalPages.value <= 0) {
        return [] as number[];
    }

    if (isContinuousScroll.value) {
        return resolveContinuousScrollWindow()?.pageNumbers ?? [];
    }

    const spreadStart = getSpreadStartForPage(
        currentPage.value,
        viewMode.value,
        totalPages.value,
    );

    if (viewMode.value === 'single' || totalPages.value === 1) {
        return [spreadStart];
    }

    if (isStandaloneSpreadPage(spreadStart, viewMode.value, totalPages.value)) {
        return [spreadStart];
    }

    const nextPage = spreadStart + 1;
    if (nextPage > totalPages.value) {
        return [spreadStart];
    }

    return [
        spreadStart,
        nextPage,
    ];
});
const continuousScrollTopSpacerHeight = computed(() => {
    if (!isContinuousScroll.value || renderedPageNumbers.value.length === 0) {
        return 0;
    }

    return getContinuousPagesHeight(1, renderedPageNumbers.value[0]! - 1);
});
const continuousScrollBottomSpacerHeight = computed(() => {
    if (!isContinuousScroll.value || renderedPageNumbers.value.length === 0) {
        return 0;
    }

    return getContinuousPagesHeight(
        renderedPageNumbers.value[renderedPageNumbers.value.length - 1]! + 1,
        totalPages.value,
    );
});
const manualZoom = computed(() => {
    const candidate = props.zoom ?? 1;
    if (!Number.isFinite(candidate) || candidate <= 0) {
        return 1;
    }
    return candidate;
});
const currentSpreadWidth = computed(() => {
    const pageNumbers = renderedPageNumbers.value;
    if (pageNumbers.length === 0) {
        return null;
    }
    let total = 0;
    for (const pageNumber of pageNumbers) {
        const w = pageSizes.value[pageNumber - 1]?.width;
        if (w && w > 0) {
            total += w;
        }
    }
    return total > 0 ? total : null;
});

function fitWidthAvailable() {
    // Continuous scroll stacks pages vertically (single column).
    // Page-flip may show multi-column spreads.
    const columns = isContinuousScroll.value
        ? 1
        : getViewColumnCount(viewMode.value, totalPages.value);
    return Math.max(1, containerWidth.value - DJVU_BASE_MARGIN * (columns + 1));
}

function resolveFitHeightZoom() {
    const currentPageSize = pageSizes.value[currentPage.value - 1] ?? pageSizes.value[0] ?? null;
    const baseHeight = currentPageSize?.height;
    if (!baseHeight || baseHeight <= 0) {
        return manualZoom.value;
    }

    const availableHeight = Math.max(1, containerHeight.value - DJVU_BASE_MARGIN * 2);
    return Math.max(0.1, availableHeight / baseHeight);
}

function resolveFitWidthBaseWidth() {
    const baseWidth = isContinuousScroll.value
        ? (pageSizes.value[currentPage.value - 1]?.width ?? null)
        : currentSpreadWidth.value;
    return baseWidth && baseWidth > 0 ? baseWidth : null;
}

function resolveFitWidthZoom() {
    const baseWidth = resolveFitWidthBaseWidth();
    if (baseWidth === null) {
        return manualZoom.value;
    }

    return Math.max(0.1, fitWidthAvailable() / baseWidth);
}

const effectiveZoom = computed(() => {
    if (zoomMode.value === 'custom') {
        return manualZoom.value;
    }

    if (zoomMode.value === 'fit-height') {
        return resolveFitHeightZoom();
    }

    // Fit-width: use current page/spread width for the displayed zoom %.
    // In continuous scroll each page is scaled independently in getPageShellStyle;
    // effectiveZoom reflects the current page for the toolbar display.
    return resolveFitWidthZoom();
});

let activeWorker: Awaited<ReturnType<typeof createDjvuWorkerFromPath>> | null = null;
let resizeObserver: ResizeObserver | null = null;
let scrollRafId = 0;
let loadGeneration = 0;
let activeRenderPromise: Promise<void> | null = null;
let queuedPageNumbers: number[] = [];
let lastRenderedPageSet = new Set<number>();
let wheelAccumulator: IWheelPageAccumulatorState = createWheelPageAccumulatorState();

function emitLoading(nextLoading: boolean, options: { force?: boolean } = {}) {
    if (!options.force && isLoading.value === nextLoading) {
        return;
    }

    isLoading.value = nextLoading;
    emit('loading', nextLoading);
}

function setPageElement(pageNumber: number, element: Element | ComponentPublicInstance | null) {
    if (element instanceof HTMLElement) {
        pageElements.set(pageNumber, element);
        return;
    }

    pageElements.delete(pageNumber);
}

function measureContainer() {
    const element = viewerContainer.value;
    if (!element) {
        return;
    }

    containerWidth.value = Math.max(0, element.clientWidth);
    containerHeight.value = Math.max(0, element.clientHeight);
    invalidateContinuousScrollWindowCache();
}

function getPageShellStyle(pageNumber: number) {
    const pageSize = pageSizes.value[pageNumber - 1];
    if (!pageSize) {
        return {};
    }

    // In continuous scroll + fit-width, each page fills the container
    // width independently so outlier pages don't shrink everything.
    const scale = (isContinuousScroll.value && zoomMode.value === 'fit-width' && pageSize.width > 0)
        ? Math.max(0.1, fitWidthAvailable() / pageSize.width)
        : effectiveZoom.value;

    return {
        width: `${Math.max(1, Math.round(pageSize.width * scale))}px`,
        height: `${Math.max(1, Math.round(pageSize.height * scale))}px`,
    };
}

function revokePageUrl(pageNumber: number) {
    const state = pageStates.value[pageNumber - 1];
    if (!state?.objectUrl || !activeWorker) {
        return;
    }

    try {
        activeWorker.revokeObjectURL(state.objectUrl);
    } catch (error) {
        BrowserLogger.warn('djvu-viewer', 'Failed to revoke DjVu page URL', {
            pageNumber,
            error,
        });
    }

    state.objectUrl = null;
}

function resetPageState(pageNumber: number) {
    const state = pageStates.value[pageNumber - 1];
    if (!state) {
        return;
    }

    state.token += 1;
    revokePageUrl(pageNumber);
    state.status = 'idle';
}

function cleanupViewerState() {
    for (let pageNumber = 1; pageNumber <= pageStates.value.length; pageNumber += 1) {
        revokePageUrl(pageNumber);
    }
    pageStates.value = [];
    pageSizes.value = [];
    pageElements.clear();
    lastRenderedPageSet = new Set<number>();
    queuedPageNumbers = [];
    scrollTop.value = 0;
    invalidateContinuousScrollWindowCache();
    currentPage.value = 1;
    viewerError.value = null;
    emit('update:document', null);
    emit('update:totalPages', 0);
    emit('update:currentPage', 1);
}

function stopWorker() {
    if (!activeWorker) {
        return;
    }

    for (let pageNumber = 1; pageNumber <= pageStates.value.length; pageNumber += 1) {
        revokePageUrl(pageNumber);
    }

    activeWorker.terminate();
    activeWorker = null;
    activeRenderPromise = null;
    queuedPageNumbers = [];
    lastRenderedPageSet = new Set<number>();
    invalidateContinuousScrollWindowCache();
}

function canLoadPagePreview(state: IDjvuPageState | undefined): state is IDjvuPageState {
    return Boolean(state && state.status !== 'loading' && state.status !== 'loaded');
}

function discardStalePageObjectUrl(
    worker: Awaited<ReturnType<typeof createDjvuWorkerFromPath>>,
    url: string,
) {
    worker.revokeObjectURL(url);
}

function commitLoadedPagePreview(
    pageNumber: number,
    token: number,
    worker: Awaited<ReturnType<typeof createDjvuWorkerFromPath>>,
    objectUrl: string,
) {
    const currentState = pageStates.value[pageNumber - 1];
    if (!currentState || currentState.token !== token || worker !== activeWorker) {
        discardStalePageObjectUrl(worker, objectUrl);
        return false;
    }

    revokePageUrl(pageNumber);
    currentState.objectUrl = objectUrl;
    currentState.status = 'loaded';
    finishInitialPreviewLoadIfSettled();
    return true;
}

function markPagePreviewLoadFailed(
    pageNumber: number,
    token: number,
    error: unknown,
) {
    const currentState = pageStates.value[pageNumber - 1];
    if (!currentState || currentState.token !== token) {
        return;
    }

    currentState.status = 'error';
    finishInitialPreviewLoadIfSettled();
    BrowserLogger.warn('djvu-viewer', 'Failed to load DjVu page preview', {
        pageNumber,
        error,
    });
}

function finishInitialPreviewLoadIfSettled() {
    if (!isLoading.value) {
        return;
    }

    if (hasVisiblePagePreview.value) {
        emitLoading(false);
        return;
    }

    const desiredPageNumbers = getPreferredRenderedPageNumbers();
    if (desiredPageNumbers.length === 0) {
        return;
    }

    const desiredPagesSettled = desiredPageNumbers.every((pageNumber) => {
        const state = pageStates.value[pageNumber - 1];
        return state?.status === 'loaded' || state?.status === 'error';
    });
    if (desiredPagesSettled) {
        emitLoading(false);
    }
}

async function ensurePageLoaded(pageNumber: number) {
    const state = pageStates.value[pageNumber - 1];
    const worker = activeWorker;
    if (!worker || !canLoadPagePreview(state)) {
        return;
    }

    state.status = 'loading';
    state.token += 1;
    const token = state.token;

    try {
        const pageObject = await worker.doc.getPage(pageNumber).createPngObjectUrl().run();
        commitLoadedPagePreview(pageNumber, token, worker, pageObject.url);
    } catch (error) {
        markPagePreviewLoadFailed(pageNumber, token, error);
    }
}

function getPreferredRenderedPageNumbers() {
    if (totalPages.value <= 0) {
        return [] as number[];
    }

    if (isContinuousScroll.value) {
        return renderedPageNumbers.value;
    }

    const preferredPages = [currentPage.value];
    for (let distance = 1; distance <= 2; distance += 1) {
        const nextPage = currentPage.value + distance;
        if (nextPage <= totalPages.value) {
            preferredPages.push(nextPage);
        }

        const previousPage = currentPage.value - distance;
        if (previousPage >= 1) {
            preferredPages.push(previousPage);
        }
    }

    return preferredPages;
}

function queueDesiredPages(pageNumbers: number[]) {
    queuedPageNumbers = pageNumbers.filter((pageNumber, index, list) => (
        pageNumber >= 1
        && pageNumber <= totalPages.value
        && list.indexOf(pageNumber) === index
    ));
}

async function processRenderQueue() {
    if (activeRenderPromise || !activeWorker) {
        return;
    }

    const nextPageNumber = queuedPageNumbers.find((pageNumber) => {
        const state = pageStates.value[pageNumber - 1];
        return state?.status === 'idle';
    });

    if (!nextPageNumber) {
        finishInitialPreviewLoadIfSettled();
        return;
    }

    activeRenderPromise = ensurePageLoaded(nextPageNumber)
        .finally(() => {
            activeRenderPromise = null;
        });

    await activeRenderPromise;

    if (!activeWorker) {
        return;
    }

    void processRenderQueue();
}

function syncLoadedPages() {
    if (!activeWorker || totalPages.value <= 0) {
        return;
    }

    const desiredPageNumbers = getPreferredRenderedPageNumbers();
    const activePages = new Set(desiredPageNumbers);
    queueDesiredPages(desiredPageNumbers);

    for (const pageNumber of lastRenderedPageSet) {
        if (activePages.has(pageNumber)) {
            continue;
        }

        const state = pageStates.value[pageNumber - 1];
        if (state && state.status !== 'idle') {
            resetPageState(pageNumber);
        }
    }

    lastRenderedPageSet = activePages;
    void processRenderQueue();
}

function detectCurrentPageFromViewport() {
    if (!isContinuousScroll.value) {
        emit('update:currentPage', currentPage.value);
        return;
    }

    if (totalPages.value <= 0) {
        return;
    }

    const window = resolveContinuousScrollWindow();
    const bestPage = window?.mostVisiblePage ?? currentPage.value;

    if (bestPage !== currentPage.value) {
        currentPage.value = bestPage;
        emit('update:currentPage', bestPage);
    }
}

function scheduleViewportSync() {
    if (scrollRafId !== 0) {
        return;
    }

    scrollRafId = window.requestAnimationFrame(() => {
        scrollRafId = 0;
        detectCurrentPageFromViewport();
    });
}

function handleViewerScroll() {
    if (!import.meta.client) {
        return;
    }

    scrollTop.value = viewerContainer.value?.scrollTop ?? 0;
    scheduleViewportSync();
}

function shouldIgnorePageFlipWheel(event: WheelEvent) {
    return (
        isContinuousScroll.value ||
        isLoading.value ||
        totalPages.value <= 0 ||
        event.ctrlKey ||
        event.metaKey
    );
}

function hasHorizontalWheelIntent(event: WheelEvent) {
    return Math.abs(event.deltaX) > Math.abs(event.deltaY) * HORIZONTAL_INTENT_REJECT_RATIO;
}

function canScrollCurrentSpread(
    container: HTMLElement,
    direction: -1 | 1,
    maxScrollTop: number,
) {
    return maxScrollTop > PAGE_SCROLL_EDGE_EPSILON
        && (
            direction > 0
                ? container.scrollTop < maxScrollTop - PAGE_SCROLL_EDGE_EPSILON
                : container.scrollTop > PAGE_SCROLL_EDGE_EPSILON
        );
}

function scrollCurrentSpreadByWheelDelta(
    container: HTMLElement,
    delta: number,
    direction: -1 | 1,
    maxScrollTop: number,
) {
    clearWheelAccumulator();
    container.scrollTop = direction > 0
        ? Math.min(maxScrollTop, container.scrollTop + delta)
        : Math.max(0, container.scrollTop + delta);
}

function resolvePageFlipWheelStep(event: WheelEvent, delta: number, direction: -1 | 1) {
    const accumulationResult = accumulateWheelForPageFlips({
        state: wheelAccumulator,
        delta,
        direction,
        eventTimeMs: event.timeStamp,
        stepDelta: resolveWheelPageFlipStepDelta(event, delta),
        maxSteps: 1,
    });
    wheelAccumulator = accumulationResult.state;
    return accumulationResult.stepsToFlip;
}

function flipPageFromWheel(direction: -1 | 1) {
    const targetPage = stepBySpread(
        currentPage.value,
        viewMode.value,
        totalPages.value,
        direction,
        1,
    );
    if (targetPage === currentPage.value) {
        clearWheelAccumulator();
        return;
    }

    scrollToPage(targetPage);
}

function resolvePageFlipWheelContext(event: WheelEvent) {
    if (shouldIgnorePageFlipWheel(event) || hasHorizontalWheelIntent(event)) {
        return null;
    }

    const container = viewerContainer.value;
    if (!container) {
        return null;
    }

    const delta = normalizePageWheelDelta(event.deltaY, event.deltaMode, container);
    if (Math.abs(delta) < WHEEL_DELTA_EPSILON) {
        return null;
    }

    const direction: -1 | 1 = delta > 0 ? 1 : -1;
    return {
        container,
        delta,
        direction,
        maxScrollTop: Math.max(0, container.scrollHeight - container.clientHeight),
    };
}

function handleViewerWheel(event: WheelEvent) {
    const context = resolvePageFlipWheelContext(event);
    if (!context) {
        return;
    }
    event.preventDefault();

    if (canScrollCurrentSpread(context.container, context.direction, context.maxScrollTop)) {
        scrollCurrentSpreadByWheelDelta(
            context.container,
            context.delta,
            context.direction,
            context.maxScrollTop,
        );
        return;
    }

    if (resolvePageFlipWheelStep(event, context.delta, context.direction) === 0) {
        return;
    }

    flipPageFromWheel(context.direction);
}

function retryPage(pageNumber: number) {
    resetPageState(pageNumber);
    void ensurePageLoaded(pageNumber);
}

function clearWheelAccumulator() {
    wheelAccumulator = createWheelPageAccumulatorState();
}

function syncHorizontalScrollForZoomMode() {
    const container = viewerContainer.value;
    if (!container) {
        return;
    }

    if (zoomMode.value === 'fit-width') {
        container.scrollLeft = 0;
        return;
    }

    if (zoomMode.value === 'fit-height' && container.scrollWidth <= container.clientWidth) {
        container.scrollLeft = 0;
    }
}

function scrollActiveSpreadIntoView() {
    const container = viewerContainer.value;
    if (!container || isContinuousScroll.value) {
        return;
    }

    container.scrollTop = 0;
    syncHorizontalScrollForZoomMode();
}

watch(effectiveZoom, (value) => {
    invalidateContinuousScrollWindowCache();
    emit('update:effectiveZoom', value);
}, { immediate: true });

watch(zoomMode, () => {
    invalidateContinuousScrollWindowCache();
});

watch(renderedPageNumbers, async () => {
    if (!import.meta.client || totalPages.value <= 0) {
        return;
    }

    await nextTick();
    scrollActiveSpreadIntoView();
    syncLoadedPages();
}, { flush: 'post' });

watch(
    () => props.src,
    async (src) => {
        loadGeneration += 1;
        const generation = loadGeneration;

        stopWorker();
        cleanupViewerState();

        if (!src || !import.meta.client) {
            emitLoading(false);
            return;
        }

        emitLoading(true, { force: true });

        try {
            const worker = await createDjvuWorkerFromPath(src);
            if (generation !== loadGeneration) {
                worker.terminate();
                return;
            }

            activeWorker = worker;
            const sizes = await worker.doc.getPagesSizes().run();
            if (generation !== loadGeneration) {
                return;
            }

            pageSizes.value = sizes;
            pageStates.value = sizes.map(() => ({
                objectUrl: null,
                status: 'idle',
                token: 0,
            }));
            invalidateContinuousScrollWindowCache();
            currentPage.value = 1;
            viewerError.value = null;
            emit('update:document', null);
            emit('update:totalPages', sizes.length);
            emit('update:currentPage', 1);
            if (sizes.length === 0) {
                emitLoading(false);
                return;
            }

            await nextTick();
            measureContainer();
            if (viewerContainer.value) {
                viewerContainer.value.scrollTop = 0;
                scrollTop.value = 0;
                syncHorizontalScrollForZoomMode();
            }
            lastRenderedPageSet = new Set<number>();
            syncLoadedPages();
        } catch (error) {
            viewerError.value = error instanceof Error ? error.message : t('errors.djvu.open');
            BrowserLogger.error('djvu-viewer', 'Failed to initialize native DjVu viewer', {
                src,
                error,
            });
            emitLoading(false);
        } finally {
            if (generation === loadGeneration) {
                finishInitialPreviewLoadIfSettled();
            }
        }
    },
    { immediate: true },
);

watch(
    [
        effectiveZoom,
        totalPages,
    ],
    async () => {
        if (!import.meta.client || totalPages.value <= 0) {
            return;
        }

        await nextTick();
        syncHorizontalScrollForZoomMode();
        scheduleViewportSync();
    },
    { flush: 'post' },
);

onMounted(() => {
    measureContainer();

    resizeObserver = new ResizeObserver(() => {
        measureContainer();
        scheduleViewportSync();
    });

    if (viewerContainer.value) {
        resizeObserver.observe(viewerContainer.value);
    }
});

onBeforeUnmount(() => {
    if (scrollRafId !== 0) {
        window.cancelAnimationFrame(scrollRafId);
        scrollRafId = 0;
    }

    resizeObserver?.disconnect();
    resizeObserver = null;
    stopWorker();
});

function scrollToPage(pageNumber: number) {
    const normalizedPage = Math.max(1, Math.min(pageNumber, totalPages.value || 1));

    if (!isContinuousScroll.value) {
        currentPage.value = normalizedPage;
        emit('update:currentPage', normalizedPage);
        clearWheelAccumulator();
        void nextTick().then(() => {
            scrollActiveSpreadIntoView();
            syncLoadedPages();
        });
        return;
    }

    if (normalizedPage !== currentPage.value) {
        currentPage.value = normalizedPage;
        emit('update:currentPage', normalizedPage);
        invalidateContinuousScrollWindowCache();
    }

    const element = pageElements.get(normalizedPage);
    if (element) {
        element.scrollIntoView({
            block: 'start',
            inline: 'nearest',
        });
        return;
    }

    const container = viewerContainer.value;
    if (!container) {
        return;
    }

    const targetScrollTop = DJVU_BASE_MARGIN
        + getContinuousPagesHeight(1, normalizedPage - 1)
        + (normalizedPage > 1 ? DJVU_BASE_MARGIN : 0);
    container.scrollTop = targetScrollTop;
    scrollTop.value = targetScrollTop;
    void nextTick(() => {
        pageElements.get(normalizedPage)?.scrollIntoView({
            block: 'start',
            inline: 'nearest',
        });
        syncLoadedPages();
    });
}

function captureScrollSnapshot(): IScrollSnapshot | null {
    return null;
}

function restoreScrollSnapshot() {}

function returnFalseAsync() {
    return Promise.resolve(false);
}

function returnNullAsync() {
    return Promise.resolve(null);
}

function returnVoidAsync() {
    return Promise.resolve();
}

const noop = () => {};
const noopMarkupOverrides = () => new Map<string, TMarkupSubtype>();
const noopShapes = () => [] as IShapeAnnotation[];
const noopSelectedShape = () => null;

defineExpose<IPdfViewerExpose>({
    getViewerContainer: () => viewerContainer.value,
    scrollToPage,
    captureScrollSnapshot,
    restoreScrollSnapshot,
    captureRegionToClipboard: returnFalseAsync,
    isCapturingRegion: false,
    startCropSelection: returnNullAsync,
    cancelCropSelection: noop,
    isCropSelecting: false,
    saveDocument: () => Promise.resolve(null),
    highlightSelection: returnFalseAsync,
    commentSelection: returnFalseAsync,
    commentAtPoint: () => Promise.resolve(false),
    startCommentPlacement: noop,
    cancelCommentPlacement: noop,
    undoAnnotation: noop,
    redoAnnotation: noop,
    focusAnnotationComment: returnVoidAsync,
    updateAnnotationComment: () => false,
    deleteAnnotationComment: () => Promise.resolve(false),
    suppressAnnotationId: noop,
    suppressAnnotationStableKey: noop,
    removeAnnotationFromDom: noop,
    removeAnnotationFromInternalCache: noop,
    getMarkupSubtypeOverrides: noopMarkupOverrides,
    getAllShapes: noopShapes,
    getDeletedEmbeddedShapeAnnotationIds: () => [],
    getDeletedEmbeddedShapeStableKeys: () => [],
    loadShapes: noop,
    clearShapes: noop,
    clearSelectedShape: noop,
    deleteSelectedShape: noop,
    hasShapes: false,
    selectedShapeId: null,
    updateShape: noop,
    getSelectedShape: noopSelectedShape,
    startImagePlacement: () => Promise.resolve(false),
    clearPendingImagePlacement: noop,
    restorePendingImagePlacement: noop,
    invalidatePages: (pages: number[]) => {
        for (const pageNumber of pages) {
            if (pageNumber < 1 || pageNumber > totalPages.value) {
                continue;
            }
            resetPageState(pageNumber);
        }
        syncLoadedPages();
    },
    requestScrollToCurrentResult: noop,
});
</script>

<style scoped>
.djvu-page-shell {
    position: relative;
    overflow: hidden;
    border: 1px solid var(--ui-border);
    border-radius: var(--ui-radius-lg);
    background: var(--ui-bg);
    box-shadow: var(--shadow-popup);
}

.djvu-page-virtual-spacer {
    flex: 0 0 auto;
    width: 1px;
}

.djvu-page-placeholder {
    display: flex;
    height: 100%;
    width: 100%;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    background: color-mix(in oklab, var(--ui-bg) 92%, var(--ui-bg-muted) 8%);
}

.djvu-page-number {
    position: absolute;
    right: 0.75rem;
    bottom: 0.75rem;
    border-radius: var(--ui-radius-full);
    background: color-mix(in oklab, var(--ui-bg-elevated) 88%, transparent);
    padding: 0.125rem 0.5rem;
    font-size: 0.75rem;
    color: var(--ui-text-muted);
    backdrop-filter: blur(6px);
}

.djvu-viewer-container--pending {
    pointer-events: none;
    visibility: hidden;
}

</style>
