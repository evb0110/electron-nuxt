<template>
    <div class="relative h-full w-full">
        <div
            v-if="viewerError"
            class="absolute inset-0 flex items-center justify-center bg-muted/30"
            data-testid="native-pdf-viewer-error"
        >
            <div class="flex max-w-md flex-col items-center gap-3 px-6 text-center">
                <UIcon
                    name="i-ph-warning-circle"
                    class="size-8 text-muted"
                />
                <p class="text-sm text-default">
                    {{ viewerError }}
                </p>
            </div>
        </div>

        <div
            ref="viewerContainer"
            class="native-pdf-viewer-container h-full w-full overflow-auto app-scrollbar"
            :class="{
                'cursor-grab': dragMode,
                'cursor-default': !dragMode,
            }"
            @scroll="handleViewerScroll"
        >
            <div
                class="native-pdf-continuous-surface mx-auto min-w-full"
                :style="renderedPagesSurfaceStyle"
            >
                <section
                    v-for="pageNumber in renderedPageNumbers"
                    :key="pageNumber"
                    class="native-pdf-page-shell"
                    :style="getPageShellStyle(pageNumber)"
                    :data-page-number="pageNumber"
                >
                    <NativePdfPageContent
                        :page-number="pageNumber"
                        :page-state="pageStates[pageNumber - 1]"
                        @retry="retryPage(pageNumber)"
                        @visual-ready="handlePageVisualReady"
                    />
                </section>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { useResizeObserver } from '@vueuse/core';
import { clamp } from 'es-toolkit/math';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TPdfViewMode } from '@contracts/shared';
import type { IPdfNativePageSize } from '@contracts/electronApiDocuments';
import type { IScrollSnapshot } from '@app/types/pdfUi';
import type { IDocumentViewerExpose } from '@app/modules/pdf-viewer/public';
import NativePdfPageContent from '@app/modules/native-pdf-viewer/components/NativePdfPageContent.vue';
import { createNativePdfPreviewSourceFromPath } from '@app/platform/browser-api/public';
import { getDocumentFilesCapability } from '@app/utils/platformDocuments';
import type {
    IDocumentPreviewPageState,
    IPagePreviewSource,
} from '@app/utils/document-viewer/pagePreviewSource';
import {
    capturePageAnchorScrollSnapshot,
    restorePageAnchorScrollSnapshot,
} from '@app/utils/document-viewer/page-anchor-scroll-snapshot/pageAnchorScrollSnapshot';
import { BrowserLogger } from '@app/utils/browserLogger';

interface IProps {
    src: TDocumentRef | null;
    zoom?: number;
    zoomMode?: 'custom' | 'fit-width' | 'fit-height';
    fitMode?: 'width' | 'height';
    viewMode?: TPdfViewMode;
    continuousScroll?: boolean;
    dragMode?: boolean;
    isActive?: boolean;
}

const {
    dragMode: dragModeProp,
    fitMode = undefined,
    isActive: isActiveProp = true,
    src,
    viewMode: _viewMode = undefined,
    zoom = undefined,
    zoomMode: zoomModeProp = undefined,
} = defineProps<IProps>();
const emit = defineEmits<{
    'update:effectiveZoom': [value: number];
    'update:currentPage': [value: number];
    'update:totalPages': [value: number];
    'update:document': [value: null];
    loading: [value: boolean];
    'initial-visual-pending': [];
    'initial-visual-ready': [payload: {pageNumber: number;}];
}>();

interface IPageLayout {
    top: number;
    width: number;
    height: number;
}

const NATIVE_PDF_BASE_MARGIN = 16;
const NATIVE_PDF_RENDER_OVERSCAN_VIEWPORTS = 2;
const NATIVE_PDF_RENDER_MARGIN_PAGES = 3;
const NATIVE_PDF_RENDER_CONCURRENCY = 2;
const NATIVE_PDF_DEVICE_PIXEL_RATIO_CAP = 1;
const NATIVE_PDF_INITIAL_PREVIEW_MAX_TARGET_PX = 1_024;
const NATIVE_PDF_PAGE_SNAPSHOT_SELECTOR = '[data-page-number]';

