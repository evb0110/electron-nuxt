<template>
  <div
    ref="containerRef"
    class="pdf-thumbnails app-scrollbar"
    :class="{
      'is-reorder-dragging': isDragging,
      'is-external-drag': isExternalDragOver,
    }"
    @scroll.passive="handleContainerScroll"
    @wheel.passive="handleContainerWheel"
    @pointerdown="handleContainerPointerDown"
    @dragenter="handleExternalDragEnter"
    @dragover="handleExternalDragOver"
    @dragleave="handleExternalDragLeave"
    @drop="handleExternalDrop"
  >
    <div class="pdf-thumbnails-virtual-wrapper" :style="virtualWrapperStyle">
      <div
        v-for="page in virtualPages"
        :key="page"
        class="pdf-thumbnail pdf-thumbnail--virtual"
        :class="{
          'is-active': page === currentPage,
          'is-selected': isSelected(page),
          'is-dragged': isDragging && draggedPages.includes(page),
          'is-drop-before': dropInsertIndex === page - 1,
          'is-drop-after': page === totalPages && dropInsertIndex === totalPages,
        }"
        :data-page="page"
        :style="getThumbnailStyle(page)"
        @mousedown="handleDragMouseDown($event, page)"
        @click="handleThumbnailClick($event, page)"
        @contextmenu.prevent="handleThumbnailContextMenu($event, page)"
      >
        <canvas class="pdf-thumbnail-canvas" />
        <span class="pdf-thumbnail-number">{{ getPageIndicator(page) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">

import {
    useDebounceFn,
    useResizeObserver,
} from '@vueuse/core';
import type { TDocumentRef } from '@contracts/platform-api';
import type {
    PDFDocumentProxy,
    RenderTask,
} from 'pdfjs-dist';
import { isPdfDocumentUsable } from '@app/utils/pdf-document-guard';
import { BrowserLogger } from '@app/utils/browser-logger';
import { formatPageIndicator } from '@app/utils/pdf-page-labels';
import {
    arePageNumberListsEqual,
    normalizeSelectedPageNumbers,
} from '@app/utils/pdf-page-selection';
import { THUMBNAIL_WIDTH } from '@app/constants/pdf-layout';
import { buildThumbnailRenderQueue } from '@app/components/pdf/pdfThumbnailRenderQueue';
import { useMultiSelection } from '@app/composables/useMultiSelection';
import { usePageDragDrop } from '@app/composables/pdf/usePageDragDrop';
import { runGuardedTask } from '@app/utils/async-guard';

interface IProps {
    pdfDocument: PDFDocumentProxy | null;
    currentPage: number;
    totalPages: number;
    pageLabels?: string[] | null;
    selectedPages?: number[];
    invalidationRequest?: {
        id: number;
        pages: number[];
    } | null;
}

const THUMBNAIL_GAP = 8;
const DEFAULT_THUMBNAIL_ITEM_HEIGHT = 220;
const THUMBNAIL_ITEM_VERTICAL_PADDING = 8;
const THUMBNAIL_ITEM_CONTENT_GAP = 4;
const THUMBNAIL_NUMBER_LINE_HEIGHT = 16;
const THUMBNAIL_CANVAS_BORDER_WIDTH = 2;
const VIRTUAL_OVERSCAN = 8;
const THUMBNAIL_RENDER_CONCURRENCY = 2;
const IMMEDIATE_RENDER_RADIUS = 2;
const PREFETCH_RENDER_RADIUS = 4;
const MAX_THUMBNAIL_OUTPUT_SCALE = 2;
const AUTO_SYNC_COMFORT_PADDING_MIN_PX = 16;
const AUTO_SYNC_COMFORT_PADDING_MAX_PX = 48;
const AUTO_SYNC_INTERACTION_COOLDOWN_MS = 700;
const AUTO_SYNC_PROGRAMMATIC_SCROLL_GUARD_MS = 160;
const THUMBNAIL_LOG_SECTION = 'pdf-thumbnails';

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'go-to-page', page: number): void;
    (e: 'update:selected-pages', pages: number[]): void;
    (
        e: 'page-context-menu',
        payload: {
            clientX: number;
            clientY: number;
            pages: number[];
        },
    ): void;
    (e: 'reorder', newOrder: number[]): void;
    (
        e: 'file-drop',
        payload: {
            afterPage: number;
            filePaths: TDocumentRef[];
        },
    ): void;
}>();

