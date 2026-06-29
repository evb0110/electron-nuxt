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
                    name="i-ph-warning-circle"
                    class="size-8 text-muted"
                />
                <p class="text-sm text-default">
                    {{ viewerError }}
                </p>
            </div>
        </div>

        <AppLoaderOverlay
            :visible="isInitialPreviewPending"
            :label="t('common.loading')"
        />

        <div
            ref="viewerContainer"
            class="djvu-viewer-container h-full w-full overflow-auto app-scrollbar"
            :class="{
                'cursor-grab': dragMode,
                'cursor-default': !dragMode,
                'djvu-viewer-container--pending': isInitialPreviewPending,
            }"
            @scroll="handleViewerScroll"
            @wheel="handleViewerWheel"
        >
            <div
                class="mx-auto min-w-full"
                :class="renderedPagesSurfaceClass"
                :style="renderedPagesSurfaceStyle"
            >
                <section
                    v-for="pageNumber in renderedPageNumbers"
                    :key="pageNumber"
                    :ref="(element) => setPageElement(pageNumber, element)"
                    class="djvu-page-shell"
                    :class="{ 'djvu-page-shell--continuous': isContinuousScroll }"
                    :style="getPageShellStyle(pageNumber)"
                    :data-page-number="pageNumber"
                >
                    <img
                        v-if="pageStates[pageNumber - 1]?.objectUrl"
                        :src="pageStates[pageNumber - 1]?.objectUrl ?? undefined"
                        :alt="t('djvu.pageAlt', { page: pageNumber })"
                        class="h-full w-full select-none object-contain"
                        decoding="async"
                        draggable="false"
                    >
                    <div
                        v-else-if="pageStates[pageNumber - 1]?.status === 'error'"
                        class="djvu-page-placeholder"
                    >
                        <UIcon
                            name="i-ph-warning-circle"
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
                        class="djvu-page-skeleton"
                        aria-hidden="true"
                    >
                        <div class="djvu-page-skeleton-content">
                            <div class="djvu-page-skeleton-header">
                                <USkeleton class="djvu-page-skeleton-title" />
                                <USkeleton class="djvu-page-skeleton-subtitle" />
                            </div>
                            <div
                                v-for="groupIndex in 5"
                                :key="`djvu-page-skeleton-group-${pageNumber}-${groupIndex}`"
                                class="djvu-page-skeleton-group"
                            >
                                <USkeleton class="djvu-page-skeleton-line" />
                                <USkeleton class="djvu-page-skeleton-line" />
                                <USkeleton class="djvu-page-skeleton-line djvu-page-skeleton-line--short" />
                            </div>
                        </div>
                    </div>
                    <div class="djvu-page-number">
                        {{ pageNumber }}
                    </div>
                </section>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import { useResizeObserver } from '@vueuse/core';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TPdfViewMode } from '@contracts/shared';
import type { IScrollSnapshot } from '@app/types/pdf';
import type { IDjvuPageSize } from '@app/platform/browser-api/public';
import type { IDocumentViewerExpose } from '@app/modules/pdf-viewer/public';
import AppLoaderOverlay from '@app/components/AppLoaderOverlay.vue';
import { clamp } from 'es-toolkit/math';
import {
    getSpreadStartForPage,
    getViewColumnCount,
    isStandaloneSpreadPage,
} from '@app/utils/pdfViewMode';
import {
    useDjvuPreviewRuntime,
    type IDjvuPageState,
} from '@app/modules/djvu-viewer/runtime/useDjvuPreviewRuntime';
import { useDjvuContinuousScrollController } from '@app/modules/djvu-viewer/runtime/useDjvuContinuousScrollController';
import { useDjvuPageFlipWheelController } from '@app/modules/djvu-viewer/runtime/useDjvuPageFlipWheelController';
import {
    capturePageAnchorScrollSnapshot,
    restorePageAnchorScrollSnapshot,
} from '@app/utils/document-viewer/page-anchor-scroll-snapshot/pageAnchorScrollSnapshot';

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
    continuousScroll: continuousScrollProp,
    dragMode: dragModeProp,
    fitMode = undefined,
    isActive: isActiveProp = true,
    src,
    viewMode: viewModeProp = undefined,
    zoom = undefined,
    zoomMode: zoomModeProp = undefined,
} = defineProps<IProps>();
const emit = defineEmits<{
    'update:effectiveZoom': [value: number];
    'update:currentPage': [value: number];
    'update:totalPages': [value: number];
    'update:document': [value: null];
    loading: [value: boolean];
}>();