const viewerContainer = ref<HTMLElement | null>(null);
const pageSizes = ref<IPdfNativePageSize[]>([]);
const pageStates = ref<IDocumentPreviewPageState[]>([]);
const currentPage = ref(1);
const containerWidth = ref(0);
const containerHeight = ref(0);
const scrollTop = ref(0);
const viewerError = ref<string | null>(null);
const isLoading = ref(Boolean(src));
const isActive = computed(() => isActiveProp);
const dragMode = computed(() => dragModeProp ?? false);
const totalPages = computed(() => pageSizes.value.length);
let activeSource: IPagePreviewSource | null = null;
let loadGeneration = 0;
let pendingInitialVisualGeneration: number | null = null;
let readyInitialVisualGeneration: number | null = null;
let initialVisualSettlePromise: Promise<void> | null = null;
let resolveInitialVisualSettlePromise: (() => void) | null = null;
const activeRenderPageNumbers = new Set<number>();
const paintedPageObjectUrls = new Map<number, string>();
const queuedPageObjectUrlsForRevoke = new Map<number, string[]>();

const manualZoom = computed(() => {
    const candidate = zoom ?? 1;
    if (!Number.isFinite(candidate) || candidate <= 0) {
        return 1;
    }
    return candidate;
});
const zoomMode = computed(() => zoomModeProp ?? (
    fitMode === 'height' ? 'fit-height' : 'fit-width'
));

function fitWidthAvailable() {
    return Math.max(1, containerWidth.value - NATIVE_PDF_BASE_MARGIN * 2);
}

function fitHeightAvailable() {
    return Math.max(1, containerHeight.value - NATIVE_PDF_BASE_MARGIN * 2);
}

function resolveFitHeightZoomForPageSize(pageSize: IPdfNativePageSize | null | undefined) {
    const baseHeight = pageSize?.height;
    if (!baseHeight || baseHeight <= 0) {
        return manualZoom.value;
    }

    return Math.max(0.1, fitHeightAvailable() / baseHeight);
}

function getPageDisplayScale(pageNumber: number) {
    const pageSize = pageSizes.value[pageNumber - 1];
    if (!pageSize) {
        return 1;
    }

    if (zoomMode.value === 'fit-width' && pageSize.width > 0) {
        return Math.max(0.1, fitWidthAvailable() / pageSize.width);
    }
    if (zoomMode.value === 'fit-height') {
        return resolveFitHeightZoomForPageSize(pageSize);
    }

    return manualZoom.value;
}

const effectiveZoom = computed(() => {
    if (zoomMode.value === 'custom') {
        return manualZoom.value;
    }

    const pageSize = pageSizes.value[currentPage.value - 1] ?? pageSizes.value[0] ?? null;
    if (zoomMode.value === 'fit-height') {
        return resolveFitHeightZoomForPageSize(pageSize);
    }
    if (!pageSize?.width) {
        return manualZoom.value;
    }
    return Math.max(0.1, fitWidthAvailable() / pageSize.width);
});

const pageLayouts = computed<IPageLayout[]>(() => {
    let top = NATIVE_PDF_BASE_MARGIN;
    return pageSizes.value.map((pageSize, index) => {
        const pageNumber = index + 1;
        const scale = getPageDisplayScale(pageNumber);
        const width = Math.max(1, Math.round(pageSize.width * scale));
        const height = Math.max(1, Math.round(pageSize.height * scale));
        const layout = {
            top,
            width,
            height,
        };
        top += height + NATIVE_PDF_BASE_MARGIN;
        return layout;
    });
});

const continuousSurfaceWidth = computed(() => {
    const maxPageWidth = pageLayouts.value.reduce((maxWidth, layout) => Math.max(maxWidth, layout.width), 0);
    return Math.max(containerWidth.value, maxPageWidth + NATIVE_PDF_BASE_MARGIN * 2, 1);
});

const continuousDocumentHeight = computed(() => {
    const lastLayout = pageLayouts.value.at(-1);
    if (!lastLayout) {
        return Math.max(containerHeight.value, 1);
    }
    return Math.max(containerHeight.value, lastLayout.top + lastLayout.height + NATIVE_PDF_BASE_MARGIN, 1);
});