const containerRef = ref<HTMLElement | null>(null);
const renderingPages = new Set<number>();
const renderTasks = new Map<number, RenderTask>();
const renderedCanvases = new Map<number, HTMLCanvasElement>();
const renderingCanvases = new Map<number, HTMLCanvasElement>();
let renderRunId = 0;
let pendingInvalidation: number[] | null = null;
let reloadTransition = false;
let containerVisibilityState: 'unknown' | 'visible' | 'hidden' = 'unknown';
let measurementState: 'ready' | 'no-item' | 'no-rendered-canvas' = 'ready';
let hasResolvedThumbnailItemHeight = false;
let lastUserInteractionAtMs = 0;
let lastUserInteractionLogAtMs = 0;
let lastUserInteractionReason: string | null = null;
let lastProgrammaticScrollAtMs = 0;
let currentPageSyncRunId = 0;

const scrollTop = ref(0);
const viewportHeight = ref(0);
const thumbnailItemHeight = ref(DEFAULT_THUMBNAIL_ITEM_HEIGHT);

const multiSelection = useMultiSelection<number>();
const selectedPagesSet = computed(() => new Set(props.selectedPages ?? []));

const itemPitch = computed(() =>
    Math.max(1, thumbnailItemHeight.value + THUMBNAIL_GAP),
);

const visibleStartIndex = computed(() => {
    if (props.totalPages <= 0) {
        return 0;
    }
    return Math.max(
        0,
        Math.floor(scrollTop.value / itemPitch.value) - VIRTUAL_OVERSCAN,
    );
});

const visibleEndIndex = computed(() => {
    if (props.totalPages <= 0) {
        return -1;
    }
    const viewportBottom = scrollTop.value + Math.max(viewportHeight.value, itemPitch.value);
    return Math.min(
        props.totalPages - 1,
        Math.ceil(viewportBottom / itemPitch.value) + VIRTUAL_OVERSCAN,
    );
});

const virtualPages = computed(() => {
    if (props.totalPages <= 0 || visibleEndIndex.value < visibleStartIndex.value) {
        return [] as number[];
    }

    const pages: number[] = [];
    for (let index = visibleStartIndex.value; index <= visibleEndIndex.value; index += 1) {
        pages.push(index + 1);
    }
    return pages;
});

const virtualWrapperStyle = computed(() => {
    if (props.totalPages <= 0) {
        return {height: '0px'};
    }
    const totalHeight = props.totalPages * itemPitch.value - THUMBNAIL_GAP;
    return {height: `${Math.max(0, totalHeight)}px`};
});

function getThumbnailStyle(page: number) {
    return {transform: `translateY(${(page - 1) * itemPitch.value}px)`};
}

const {
    isDragging,
    isExternalDragOver,
    draggedPages,
    dropInsertIndex,
    handleMouseDown: handleDragMouseDown,
    consumeClickSkip,
    handleDragEnter: handleExternalDragEnter,
    handleDragOver: handleExternalDragOver,
    handleDragLeave: handleExternalDragLeave,
    handleDrop: handleExternalDrop,
} = usePageDragDrop({
    containerRef,
    totalPages: toRef(props, 'totalPages'),
    selectedPages: computed(() => props.selectedPages ?? []),
    resolveDropIndex: (clientY, container) => {
        const rect = container.getBoundingClientRect();
        const offsetY = clientY - rect.top + container.scrollTop;
        const index = Math.floor(offsetY / itemPitch.value);
        return Math.max(0, Math.min(props.totalPages, index));
    },
    onReorder: (newOrder) => emit('reorder', newOrder),
    onExternalFileDrop: (afterPage, filePaths) =>
        emit('file-drop', {
            afterPage,
            filePaths,
        }),
});


function isSelected(page: number) {
    return selectedPagesSet.value.has(page);
}

function handleThumbnailClick(event: MouseEvent, page: number) {
    if (consumeClickSkip()) {
        return;
    }

    const allPages = Array.from({ length: props.totalPages }, (_, i) => i + 1);
    multiSelection.toggle(page, allPages, {
        shift: event.shiftKey,
        meta: event.metaKey || event.ctrlKey,
    });
    const normalized = normalizeSelectedPageNumbers(
        Array.from(multiSelection.selected.value),
        props.totalPages,
    );
    emit('update:selected-pages', normalized);
    emit('go-to-page', page);
}

function handleThumbnailContextMenu(event: MouseEvent, page: number) {
    if (!isSelected(page)) {
        multiSelection.selected.value = new Set([page]);
        multiSelection.anchor.value = page;
        emit('update:selected-pages', [page]);
    }
    const pages = normalizeSelectedPageNumbers(
        Array.from(multiSelection.selected.value),
        props.totalPages,
    );
    emit('page-context-menu', {
        clientX: event.clientX,
        clientY: event.clientY,
        pages,
    });
}