const { t } = useTypedI18n();
const DJVU_BASE_MARGIN = 16;
const DJVU_CONTINUOUS_OVERSCAN_VIEWPORTS = 2;
const DJVU_CONTINUOUS_RENDER_MARGIN_PAGES = 3;
const DJVU_PREVIEW_DEVICE_PIXEL_RATIO_CAP = 1;
const DJVU_PAGE_SNAPSHOT_SELECTOR = '[data-page-number]';

const viewerContainer = ref<HTMLElement | null>(null);
const pageElements = new Map<number, HTMLElement>();
const pageSizes = ref<IDjvuPageSize[]>([]);
const pageStates = ref<IDjvuPageState[]>([]);
const totalPages = computed(() => pageSizes.value.length);
const currentPage = ref(1);
const viewerError = ref<string | null>(null);
const isLoading = ref(Boolean(src));
const hasVisiblePagePreview = computed(() => (
    pageStates.value.some(state => Boolean(state.objectUrl))
));
const isInitialPreviewPending = computed(() => (
    Boolean(src)
    && isLoading.value
    && !viewerError.value
    && !hasVisiblePagePreview.value
));
const containerWidth = ref(0);
const containerHeight = ref(0);
const dragMode = computed(() => dragModeProp ?? false);
const isActive = computed(() => isActiveProp);
const isContinuousScroll = computed(() => continuousScrollProp ?? true);
const viewMode = computed<TPdfViewMode>(() => viewModeProp ?? 'single');
const zoomMode = computed(() => zoomModeProp ?? (
    fitMode === 'height' ? 'fit-height' : 'fit-width'
));
const renderedPagesLayoutClass = computed(() => (
    isContinuousScroll.value || renderedPageNumbers.value.length <= 1
        ? 'flex-col items-center'
        : 'flex-row items-start justify-center'
));
const renderedPagesSurfaceClass = computed(() => {
    if (isContinuousScroll.value) {
        return 'djvu-continuous-surface';
    }

    return [
        'flex',
        'min-h-full',
        'w-fit',
        'gap-4',
        'p-4',
        renderedPagesLayoutClass.value,
    ];
});

const continuousScrollSurfaceWidth = computed(() => {
    if (!isContinuousScroll.value) {
        return 0;
    }

    const maxPageWidth = pageSizes.value.reduce((maxWidth, pageSize, index) => {
        const scale = getPageDisplayScale(index + 1);
        return Math.max(maxWidth, Math.round(pageSize.width * scale));
    }, 0);

    return Math.max(
        containerWidth.value,
        maxPageWidth + DJVU_BASE_MARGIN * 2,
        1,
    );
});

function getFitHeightAvailableHeight() {
    return Math.max(1, containerHeight.value - DJVU_BASE_MARGIN * 2);
}

function resolveFitHeightZoomForPageSize(pageSize: IDjvuPageSize | null | undefined) {
    const baseHeight = pageSize?.height;
    if (!baseHeight || baseHeight <= 0) {
        return manualZoom.value;
    }

    return Math.max(0.1, getFitHeightAvailableHeight() / baseHeight);
}