const renderedPageNumbers = computed(() => {
    if (totalPages.value <= 0) {
        return [] as number[];
    }

    const viewportStart = Math.max(0, scrollTop.value - containerHeight.value * NATIVE_PDF_RENDER_OVERSCAN_VIEWPORTS);
    const viewportEnd = scrollTop.value + containerHeight.value * (1 + NATIVE_PDF_RENDER_OVERSCAN_VIEWPORTS);
    const pages: number[] = [];
    for (const [
        index,
        layout,
    ] of pageLayouts.value.entries()) {
        if (layout.top + layout.height < viewportStart || layout.top > viewportEnd) {
            continue;
        }
        pages.push(index + 1);
    }

    return pages.length > 0 ? pages : [currentPage.value];
});

const renderedPagesSurfaceStyle = computed(() => ({
    height: `${continuousDocumentHeight.value}px`,
    width: `${continuousSurfaceWidth.value}px`,
}));

function createIdlePageState(): IDocumentPreviewPageState {
    return {
        failedRenderPx: 0,
        objectUrl: null,
        renderedPx: 0,
        status: 'idle',
        token: 0,
    };
}

function emitLoading(nextLoading: boolean, options: { force?: boolean } = {}) {
    if (!options.force && isLoading.value === nextLoading) {
        return;
    }

    isLoading.value = nextLoading;
    emit('loading', nextLoading);
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
    emit('initial-visual-pending');
}

function markInitialVisualReady(generation: number, pageNumber: number) {
    if (
        !isCurrentLoadGeneration(generation)
        || pendingInitialVisualGeneration !== generation
        || readyInitialVisualGeneration === generation
    ) {
        return;
    }

    readyInitialVisualGeneration = generation;
    pendingInitialVisualGeneration = null;
    emit('initial-visual-ready', { pageNumber });
    resolveInitialVisualSettle();
}

function waitForViewerLoadSettled() {
    if (
        !isActive.value
        || !isLoading.value
        || viewerError.value
        || readyInitialVisualGeneration === loadGeneration
    ) {
        return Promise.resolve();
    }

    return ensureInitialVisualSettlePromise();
}

function getPageShellStyle(pageNumber: number) {
    const layout = pageLayouts.value[pageNumber - 1];
    if (!layout) {
        return {};
    }

    return {
        left: `${Math.max(NATIVE_PDF_BASE_MARGIN, Math.round((continuousSurfaceWidth.value - layout.width) / 2))}px`,
        top: `${layout.top}px`,
        width: `${layout.width}px`,
        height: `${layout.height}px`,
    };
}

function measureContainer() {
    const element = viewerContainer.value;
    if (!element) {
        return;
    }

    containerWidth.value = Math.max(0, element.clientWidth);
    containerHeight.value = Math.max(0, element.clientHeight);
    scrollTop.value = Math.max(0, element.scrollTop);
}

function getNeededDeviceWidth(pageNumber: number) {
    const layout = pageLayouts.value[pageNumber - 1];
    const cssWidth = Math.max(1, layout?.width ?? 1);
    const devicePixelRatio = typeof window !== 'undefined'
        ? Math.min(window.devicePixelRatio || 1, NATIVE_PDF_DEVICE_PIXEL_RATIO_CAP)
        : 1;
    return Math.max(1, Math.ceil(cssWidth * devicePixelRatio));
}

function getPageRenderTargetWidth(pageNumber: number, pageState: IDocumentPreviewPageState | undefined) {
    const neededWidth = getNeededDeviceWidth(pageNumber);
    if (pageState?.objectUrl) {
        return neededWidth;
    }

    return Math.min(neededWidth, NATIVE_PDF_INITIAL_PREVIEW_MAX_TARGET_PX);
}

function revokeObjectUrl(pageNumber: number, objectUrl: string) {
    if (!activeSource) {
        return;
    }

    try {
        activeSource.revokeObjectURL(objectUrl);
    } catch (error) {
        BrowserLogger.warn('native-pdf-viewer', 'Failed to revoke PDF page URL', {
            pageNumber,
            error,
        });
    }
}

function queuePageUrlForRevoke(pageNumber: number, objectUrl: string) {
    const queuedUrls = queuedPageObjectUrlsForRevoke.get(pageNumber) ?? [];
    if (!queuedUrls.includes(objectUrl)) {
        queuedUrls.push(objectUrl);
    }
    queuedPageObjectUrlsForRevoke.set(pageNumber, queuedUrls);
}