function getCanvas(pageNum: number): HTMLCanvasElement | null {
    if (!containerRef.value) {
        return null;
    }
    const thumbnail = containerRef.value.querySelector<HTMLElement>(
        `.pdf-thumbnail[data-page="${pageNum}"]`,
    );
    return thumbnail?.querySelector('canvas') ?? null;
}

function getThumbnailElement(pageNum: number) {
    if (!containerRef.value) {
        return null;
    }
    return containerRef.value.querySelector<HTMLElement>(
        `.pdf-thumbnail[data-page="${pageNum}"]`,
    );
}

function getPageIndicator(page: number) {
    return formatPageIndicator(page, props.pageLabels ?? null);
}

function isCanvasRendered(canvas: HTMLCanvasElement | null) {
    return canvas?.dataset.thumbnailRendered === 'true';
}

function isCurrentThumbnailCanvasRendered(pageNum: number) {
    const canvas = getCanvas(pageNum);
    if (!canvas) {
        return false;
    }

    return renderedCanvases.get(pageNum) === canvas
        && isCanvasRendered(canvas);
}

function isCurrentThumbnailCanvasRendering(pageNum: number) {
    const canvas = getCanvas(pageNum);
    if (!canvas) {
        return false;
    }

    return renderingPages.has(pageNum)
        && renderingCanvases.get(pageNum) === canvas;
}

function roundMetric(value: number) {
    return Number(value.toFixed(2));
}

function resolveThumbnailOutputScale() {
    if (typeof window === 'undefined' || window.devicePixelRatio <= 0) {
        return 1;
    }

    return Math.min(MAX_THUMBNAIL_OUTPUT_SCALE, window.devicePixelRatio);
}

function resolveThumbnailItemHeightFromCanvasHeight(canvasHeight: number) {
    return Math.ceil(canvasHeight)
        + THUMBNAIL_ITEM_VERTICAL_PADDING
        + THUMBNAIL_ITEM_CONTENT_GAP
        + THUMBNAIL_NUMBER_LINE_HEIGHT
        + THUMBNAIL_CANVAS_BORDER_WIDTH;
}

function updateThumbnailItemHeight(
    nextHeight: number,
    reason: string,
    data: Record<string, unknown> = {},
) {
    if (!Number.isFinite(nextHeight) || nextHeight <= 0) {
        return false;
    }

    const normalizedHeight = Math.max(1, Math.ceil(nextHeight));
    if (
        hasResolvedThumbnailItemHeight
        && normalizedHeight <= thumbnailItemHeight.value
    ) {
        return false;
    }

    const previousHeight = thumbnailItemHeight.value;
    thumbnailItemHeight.value = normalizedHeight;
    hasResolvedThumbnailItemHeight = true;

    BrowserLogger.warn(THUMBNAIL_LOG_SECTION, 'Thumbnail item height changed', {
        reason,
        previousHeight: roundMetric(previousHeight),
        nextHeight: roundMetric(thumbnailItemHeight.value),
        itemPitch: roundMetric(itemPitch.value),
        currentPage: props.currentPage,
        totalPages: props.totalPages,
        ...data,
    });

    return true;
}

function describeContainerGeometry(container: HTMLElement) {
    const rect = container.getBoundingClientRect();
    return {
        scrollTop: roundMetric(container.scrollTop),
        clientWidth: roundMetric(container.clientWidth),
        clientHeight: roundMetric(container.clientHeight),
        rectWidth: roundMetric(rect.width),
        rectHeight: roundMetric(rect.height),
    };
}

function markUserInteraction(reason: string) {
    const now = Date.now();
    lastUserInteractionAtMs = now;
    if (
        reason === lastUserInteractionReason
        && (now - lastUserInteractionLogAtMs) < AUTO_SYNC_PROGRAMMATIC_SCROLL_GUARD_MS
    ) {
        return;
    }

    lastUserInteractionReason = reason;
    lastUserInteractionLogAtMs = now;
    BrowserLogger.warn(THUMBNAIL_LOG_SECTION, 'Thumbnail user interaction detected', {
        reason,
        currentPage: props.currentPage,
        totalPages: props.totalPages,
    });
}

function isRecentProgrammaticScroll() {
    return (Date.now() - lastProgrammaticScrollAtMs) < AUTO_SYNC_PROGRAMMATIC_SCROLL_GUARD_MS;
}

function isCurrentPageAutoSyncSuppressed() {
    return (Date.now() - lastUserInteractionAtMs) < AUTO_SYNC_INTERACTION_COOLDOWN_MS;
}

function getComfortPaddingPx(container: HTMLElement) {
    return Math.min(
        AUTO_SYNC_COMFORT_PADDING_MAX_PX,
        Math.max(
            AUTO_SYNC_COMFORT_PADDING_MIN_PX,
            Math.round(container.clientHeight * 0.12),
        ),
    );
}

