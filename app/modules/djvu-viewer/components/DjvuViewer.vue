<template>
    <div class="relative h-full w-full">
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

        <PdfInitialSurfacePlaceholder
            v-if="showInitialSurfacePlaceholder"
            class="djvu-viewer-initial-placeholder"
        />

        <div
            ref="viewerContainer"
            class="djvu-viewer-container h-full w-full overflow-auto app-scrollbar"
            :class="{
                'cursor-grab': dragMode,
                'cursor-default': !dragMode,
                'djvu-viewer-container--initial-visual-pending': showInitialSurfacePlaceholder,
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
                    <DjvuPageContent
                        :page-number="pageNumber"
                        :page-state="pageStates[pageNumber - 1]"
                        @retry="retryPage(pageNumber)"
                    />
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
import type { IScrollSnapshot } from '@app/types/pdfUi';
import type { IDjvuPageSize } from '@app/platform/browser-api/public';
import type { IDocumentViewerExpose } from '@app/modules/pdf-viewer/public';
import { PdfInitialSurfacePlaceholder } from '@app/modules/pdf-viewer/public/component-exports/pdfInitialSurfacePlaceholder';
import DjvuPageContent from '@app/modules/djvu-viewer/components/DjvuPageContent.vue';
import {
    useDjvuPreviewRuntime,
    type IDjvuPageState,
} from '@app/modules/djvu-viewer/runtime/useDjvuPreviewRuntime';
import {
    useDjvuViewportController,
    type IDjvuViewportController,
} from '@app/modules/djvu-viewer/runtime/useDjvuViewportController';
import { useDjvuPageFlipWheelController } from '@app/modules/djvu-viewer/runtime/useDjvuPageFlipWheelController';
import { useDjvuViewerLayout } from '@app/modules/djvu-viewer/runtime/useDjvuViewerLayout';

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
    'initial-visual-pending': [];
    'initial-visual-ready': [payload: {pageNumber: number;}];
}>();

const { t } = useTypedI18n();
const DJVU_BASE_MARGIN = 16;
const DJVU_CONTINUOUS_OVERSCAN_VIEWPORTS = 2;
const DJVU_CONTINUOUS_RENDER_MARGIN_PAGES = 3;
const DJVU_PAGE_SNAPSHOT_SELECTOR = '[data-page-number]';

const viewerContainer = ref<HTMLElement | null>(null);
const pageElements = new Map<number, HTMLElement>();
const pageSizes = ref<IDjvuPageSize[]>([]);
const pageStates = ref<IDjvuPageState[]>([]);
const totalPages = computed(() => pageSizes.value.length);
const currentPage = ref(1);
const viewerError = ref<string | null>(null);
const isLoading = ref(Boolean(src));
const containerWidth = ref(0);
const containerHeight = ref(0);
const dragMode = computed(() => dragModeProp ?? false);
const isActive = computed(() => isActiveProp);
const isContinuousScroll = computed(() => continuousScrollProp ?? true);
const viewMode = computed<TPdfViewMode>(() => viewModeProp ?? 'single');
const zoomMode = computed(() => zoomModeProp ?? (
    fitMode === 'height' ? 'fit-height' : 'fit-width'
));

function getRenderedPageNumbers() {
    return djvuViewportController.renderedPageNumbers.value;
}

const manualZoom = computed(() => {
    const candidate = zoom ?? 1;
    if (!Number.isFinite(candidate) || candidate <= 0) {
        return 1;
    }
    return candidate;
});

const {
    continuousScrollSurfaceWidth,
    effectiveZoom,
    getNeededDeviceWidth,
    getPageDisplayScale,
    syncHorizontalScrollForZoomMode,
} = useDjvuViewerLayout({
    containerHeight,
    containerWidth,
    currentPage,
    getRenderedPageNumbers,
    isContinuousScroll,
    manualZoom,
    pageSizes,
    totalPages,
    viewMode,
    viewerContainer,
    zoomMode,
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
    djvuViewportController.invalidateContinuousScrollWindowCache();
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
                top: `${djvuViewportController.getContinuousPageTop(pageNumber)}px`,
            }
            : {}),
    };
}

function scrollActiveSpreadIntoView() {
    const container = viewerContainer.value;
    if (!isActive.value || !container || isContinuousScroll.value) {
        return;
    }

    container.scrollTop = 0;
    syncHorizontalScrollForZoomMode();
}

const djvuViewportController: IDjvuViewportController = useDjvuViewportController({
    clearPageFlipWheelAccumulator: () => pageFlipWheelController.clearWheelAccumulator(),
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
    scrollActiveSpreadIntoView,
    syncLoadedPages: syncRuntimeLoadedPages,
    totalPages,
    viewMode,
    viewerContainer,
});