function revokeQueuedPageUrls(pageNumber: number) {
    const queuedUrls = queuedPageObjectUrlsForRevoke.get(pageNumber);
    if (!queuedUrls?.length) {
        return;
    }

    const currentObjectUrl = pageStates.value[pageNumber - 1]?.objectUrl ?? null;
    for (const objectUrl of queuedUrls) {
        if (objectUrl === currentObjectUrl) {
            continue;
        }
        revokeObjectUrl(pageNumber, objectUrl);
    }
    queuedPageObjectUrlsForRevoke.delete(pageNumber);
}

function revokePageUrl(pageNumber: number) {
    const pageState = pageStates.value[pageNumber - 1];
    revokeQueuedPageUrls(pageNumber);
    paintedPageObjectUrls.delete(pageNumber);

    if (!pageState?.objectUrl) {
        return;
    }

    revokeObjectUrl(pageNumber, pageState.objectUrl);
    pageState.objectUrl = null;
    pageState.failedRenderPx = 0;
    pageState.renderedPx = 0;
}

function resetPageState(pageNumber: number) {
    const pageState = pageStates.value[pageNumber - 1];
    if (!pageState) {
        return;
    }

    pageState.token += 1;
    revokePageUrl(pageNumber);
    pageState.failedRenderPx = 0;
    pageState.renderedPx = 0;
    pageState.status = 'idle';
}

function cleanupRenderedPages() {
    for (let pageNumber = 1; pageNumber <= pageStates.value.length; pageNumber += 1) {
        revokePageUrl(pageNumber);
    }
    queuedPageObjectUrlsForRevoke.clear();
    paintedPageObjectUrls.clear();
}

function stopSource() {
    resolveInitialVisualSettle();
    cleanupRenderedPages();
    activeRenderPageNumbers.clear();
    activeSource?.terminate();
    activeSource = null;
}

function cleanupViewerState() {
    stopSource();
    pageSizes.value = [];
    pageStates.value = [];
    currentPage.value = 1;
    scrollTop.value = 0;
    viewerError.value = null;
    emit('update:document', null);
    emit('update:totalPages', 0);
    emit('update:currentPage', 1);
}

function getVisiblePageNumber() {
    const container = viewerContainer.value;
    if (!container || pageLayouts.value.length === 0) {
        return currentPage.value;
    }

    const viewportStart = container.scrollTop;
    const viewportEnd = viewportStart + container.clientHeight;
    let bestPage = currentPage.value;
    let bestVisiblePx = 0;
    for (const [
        index,
        layout,
    ] of pageLayouts.value.entries()) {
        const visiblePx = Math.max(
            0,
            Math.min(viewportEnd, layout.top + layout.height) - Math.max(viewportStart, layout.top),
        );
        if (visiblePx > bestVisiblePx) {
            bestVisiblePx = visiblePx;
            bestPage = index + 1;
        }
    }
    return bestPage;
}

function syncCurrentPageFromViewport() {
    const nextPage = getVisiblePageNumber();
    if (nextPage === currentPage.value) {
        return;
    }
    currentPage.value = nextPage;
    emit('update:currentPage', nextPage);
}

function getActivePageSet() {
    const activePages = new Set<number>();
    for (const pageNumber of renderedPageNumbers.value) {
        for (
            let retainedPage = pageNumber - NATIVE_PDF_RENDER_MARGIN_PAGES;
            retainedPage <= pageNumber + NATIVE_PDF_RENDER_MARGIN_PAGES;
            retainedPage += 1
        ) {
            if (retainedPage >= 1 && retainedPage <= totalPages.value) {
                activePages.add(retainedPage);
            }
        }
    }
    activePages.add(currentPage.value);
    return activePages;
}

function releaseInactivePages(activePages: Set<number>) {
    for (let pageNumber = 1; pageNumber <= pageStates.value.length; pageNumber += 1) {
        if (activePages.has(pageNumber)) {
            continue;
        }
        const pageState = pageStates.value[pageNumber - 1];
        if (pageState && pageState.status !== 'idle') {
            resetPageState(pageNumber);
        }
    }
}

function isPagePreviewUndersized(pageNumber: number, pageState: IDocumentPreviewPageState | undefined) {
    return Boolean(
        pageState
        && pageState.status === 'loaded'
        && pageState.objectUrl
        && pageState.renderedPx > 0
        && getNeededDeviceWidth(pageNumber) > pageState.renderedPx
        && getNeededDeviceWidth(pageNumber) > pageState.failedRenderPx,
    );
}