function getPageBounds(page: number) {
    const top = Math.max(0, (page - 1) * itemPitch.value);
    const height = Math.max(1, thumbnailItemHeight.value);
    return {
        top,
        bottom: top + height,
        height,
    };
}

function getMaxScrollTop(container: HTMLElement) {
    return Math.max(0, container.scrollHeight - container.clientHeight);
}

function isPageWithinComfortViewport(container: HTMLElement, page: number) {
    const {
        top,
        bottom,
    } = getPageBounds(page);
    const comfortPadding = getComfortPaddingPx(container);
    const viewportTop = container.scrollTop;
    const viewportBottom = viewportTop + container.clientHeight;
    const comfortTop = viewportTop + comfortPadding;
    const comfortBottom = viewportBottom - comfortPadding;

    return top >= comfortTop && bottom <= comfortBottom;
}

function resolveCurrentPageSyncScrollTop(container: HTMLElement, page: number) {
    if (container.clientHeight <= 0) {
        return null;
    }

    const {
        top,
        bottom,
        height,
    } = getPageBounds(page);
    const comfortPadding = getComfortPaddingPx(container);
    const viewportTop = container.scrollTop;
    const viewportBottom = viewportTop + container.clientHeight;
    const comfortTop = viewportTop + comfortPadding;
    const comfortBottom = viewportBottom - comfortPadding;
    const maxScrollTop = getMaxScrollTop(container);

    if (top >= comfortTop && bottom <= comfortBottom) {
        return null;
    }

    if (bottom <= viewportTop || top >= viewportBottom) {
        const centeredScrollTop = top - Math.max(0, (container.clientHeight - height) / 2);
        return Math.max(0, Math.min(maxScrollTop, centeredScrollTop));
    }

    if (top < comfortTop) {
        return Math.max(0, Math.min(maxScrollTop, top - comfortPadding));
    }

    return Math.max(0, Math.min(maxScrollTop, bottom + comfortPadding - container.clientHeight));
}

function isContainerVisible(container: HTMLElement) {
    const rect = container.getBoundingClientRect();
    return (
        container.clientWidth > 0
        && container.clientHeight > 0
        && rect.width > 0
        && rect.height > 0
    );
}

function resolveVisibleContainer(reason: string) {
    const container = containerRef.value;
    if (!container) {
        if (containerVisibilityState !== 'unknown') {
            BrowserLogger.warn(THUMBNAIL_LOG_SECTION, 'Thumbnail container detached', {
                reason,
                stateBeforeDetach: containerVisibilityState,
                currentPage: props.currentPage,
                totalPages: props.totalPages,
            });
            containerVisibilityState = 'unknown';
        }
        return null;
    }

    const isVisible = isContainerVisible(container);
    const nextState = isVisible ? 'visible' : 'hidden';
    if (containerVisibilityState !== nextState) {
        containerVisibilityState = nextState;
        BrowserLogger.warn(THUMBNAIL_LOG_SECTION, nextState === 'visible'
            ? 'Thumbnail container became visible'
            : 'Thumbnail container became hidden', {
            reason,
            currentPage: props.currentPage,
            totalPages: props.totalPages,
            geometry: describeContainerGeometry(container),
            itemHeight: roundMetric(thumbnailItemHeight.value),
            renderedPages: renderedCanvases.size,
            renderingPages: renderingPages.size,
        });
    }

    if (!isVisible) {
        return null;
    }

    return container;
}

function updateViewportMetrics() {
    const container = resolveVisibleContainer('update-viewport-metrics');
    if (!container) {
        return;
    }
    const previousViewportHeight = viewportHeight.value;
    scrollTop.value = container.scrollTop;
    viewportHeight.value = container.clientHeight;
    if (Math.abs(previousViewportHeight - viewportHeight.value) >= 1) {
        BrowserLogger.warn(THUMBNAIL_LOG_SECTION, 'Thumbnail viewport height changed', {
            previousViewportHeight: roundMetric(previousViewportHeight),
            nextViewportHeight: roundMetric(viewportHeight.value),
            currentPage: props.currentPage,
            totalPages: props.totalPages,
            geometry: describeContainerGeometry(container),
        });
    }
}