const manualZoom = computed(() => {
    const candidate = zoom ?? 1;
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
    return resolveFitHeightZoomForPageSize(currentPageSize);
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

function syncRuntimeLoadedPages() {
    djvuPreviewRuntime.syncLoadedPages();
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
    continuousScrollController.invalidateContinuousScrollWindowCache();
}

function getPageShellStyle(pageNumber: number) {
    const pageSize = pageSizes.value[pageNumber - 1];
    if (!pageSize) {
        return {};
    }

    const scale = getPageDisplayScale(pageNumber);
    const width = Math.max(1, Math.round(pageSize.width * scale));
    const height = Math.max(1, Math.round(pageSize.height * scale));

    return {
        width: `${width}px`,
        height: `${height}px`,
        ...(isContinuousScroll.value
            ? {
                left: `${Math.max(DJVU_BASE_MARGIN, Math.round((continuousScrollSurfaceWidth.value - width) / 2))}px`,
                top: `${continuousScrollController.getContinuousPageTop(pageNumber)}px`,
            }
            : {}),
    };
}

function getPageDisplayScale(pageNumber: number) {
    const pageSize = pageSizes.value[pageNumber - 1];
    if (!pageSize) {
        return 1;
    }

    if (isContinuousScroll.value) {
        if (zoomMode.value === 'fit-width' && pageSize.width > 0) {
            return Math.max(0.1, fitWidthAvailable() / pageSize.width);
        }
        if (zoomMode.value === 'fit-height') {
            return resolveFitHeightZoomForPageSize(pageSize);
        }
    }

    return effectiveZoom.value;
}

function getNeededDeviceWidth(pageNumber: number) {
    const pageSize = pageSizes.value[pageNumber - 1];
    if (!pageSize) {
        return 1;
    }

    const cssWidth = Math.max(1, Math.round(pageSize.width * getPageDisplayScale(pageNumber)));
    const devicePixelRatio = typeof window !== 'undefined'
        ? Math.min(window.devicePixelRatio || 1, DJVU_PREVIEW_DEVICE_PIXEL_RATIO_CAP)
        : 1;
    return Math.max(1, Math.ceil(cssWidth * devicePixelRatio));
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
    if (!isActive.value || !container || isContinuousScroll.value) {
        return;
    }

    container.scrollTop = 0;
    syncHorizontalScrollForZoomMode();
}

const continuousScrollController = useDjvuContinuousScrollController({
    containerHeight,
    currentPage,
    emitCurrentPage: pageNumber => emit('update:currentPage', pageNumber),
    getPageDisplayScale,
    isActive,
    isContinuousScroll,
    pageGapPx: DJVU_BASE_MARGIN,
    pageSizes,
    pageSnapshotSelector: DJVU_PAGE_SNAPSHOT_SELECTOR,
    renderMarginPages: DJVU_CONTINUOUS_RENDER_MARGIN_PAGES,
    overscanViewports: DJVU_CONTINUOUS_OVERSCAN_VIEWPORTS,
    syncLoadedPages: syncRuntimeLoadedPages,
    totalPages,
    viewerContainer,
});

const renderedPageNumbers = computed(() => {
    if (totalPages.value <= 0) {
        return [] as number[];
    }

    if (isContinuousScroll.value) {
        return continuousScrollController.resolveContinuousScrollWindow()?.pageNumbers ?? [];
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

const renderedPagesSurfaceStyle = computed(() => {
    if (!isContinuousScroll.value) {
        return {};
    }

    return {
        height: `${Math.max(containerHeight.value, continuousScrollController.getContinuousDocumentHeight(), 1)}px`,
        width: `${continuousScrollSurfaceWidth.value}px`,
    };
});

const djvuPreviewRuntime = useDjvuPreviewRuntime({
    state: {
        currentPage,
        isLoading,
        pageSizes,
        pageStates,
        viewerError,
    },
    source: {
        getNeededDeviceWidth,
        getOpenErrorMessage: () => t('errors.djvu.open'),
        getSrc: () => src,
        isActive,
        isContinuousScroll,
        resolveContinuousScrollWindow: continuousScrollController.resolveContinuousScrollWindow,
        scrollDirection: continuousScrollController.scrollDirection,
        totalPages,
    },
    effects: {
        clearPageElements: () => pageElements.clear(),
        emitCurrentPage: pageNumber => emit('update:currentPage', pageNumber),
        emitDocument: value => emit('update:document', value),
        emitLoading: value => emit('loading', value),
        emitTotalPages: value => emit('update:totalPages', value),
        invalidateContinuousScrollWindowCache: continuousScrollController.invalidateContinuousScrollWindowCache,
        measureContainer,
        resetScrollState: continuousScrollController.resetScrollState,
        resetViewerScrollPosition: continuousScrollController.resetContainerScrollPosition,
        scheduleViewportSync: continuousScrollController.scheduleViewportSync,
        syncHorizontalScrollForZoomMode,
    },
});

const pageFlipWheelController = useDjvuPageFlipWheelController({
    currentPage,
    isActive,
    isContinuousScroll,
    isLoading,
    scrollToPage,
    totalPages,
    viewMode,
    viewerContainer,
});

function handleViewerScroll() {
    if (!import.meta.client) {
        return;
    }

    if (continuousScrollController.handleViewerScroll()) {
        djvuPreviewRuntime.scheduleScrollSettledPreviewRerender();
    }
}

function handleViewerWheel(event: WheelEvent) {
    if (
        continuousScrollController.handleProjectedWheelScroll(event)
    ) {
        djvuPreviewRuntime.scheduleScrollSettledPreviewRerender();
    }
    pageFlipWheelController.handleViewerWheel(event);
}

function retryPage(pageNumber: number) {
    djvuPreviewRuntime.retryPage(pageNumber);
}

watch(effectiveZoom, (value) => {
    continuousScrollController.invalidateContinuousScrollWindowCache();
    emit('update:effectiveZoom', value);
}, { immediate: true });

watch(zoomMode, () => {
    continuousScrollController.invalidateContinuousScrollWindowCache();
});

watch(renderedPageNumbers, async () => {
    if (!import.meta.client || !isActive.value || totalPages.value <= 0) {
        return;
    }

    await nextTick();
    djvuPreviewRuntime.syncLoadedPages();
}, { flush: 'post' });

watch([
    currentPage,
    viewMode,
], async () => {
    if (!import.meta.client || !isActive.value || totalPages.value <= 0 || isContinuousScroll.value) {
        return;
    }

    await nextTick();
    scrollActiveSpreadIntoView();
}, { flush: 'post' });

watch(
    isActive,
    (active) => {
        if (!active) {
            pageFlipWheelController.clearWheelAccumulator();
            continuousScrollController.cancelViewportSync();
        }
    },
);

watch(
    [
        effectiveZoom,
        totalPages,
    ],
    async () => {
        if (!import.meta.client || !isActive.value || totalPages.value <= 0) {
            return;
        }

        await nextTick();
        syncHorizontalScrollForZoomMode();
        djvuPreviewRuntime.scheduleSettledPreviewRerender();
        continuousScrollController.scheduleViewportSync();
    },
    { flush: 'post' },
);

function handleContainerResize() {
    if (!isActive.value) {
        return;
    }
    measureContainer();
    djvuPreviewRuntime.scheduleSettledPreviewRerender();
    continuousScrollController.scheduleViewportSync();
}

onMounted(measureContainer);

useResizeObserver(viewerContainer, handleContainerResize);

onBeforeUnmount(() => {
    continuousScrollController.dispose();
    djvuPreviewRuntime.dispose();
});

function scrollToPage(pageNumber: number) {
    const normalizedPage = clamp(pageNumber, 1, totalPages.value || 1);

    if (!isContinuousScroll.value) {
        currentPage.value = normalizedPage;
        emit('update:currentPage', normalizedPage);
        pageFlipWheelController.clearWheelAccumulator();
        void nextTick().then(() => {
            scrollActiveSpreadIntoView();
            djvuPreviewRuntime.syncLoadedPages();
        });
        return;
    }

    continuousScrollController.scrollToContinuousPage(normalizedPage);
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
            pageSelector: DJVU_PAGE_SNAPSHOT_SELECTOR,
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
        continuousScrollController.invalidateContinuousScrollWindowCache();
    }

    void nextTick(() => {
        continuousScrollController.beginProgrammaticScrollGuard();
        restorePageAnchorScrollSnapshot(
            viewerContainer.value,
            snapshot,
            { pageSelector: DJVU_PAGE_SNAPSHOT_SELECTOR },
        );
        continuousScrollController.updateScrollPositionFromContainer();
        continuousScrollController.detectCurrentPageFromViewport();
        djvuPreviewRuntime.syncLoadedPages();
    });
}

defineExpose<IDocumentViewerExpose>({
    getViewerContainer: () => viewerContainer.value,
    getCurrentPage: () => currentPage.value,
    scrollToPage,
    captureScrollSnapshot,
    restoreScrollSnapshot,
    invalidatePages: (pages: number[]) => {
        for (const pageNumber of pages) {
            if (pageNumber < 1 || pageNumber > totalPages.value) {
                continue;
            }
            djvuPreviewRuntime.resetPageState(pageNumber);
        }
        djvuPreviewRuntime.syncLoadedPages();
    },
    requestScrollToCurrentResult: () => {
        scrollToPage(currentPage.value);
    },
});
</script>

<style scoped>
.djvu-viewer-container,
.djvu-continuous-surface,
.djvu-page-shell {
    overflow-anchor: none;
}

.djvu-continuous-surface {
    position: relative;
}

.djvu-page-shell {
    position: relative;
    box-sizing: border-box;
    overflow: hidden;
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-lg);
    background: var(--ui-bg);
    box-shadow: var(--shadow-popup);
}

.djvu-page-shell--continuous {
    position: absolute;
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

.djvu-page-skeleton {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    background:
        linear-gradient(
            180deg,
            color-mix(in oklab, var(--ui-bg) 96%, var(--ui-bg-muted) 4%),
            color-mix(in oklab, var(--ui-bg) 90%, var(--ui-bg-muted) 10%)
        );
}

.djvu-page-skeleton-content {
    display: flex;
    height: 100%;
    width: 100%;
    flex-direction: column;
    gap: clamp(var(--app-space-10xl), 2%, var(--app-space-16xl));
    padding: clamp(var(--app-space-16xl), 8%, calc(var(--app-space-16xl) * 3));
    animation: djvu-page-skeleton-pulse 0.95s ease-in-out infinite;
}

.djvu-page-skeleton-header,
.djvu-page-skeleton-group {
    display: flex;
    flex-direction: column;
    gap: var(--app-space-8xl);
}

.djvu-page-skeleton-title,
.djvu-page-skeleton-subtitle,
.djvu-page-skeleton-line {
    border-radius: var(--app-radius-full);
}

.djvu-page-skeleton-title {
    height: var(--app-space-16xl);
    width: 62%;
}

.djvu-page-skeleton-subtitle {
    height: var(--app-space-11xl);
    width: 44%;
    opacity: 0.78;
}

.djvu-page-skeleton-line {
    height: var(--app-space-12xl);
    width: 100%;
}

.djvu-page-skeleton-line--short {
    width: 78%;
}

.djvu-page-number {
    position: absolute;
    right: 0.75rem;
    bottom: 0.75rem;
    border-radius: var(--app-radius-full);
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

@keyframes djvu-page-skeleton-pulse {
    0%,
    100% {
        opacity: 0.5;
    }

    50% {
        opacity: 1;
    }
}

@media (prefers-reduced-motion: reduce) {
    .djvu-page-skeleton-content {
        animation: none;
    }
}

</style>