function shouldRenderPage(pageNumber: number) {
    const pageState = pageStates.value[pageNumber - 1];
    return Boolean(
        pageState
        && pageState.status !== 'loading'
        && (
            pageState.status === 'idle'
            || isPagePreviewUndersized(pageNumber, pageState)
        ),
    );
}

function finishInitialLoadIfSettled() {
    if (!isActive.value || !isLoading.value) {
        return;
    }

    const initialPageNumbers = renderedPageNumbers.value;
    if (initialPageNumbers.length === 0) {
        return;
    }

    const loadedPageNumber = initialPageNumbers.find((pageNumber) => {
        const pageState = pageStates.value[pageNumber - 1];
        return Boolean(
            pageState?.objectUrl
            && paintedPageObjectUrls.get(pageNumber) === pageState.objectUrl,
        );
    });
    if (loadedPageNumber !== undefined) {
        markInitialVisualReady(loadGeneration, loadedPageNumber);
        emitLoading(false);
        return;
    }

    const visiblePagesSettled = initialPageNumbers.every((pageNumber) => {
        const pageState = pageStates.value[pageNumber - 1];
        return pageState?.status === 'error';
    });
    if (visiblePagesSettled) {
        markInitialVisualReady(loadGeneration, initialPageNumbers[0] ?? currentPage.value);
        emitLoading(false);
    }
}

function preloadPageObjectUrl(objectUrl: string) {
    if (typeof Image === 'undefined') {
        return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('Failed to decode PDF page preview'));
        image.src = objectUrl;
    });
}

async function ensurePageLoaded(pageNumber: number, generation: number) {
    const source = activeSource;
    const pageState = pageStates.value[pageNumber - 1];
    if (!source || !isActive.value || !pageState || !shouldRenderPage(pageNumber)) {
        return;
    }

    pageState.status = 'loading';
    pageState.token += 1;
    const token = pageState.token;
    const targetWidthPx = getPageRenderTargetWidth(pageNumber, pageState);
    let pendingObjectUrl: string | null = null;
    let committedObjectUrl = false;

    try {
        const {
            objectUrl,
            renderedPx,
        } = await source.renderPageObjectUrl(pageNumber, { targetWidthPx });
        pendingObjectUrl = objectUrl;
        const currentState = pageStates.value[pageNumber - 1];
        if (
            !isCurrentLoadGeneration(generation)
            || source !== activeSource
            || !currentState
            || currentState.token !== token
        ) {
            source.revokeObjectURL(objectUrl);
            pendingObjectUrl = null;
            return;
        }
        await preloadPageObjectUrl(objectUrl);
        const decodedState = pageStates.value[pageNumber - 1];
        if (
            !isCurrentLoadGeneration(generation)
            || source !== activeSource
            || !decodedState
            || decodedState.token !== token
        ) {
            source.revokeObjectURL(objectUrl);
            pendingObjectUrl = null;
            return;
        }
        const previousObjectUrl = decodedState.objectUrl;
        paintedPageObjectUrls.delete(pageNumber);
        decodedState.objectUrl = objectUrl;
        decodedState.renderedPx = renderedPx;
        decodedState.failedRenderPx = 0;
        decodedState.status = 'loaded';
        committedObjectUrl = true;
        if (previousObjectUrl && previousObjectUrl !== objectUrl) {
            queuePageUrlForRevoke(pageNumber, previousObjectUrl);
        }
        finishInitialLoadIfSettled();
    } catch (error) {
        if (pendingObjectUrl && !committedObjectUrl) {
            source.revokeObjectURL(pendingObjectUrl);
        }
        const currentState = pageStates.value[pageNumber - 1];
        if (
            !isCurrentLoadGeneration(generation)
            || source !== activeSource
            || !currentState
            || currentState.token !== token
        ) {
            return;
        }
        if (currentState.objectUrl) {
            currentState.failedRenderPx = Math.max(currentState.failedRenderPx, targetWidthPx);
            currentState.status = 'loaded';
            BrowserLogger.warn('native-pdf-viewer', 'Failed to refresh PDF page preview', {
                pageNumber,
                error,
            });
        } else {
            currentState.status = 'error';
            BrowserLogger.warn('native-pdf-viewer', 'Failed to load PDF page preview', {
                pageNumber,
                error,
            });
        }
        finishInitialLoadIfSettled();
    }
}