async function syncCurrentPageIntoView(reason: string) {
    const container = resolveVisibleContainer(`current-page-sync:${reason}`);
    if (!container || props.totalPages <= 0) {
        return;
    }
    if (isDragging.value || isExternalDragOver.value || isCurrentPageAutoSyncSuppressed()) {
        return;
    }

    const targetScrollTop = resolveCurrentPageSyncScrollTop(container, props.currentPage);
    if (targetScrollTop === null || Math.abs(targetScrollTop - container.scrollTop) < 1) {
        return;
    }

    const syncRunId = ++currentPageSyncRunId;
    lastProgrammaticScrollAtMs = Date.now();
    container.scrollTop = targetScrollTop;
    updateViewportMetrics();
    void scheduleVisibleThumbnailRender();

    await nextTick();
    if (syncRunId !== currentPageSyncRunId) {
        return;
    }

    const thumbnail = getThumbnailElement(props.currentPage);
    if (!thumbnail || isPageWithinComfortViewport(container, props.currentPage)) {
        return;
    }

    const thumbnailTop = thumbnail.offsetTop;
    const thumbnailBottom = thumbnailTop + thumbnail.offsetHeight;
    const comfortPadding = getComfortPaddingPx(container);
    const refinedScrollTop = Math.max(
        0,
        Math.min(
            getMaxScrollTop(container),
            thumbnailBottom > (container.scrollTop + container.clientHeight - comfortPadding)
                ? thumbnailBottom + comfortPadding - container.clientHeight
                : thumbnailTop - comfortPadding,
        ),
    );
    if (Math.abs(refinedScrollTop - container.scrollTop) < 1) {
        return;
    }

    lastProgrammaticScrollAtMs = Date.now();
    container.scrollTop = refinedScrollTop;
    updateViewportMetrics();
    void scheduleVisibleThumbnailRender();
}

const measureThumbnailHeight = useDebounceFn(() => {
    const container = resolveVisibleContainer('measure-thumbnail-height');
    if (!container) {
        return;
    }

    const item = container.querySelector<HTMLElement>('.pdf-thumbnail');
    if (!item) {
        if (measurementState !== 'no-item') {
            measurementState = 'no-item';
            BrowserLogger.warn(THUMBNAIL_LOG_SECTION, 'Skipping thumbnail height measurement: no thumbnail items', {
                currentPage: props.currentPage,
                totalPages: props.totalPages,
                geometry: describeContainerGeometry(container),
            });
        }
        return;
    }

    const renderedItem = Array.from(
        container.querySelectorAll<HTMLElement>('.pdf-thumbnail'),
    ).find((candidate) => {
        const candidateCanvas = candidate.querySelector<HTMLCanvasElement>('canvas');
        return Boolean(
            candidateCanvas
            && candidateCanvas.width > 0
            && candidateCanvas.height > 0
            && candidateCanvas.getBoundingClientRect().height > 0,
        );
    });
    const measurementItem = renderedItem ?? item;
    const canvas = measurementItem.querySelector<HTMLCanvasElement>('canvas');
    if (
        !renderedItem
        || !canvas
    ) {
        if (measurementState !== 'no-rendered-canvas') {
            measurementState = 'no-rendered-canvas';
            BrowserLogger.warn(THUMBNAIL_LOG_SECTION, 'Skipping thumbnail height measurement: no rendered canvas in virtual window yet', {
                currentPage: props.currentPage,
                totalPages: props.totalPages,
                geometry: describeContainerGeometry(container),
                itemPage: measurementItem.dataset.page ?? null,
                canvasWidth: canvas?.width ?? null,
                canvasHeight: canvas?.height ?? null,
            });
        }
        return;
    }

    if (measurementState !== 'ready') {
        measurementState = 'ready';
        BrowserLogger.warn(THUMBNAIL_LOG_SECTION, 'Thumbnail height measurement resumed with rendered canvas', {
            currentPage: props.currentPage,
            totalPages: props.totalPages,
            itemPage: measurementItem.dataset.page ?? null,
            canvasWidth: canvas.width,
            canvasHeight: canvas.height,
        });
    }

    const measuredHeight = Math.max(1, Math.ceil(measurementItem.getBoundingClientRect().height));
    updateThumbnailItemHeight(measuredHeight, 'dom-measure', {
        geometry: describeContainerGeometry(container),
        itemPage: measurementItem.dataset.page ?? null,
    });
}, 16);

function handleContainerScroll() {
    if (!isRecentProgrammaticScroll()) {
        markUserInteraction('scroll');
    }
    updateViewportMetrics();
    void scheduleVisibleThumbnailRender();
}

function handleContainerWheel() {
    if (!isRecentProgrammaticScroll()) {
        markUserInteraction('wheel');
    }
}

function handleContainerPointerDown() {
    markUserInteraction('pointerdown');
}