const renderedPageNumbers = computed(getRenderedPageNumbers);
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

const renderedPagesSurfaceStyle = computed(() => {
    if (!isContinuousScroll.value) {
        return {};
    }

    return {
        height: `${Math.max(containerHeight.value, djvuViewportController.getContinuousDocumentHeight(), 1)}px`,
        width: `${continuousScrollSurfaceWidth.value}px`,
    };
});
const showInitialSurfacePlaceholder = computed(() => isLoading.value && !viewerError.value);

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
        resolveContinuousScrollWindow: djvuViewportController.resolveContinuousScrollWindow,
        scrollDirection: djvuViewportController.scrollDirection,
        totalPages,
        getInitialVisualPageNumbers: () => renderedPageNumbers.value,
    },
    effects: {
        clearPageElements: () => pageElements.clear(),
        emitCurrentPage: pageNumber => emit('update:currentPage', pageNumber),
        emitDocument: value => emit('update:document', value),
        emitInitialVisualPending: () => emit('initial-visual-pending'),
        emitInitialVisualReady: payload => emit('initial-visual-ready', payload),
        emitLoading: value => emit('loading', value),
        emitTotalPages: value => emit('update:totalPages', value),
        invalidateContinuousScrollWindowCache: djvuViewportController.invalidateContinuousScrollWindowCache,
        measureContainer,
        resetScrollState: djvuViewportController.resetScrollState,
        resetViewerScrollPosition: djvuViewportController.resetContainerScrollPosition,
        scheduleViewportSync: djvuViewportController.scheduleViewportSync,
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

    if (djvuViewportController.handleViewerScroll()) {
        djvuPreviewRuntime.scheduleScrollSettledPreviewRerender();
    }
}

function handleViewerWheel(event: WheelEvent) {
    if (
        djvuViewportController.handleProjectedWheelScroll(event)
    ) {
        djvuPreviewRuntime.scheduleScrollSettledPreviewRerender();
    }
    pageFlipWheelController.handleViewerWheel(event);
}

function retryPage(pageNumber: number) {
    djvuPreviewRuntime.retryPage(pageNumber);
}

watch(effectiveZoom, (value) => {
    djvuViewportController.notifyZoomChanged('zoom');
    emit('update:effectiveZoom', value);
}, { immediate: true });

watch(zoomMode, () => {
    djvuViewportController.notifyZoomChanged('zoom-mode');
});

watch([
    effectiveZoom,
    zoomMode,
], ([
    nextZoom,
    nextZoomMode,
], [
    previousZoom,
    previousZoomMode,
]) => {
    if (
        !import.meta.client
        || !isActive.value
        || !isContinuousScroll.value
        || totalPages.value <= 0
        || isLoading.value
    ) {
        return;
    }

    const zoomModeChanged = nextZoomMode !== previousZoomMode;
    const customZoomChanged = nextZoomMode === 'custom' && nextZoom !== previousZoom;
    if (!zoomModeChanged && !customZoomChanged) {
        return;
    }

    const snapshot = captureScrollSnapshot();
    if (!snapshot) {
        return;
    }

    djvuViewportController.restoreScrollSnapshot(snapshot, { fallbackPage: currentPage.value });
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
            djvuViewportController.cancelViewportWork('inactive');
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
        djvuViewportController.scheduleViewportSync();
    },
    { flush: 'post' },
);

function handleContainerResize() {
    if (!isActive.value) {
        return;
    }
    measureContainer();
    djvuPreviewRuntime.scheduleSettledPreviewRerender();
    djvuViewportController.scheduleViewportSync();
}

onMounted(measureContainer);

useResizeObserver(viewerContainer, handleContainerResize);

onBeforeUnmount(() => {
    djvuViewportController.dispose();
    djvuPreviewRuntime.dispose();
});

function scrollToPage(pageNumber: number) {
    djvuViewportController.scrollToPage(pageNumber);
}

function captureScrollSnapshot(): IScrollSnapshot | null {
    return djvuViewportController.captureScrollSnapshot();
}

function restoreScrollSnapshot(
    snapshot: IScrollSnapshot | null,
    options?: { fallbackPage?: number | null },
) {
    djvuViewportController.restoreScrollSnapshot(snapshot, options);
}

defineExpose<IDocumentViewerExpose>({
    getViewerContainer: () => viewerContainer.value,
    getCurrentPage: () => currentPage.value,
    waitForViewerLoadSettled: djvuPreviewRuntime.waitForViewerLoadSettled,
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

.djvu-viewer-container--initial-visual-pending {
    overflow: hidden;
    pointer-events: none;
}

.djvu-viewer-container--initial-visual-pending > div {
    visibility: hidden;
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

</style>