function syncLoadedPages() {
    if (!isActive.value || !activeSource || totalPages.value <= 0) {
        return;
    }

    const activePages = getActivePageSet();
    releaseInactivePages(activePages);
    for (const pageNumber of activePages) {
        if (activeRenderPageNumbers.size >= NATIVE_PDF_RENDER_CONCURRENCY) {
            break;
        }
        if (!shouldRenderPage(pageNumber) || activeRenderPageNumbers.has(pageNumber)) {
            continue;
        }
        activeRenderPageNumbers.add(pageNumber);
        void ensurePageLoaded(pageNumber, loadGeneration)
            .finally(() => {
                activeRenderPageNumbers.delete(pageNumber);
                syncLoadedPages();
            });
    }
    finishInitialLoadIfSettled();
}

async function loadSource(nextSrc: TDocumentRef, generation: number) {
    const source = createNativePdfPreviewSourceFromPath(nextSrc, getDocumentFilesCapability());
    if (!isCurrentLoadGeneration(generation)) {
        source.terminate();
        return;
    }

    activeSource = source;
    const sizes = await source.getPageSizes();
    if (!isCurrentLoadGeneration(generation) || source !== activeSource) {
        source.terminate();
        return;
    }

    pageSizes.value = sizes;
    pageStates.value = sizes.map(createIdlePageState);
}

function handleViewerScroll() {
    const container = viewerContainer.value;
    if (!container) {
        return;
    }
    scrollTop.value = Math.max(0, container.scrollTop);
    syncCurrentPageFromViewport();
    syncLoadedPages();
}

function handleContainerResize() {
    if (!isActive.value) {
        return;
    }
    measureContainer();
    syncLoadedPages();
}

function retryPage(pageNumber: number) {
    resetPageState(pageNumber);
    syncLoadedPages();
}

function handlePageVisualReady(payload: {
    pageNumber: number;
    objectUrl: string;
}) {
    const pageState = pageStates.value[payload.pageNumber - 1];
    if (!pageState || pageState.objectUrl !== payload.objectUrl) {
        return;
    }

    paintedPageObjectUrls.set(payload.pageNumber, payload.objectUrl);
    revokeQueuedPageUrls(payload.pageNumber);
    finishInitialLoadIfSettled();
}

function scrollToPage(pageNumber: number) {
    const normalizedPage = clamp(pageNumber, 1, totalPages.value || 1);
    currentPage.value = normalizedPage;
    emit('update:currentPage', normalizedPage);
    void nextTick(() => {
        const container = viewerContainer.value;
        const layout = pageLayouts.value[normalizedPage - 1];
        if (!container || !layout) {
            return;
        }
        container.scrollTop = Math.max(0, layout.top - NATIVE_PDF_BASE_MARGIN);
        scrollTop.value = Math.max(0, container.scrollTop);
        syncLoadedPages();
    });
}

function getSnapshotPage(value: number | null | undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }
    return clamp(Math.floor(value), 1, totalPages.value || 1);
}

function captureScrollSnapshot(): IScrollSnapshot | null {
    return capturePageAnchorScrollSnapshot(
        viewerContainer.value,
        {
            pageSelector: NATIVE_PDF_PAGE_SNAPSHOT_SELECTOR,
            preferredAnchorPage: currentPage.value,
        },
    );
}

function restoreScrollSnapshot(
    snapshot: IScrollSnapshot | null,
    options?: { fallbackPage?: number | null },
) {
    const fallbackPage = getSnapshotPage(options?.fallbackPage);
    const anchorPage = getSnapshotPage(snapshot?.anchorPage) ?? fallbackPage;
    if (!snapshot) {
        if (fallbackPage !== null) {
            scrollToPage(fallbackPage);
        }
        return;
    }

    if (anchorPage !== null && anchorPage !== currentPage.value) {
        currentPage.value = anchorPage;
        emit('update:currentPage', anchorPage);
    }

    void nextTick(() => {
        restorePageAnchorScrollSnapshot(
            viewerContainer.value,
            snapshot,
            { pageSelector: NATIVE_PDF_PAGE_SNAPSHOT_SELECTOR },
        );
        measureContainer();
        syncCurrentPageFromViewport();
        syncLoadedPages();
    });
}

watch(effectiveZoom, (value) => {
    emit('update:effectiveZoom', value);
}, { immediate: true });