watch(
    () => props.selectedPages,
    (pages) => {
        const normalized = normalizeSelectedPageNumbers(pages ?? [], props.totalPages);
        if (!arePageNumberListsEqual(normalized, pages ?? [])) {
            emit('update:selected-pages', normalized);
            return;
        }

        multiSelection.selected.value = new Set(normalized);

        if (normalized.length === 0) {
            multiSelection.anchor.value = null;
            return;
        }

        if (
            multiSelection.anchor.value === null ||
            !normalized.includes(multiSelection.anchor.value)
        ) {
            multiSelection.anchor.value = normalized[normalized.length - 1] ?? null;
        }
    },
    {
        immediate: true,
        deep: true,
    },
);

function cancelAllRenders() {
    for (const task of renderTasks.values()) {
        try {
            task.cancel();
        } catch {
            // Ignore cancellation errors
        }
    }
    renderTasks.clear();
    renderingPages.clear();
}

function cancelRenderForPage(page: number) {
    const task = renderTasks.get(page);
    if (task) {
        try {
            task.cancel();
        } catch {
            // Ignore cancellation errors
        }
        renderTasks.delete(page);
    }

    renderingPages.delete(page);
    renderingCanvases.delete(page);
}

function pruneDetachedThumbnailState() {
    const mountedPages = new Set(virtualPages.value);

    for (const [
        page,
        canvas,
    ] of renderedCanvases.entries()) {
        if (!mountedPages.has(page) || getCanvas(page) !== canvas) {
            renderedCanvases.delete(page);
        }
    }

    for (const [
        page,
        canvas,
    ] of renderingCanvases.entries()) {
        if (mountedPages.has(page) && getCanvas(page) === canvas) {
            continue;
        }

        cancelRenderForPage(page);
    }
}

async function renderThumbnail(
    pdfDocument: PDFDocumentProxy,
    pageNum: number,
    runId: number,
) {
    if (runId !== renderRunId) {
        return;
    }

    if (!isPdfDocumentUsable(pdfDocument)) {
        return;
    }

    const canvas = getCanvas(pageNum);
    if (!canvas) {
        return;
    }

    if (isCurrentThumbnailCanvasRendered(pageNum)) {
        return;
    }

    if (renderingPages.has(pageNum)) {
        const renderingCanvas = renderingCanvases.get(pageNum);
        if (renderingCanvas === canvas) {
            return;
        }

        const activeTask = renderTasks.get(pageNum);
        if (activeTask) {
            try {
                activeTask.cancel();
            } catch {
                // Ignore cancellation errors
            }
            renderTasks.delete(pageNum);
        }
        renderingPages.delete(pageNum);
        renderingCanvases.delete(pageNum);
    }

    delete canvas.dataset.thumbnailRendered;
    renderingPages.add(pageNum);
    renderingCanvases.set(pageNum, canvas);

    try {
        const page = await pdfDocument.getPage(pageNum);
        if (runId !== renderRunId || !isPdfDocumentUsable(pdfDocument)) {
            return;
        }
        const viewport = page.getViewport({ scale: 1 });
        const scale = THUMBNAIL_WIDTH / viewport.width;
        const scaledViewport = page.getViewport({ scale });
        const outputScale = resolveThumbnailOutputScale();
        const pixelWidth = Math.max(1, Math.round(scaledViewport.width * outputScale));
        const pixelHeight = Math.max(1, Math.round(scaledViewport.height * outputScale));
        const scaleX = pixelWidth / scaledViewport.width;
        const scaleY = pixelHeight / scaledViewport.height;
        updateThumbnailItemHeight(
            resolveThumbnailItemHeightFromCanvasHeight(scaledViewport.height),
            'render-viewport',
            {
                page: pageNum,
                outputScale: roundMetric(outputScale),
                viewportWidth: roundMetric(scaledViewport.width),
                viewportHeight: roundMetric(scaledViewport.height),
            },
        );

        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
        canvas.style.width = `${scaledViewport.width}px`;
        canvas.style.height = `${scaledViewport.height}px`;

        const context = canvas.getContext('2d');
        if (!context) {
            return;
        }

        const task = page.render({
            canvasContext: context,
            viewport: scaledViewport,
            canvas,
            transform: scaleX !== 1 || scaleY !== 1
                ? [
                    scaleX,
                    0,
                    0,
                    scaleY,
                    0,
                    0,
                ]
                : undefined,
        });
        renderTasks.set(pageNum, task);
        await task.promise;
        renderTasks.delete(pageNum);

        if (getCanvas(pageNum) !== canvas) {
            void scheduleVisibleThumbnailRender();
            return;
        }

        canvas.dataset.thumbnailRendered = 'true';
        renderedCanvases.set(pageNum, canvas);
        void measureThumbnailHeight();
        if (renderedCanvases.size === 1) {
            void scheduleVisibleThumbnailRender();
        }
    } catch (error) {
        renderTasks.delete(pageNum);
        if (
            error instanceof Error
            && error.name === 'RenderingCancelledException'
        ) {
            return;
        }
        if (runId !== renderRunId || !isPdfDocumentUsable(pdfDocument)) {
            return;
        }
        BrowserLogger.error(
            'pdf-thumbnails',
            `Failed to render thumbnail for page ${pageNum}`,
            error,
        );
    } finally {
        if (renderingCanvases.get(pageNum) === canvas) {
            renderingPages.delete(pageNum);
            renderingCanvases.delete(pageNum);
        }
    }
}

function buildRenderQueue(totalPages: number) {
    pruneDetachedThumbnailState();

    const currentRenderedPages = new Set(
        virtualPages.value.filter(page => isCurrentThumbnailCanvasRendered(page)),
    );
    const currentRenderingPages = new Set(
        virtualPages.value.filter(page => isCurrentThumbnailCanvasRendering(page)),
    );

    return buildThumbnailRenderQueue({
        totalPages,
        currentPage: props.currentPage,
        visiblePages: virtualPages.value,
        renderedPages: currentRenderedPages,
        renderingPages: currentRenderingPages,
        immediateRenderRadius: IMMEDIATE_RENDER_RADIUS,
        prefetchRenderRadius: PREFETCH_RENDER_RADIUS,
    }).filter((page) => (
        !isCurrentThumbnailCanvasRendered(page)
        && !isCurrentThumbnailCanvasRendering(page)
    ));
}

async function renderThumbnailQueue(
    pdfDocument: PDFDocumentProxy,
    pages: number[],
    runId: number,
) {
    if (pages.length === 0) {
        return;
    }

    const queue = [...pages];

    const workers = Array.from({length: Math.min(THUMBNAIL_RENDER_CONCURRENCY, queue.length)}, async () => {
        while (queue.length > 0) {
            if (runId !== renderRunId || !isPdfDocumentUsable(pdfDocument)) {
                return;
            }
            const pageNum = queue.shift();
            if (pageNum === undefined) {
                return;
            }
            await renderThumbnail(pdfDocument, pageNum, runId);
        }
    });

    await Promise.all(workers);
}

const scheduleVisibleThumbnailRender = useDebounceFn(() => {
    const doc = props.pdfDocument;
    const totalPages = props.totalPages;

    if (!doc || totalPages <= 0) {
        return;
    }
    if (!resolveVisibleContainer('schedule-visible-render')) {
        return;
    }

    const runId = renderRunId;
    const pages = buildRenderQueue(totalPages);

    runGuardedTask(() => renderThumbnailQueue(doc, pages, runId), {
        scope: 'pdf-thumbnails',
        message: 'Failed to render virtual thumbnail list',
    });
}, 20);

function clearRenderedState() {
    renderedCanvases.clear();
    renderingPages.clear();
    renderingCanvases.clear();
    renderTasks.clear();
    thumbnailItemHeight.value = DEFAULT_THUMBNAIL_ITEM_HEIGHT;
    hasResolvedThumbnailItemHeight = false;
    measurementState = 'ready';
}

watch(
    [
        () => props.pdfDocument,
        () => props.totalPages,
    ],
    ([
        doc,
        total,
    ], [oldDoc]) => {
        cancelAllRenders();
        renderRunId += 1;
        BrowserLogger.warn(THUMBNAIL_LOG_SECTION, 'Thumbnail source/watch cycle started', {
            hasDocument: Boolean(doc),
            hadDocument: Boolean(oldDoc),
            totalPages: total,
            renderRunId,
            reloadTransition,
            pendingInvalidation: pendingInvalidation?.slice(0, 24) ?? null,
            currentPage: props.currentPage,
        });

        if (!doc || total <= 0) {
            if (total <= 0) {
                clearRenderedState();
                reloadTransition = false;
            } else {
                reloadTransition = true;
            }
            return;
        }

        if (doc !== oldDoc) {
            if (reloadTransition && pendingInvalidation) {
                reloadTransition = false;
                for (const page of pendingInvalidation) {
                    renderedCanvases.delete(page);
                    renderingPages.delete(page);
                    renderingCanvases.delete(page);
                }
                pendingInvalidation = null;
            } else {
                reloadTransition = false;
                pendingInvalidation = null;
                clearRenderedState();
            }
        }

        void nextTick(() => {
            updateViewportMetrics();
            void scheduleVisibleThumbnailRender();
            void measureThumbnailHeight();
            void syncCurrentPageIntoView('document-ready');
        });
    },
    { immediate: true },
);

watch(
    () =>
        [
            props.currentPage,
            visibleStartIndex.value,
            visibleEndIndex.value,
        ] as const,
    () => {
        void scheduleVisibleThumbnailRender();
    },
);