watch(
    () => src,
    async (nextSrc) => {
        loadGeneration += 1;
        const generation = loadGeneration;
        cleanupViewerState();

        if (!nextSrc || !import.meta.client || !isActive.value) {
            emitLoading(false, { force: true });
            return;
        }

        beginInitialVisualWait(generation);
        emitLoading(true, { force: true });
        try {
            await loadSource(nextSrc, generation);
            if (!isCurrentLoadGeneration(generation) || !activeSource) {
                return;
            }
            currentPage.value = 1;
            viewerError.value = null;
            emit('update:document', null);
            emit('update:totalPages', pageSizes.value.length);
            emit('update:currentPage', 1);
            if (pageSizes.value.length === 0) {
                markInitialVisualReady(generation, 1);
                emitLoading(false);
                return;
            }

            await nextTick();
            measureContainer();
            viewerContainer.value?.scrollTo({
                top: 0,
                left: 0,
            });
            scrollTop.value = 0;
            syncLoadedPages();
        } catch (error) {
            if (!isCurrentLoadGeneration(generation)) {
                return;
            }

            viewerError.value = error instanceof Error ? error.message : 'Failed to open PDF preview';
            BrowserLogger.error('native-pdf-viewer', 'Failed to initialize native PDF viewer', {
                src: nextSrc,
                error,
            });
            markInitialVisualReady(generation, currentPage.value);
            emitLoading(false);
        } finally {
            if (isCurrentLoadGeneration(generation)) {
                finishInitialLoadIfSettled();
            }
        }
    },
    { immediate: true },
);

watch(isActive, async (active) => {
    if (!active) {
        loadGeneration += 1;
        stopSource();
        return;
    }

    if (src && !activeSource && import.meta.client) {
        loadGeneration += 1;
        const generation = loadGeneration;
        beginInitialVisualWait(generation);
        emitLoading(true, { force: true });
        try {
            await loadSource(src, generation);
            if (!isCurrentLoadGeneration(generation) || !activeSource) {
                return;
            }
            emit('update:totalPages', pageSizes.value.length);
            viewerError.value = null;
            if (pageSizes.value.length === 0) {
                markInitialVisualReady(generation, 1);
                emitLoading(false);
                return;
            }
            await nextTick();
            measureContainer();
            syncLoadedPages();
        } catch (error) {
            if (!isCurrentLoadGeneration(generation)) {
                return;
            }
            viewerError.value = error instanceof Error ? error.message : 'Failed to open PDF preview';
            BrowserLogger.error('native-pdf-viewer', 'Failed to resume native PDF viewer', {
                src,
                error,
            });
            markInitialVisualReady(generation, currentPage.value);
            emitLoading(false);
        }
        return;
    }

    await nextTick();
    measureContainer();
    syncLoadedPages();
});

watch([
    renderedPageNumbers,
    effectiveZoom,
    totalPages,
], async () => {
    if (!import.meta.client || !isActive.value || totalPages.value <= 0) {
        return;
    }

    await nextTick();
    syncLoadedPages();
}, { flush: 'post' });

onMounted(measureContainer);
useResizeObserver(viewerContainer, handleContainerResize);

onBeforeUnmount(() => {
    loadGeneration += 1;
    stopSource();
});

defineExpose<IDocumentViewerExpose>({
    getViewerContainer: () => viewerContainer.value,
    getCurrentPage: () => currentPage.value,
    waitForViewerLoadSettled,
    scrollToPage,
    captureScrollSnapshot,
    restoreScrollSnapshot,
    invalidatePages: (pages: number[]) => {
        for (const pageNumber of pages) {
            if (pageNumber < 1 || pageNumber > totalPages.value) {
                continue;
            }
            resetPageState(pageNumber);
        }
        syncLoadedPages();
    },
    requestScrollToCurrentResult: () => {
        scrollToPage(currentPage.value);
    },
});
</script>

<style scoped>
.native-pdf-viewer-container,
.native-pdf-continuous-surface,
.native-pdf-page-shell {
    overflow-anchor: none;
}

.native-pdf-continuous-surface {
    position: relative;
}

.native-pdf-page-shell {
    position: absolute;
    box-sizing: border-box;
    overflow: hidden;
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-lg);
    background: var(--ui-bg);
    box-shadow: var(--shadow-popup);
}

</style>