watch(
    () => props.currentPage,
    () => {
        void scheduleVisibleThumbnailRender();
        void syncCurrentPageIntoView('current-page');
    },
    { immediate: true },
);

watch(
    () => thumbnailItemHeight.value,
    (nextHeight, previousHeight) => {
        if (Math.abs(nextHeight - previousHeight) < 1) {
            return;
        }
        void syncCurrentPageIntoView('thumbnail-measure');
    },
);

function invalidatePages(pages: number[]) {
    pendingInvalidation = pages;
    BrowserLogger.warn(THUMBNAIL_LOG_SECTION, 'Invalidating thumbnail pages', {
        pages: pages.slice(0, 40),
        totalPages: pages.length,
        renderRunId,
        currentPage: props.currentPage,
    });
    for (const page of pages) {
        renderedCanvases.delete(page);
        cancelRenderForPage(page);

        const canvas = getCanvas(page);
        if (canvas) {
            delete canvas.dataset.thumbnailRendered;
        }
    }

    void scheduleVisibleThumbnailRender();
}

watch(
    () => props.invalidationRequest?.id,
    () => {
        const pages = props.invalidationRequest?.pages;
        if (!pages || pages.length === 0) {
            return;
        }
        invalidatePages([...pages]);
    },
);

watch(
    containerRef,
    () => {
        updateViewportMetrics();
        void syncCurrentPageIntoView('container-ref');
    },
    { immediate: true },
);

watch(virtualPages, async () => {
    pruneDetachedThumbnailState();
    await nextTick();
    void measureThumbnailHeight();
    void scheduleVisibleThumbnailRender();
});

useResizeObserver(containerRef, () => {
    resolveVisibleContainer('resize-observer');
    updateViewportMetrics();
    void scheduleVisibleThumbnailRender();
    void measureThumbnailHeight();
    void syncCurrentPageIntoView('resize-observer');
});

onBeforeUnmount(() => {
    cancelAllRenders();
    renderRunId += 1;
    clearRenderedState();
});
</script>

<style scoped>
.pdf-thumbnails {
  position: relative;
  height: 100%;
  overflow: auto;
  padding: 8px;
}

.pdf-thumbnails-virtual-wrapper {
  position: relative;
}

.pdf-thumbnail {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: 4px;
  border: 1px solid transparent;
  cursor: pointer;
  transition:
    background-color 0.15s,
    border-color 0.15s;
}

.pdf-thumbnail--virtual {
  position: absolute;
  left: 0;
  right: 0;
}

.pdf-thumbnail:hover {
  background: var(--ui-bg-muted);
}

.pdf-thumbnail.is-active {
  background: var(--ui-bg-accented);
}

.pdf-thumbnail.is-active::before {
  content: "";
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 0;
  width: 3px;
  border-radius: 999px;
  background: var(--ui-primary);
}

.pdf-thumbnail.is-selected {
  border-color: var(--ui-primary);
  background: var(--ui-bg-elevated);
}

.pdf-thumbnail-canvas {
  display: block;
  height: auto;
  max-width: 100%;
  border: 1px solid var(--ui-border);
  border-radius: 2px;
  box-shadow: var(--app-pdf-thumbnail-shadow);
  transition: box-shadow 0.15s ease;
}

.pdf-thumbnail.is-active .pdf-thumbnail-canvas {
  box-shadow: var(--app-pdf-thumbnail-shadow-active);
}

.pdf-thumbnail-number {
  display: block;
  font-size: 12px;
  line-height: 16px;
  min-height: 16px;
  color: var(--ui-text-muted);
}

.pdf-thumbnail.is-active .pdf-thumbnail-number {
  color: var(--ui-primary);
  font-weight: 600;
}

.pdf-thumbnail.is-selected .pdf-thumbnail-number {
  color: var(--ui-primary);
}

.pdf-thumbnail.is-dragged {
  opacity: 0.35;
}

.pdf-thumbnail.is-drop-before::before {
  content: "";
  position: absolute;
  top: -5px;
  left: 8px;
  right: 8px;
  height: 2px;
  background: var(--ui-primary);
  border-radius: 1px;
}

.pdf-thumbnail.is-drop-after::after {
  content: "";
  position: absolute;
  bottom: -5px;
  left: 8px;
  right: 8px;
  height: 2px;
  background: var(--ui-primary);
  border-radius: 1px;
}

.pdf-thumbnails.is-reorder-dragging .pdf-thumbnail {
  cursor: grabbing;
}

.pdf-thumbnails.is-external-drag {
  outline: 2px dashed var(--ui-primary);
  outline-offset: -2px;
  border-radius: 4px;
}
</style>
