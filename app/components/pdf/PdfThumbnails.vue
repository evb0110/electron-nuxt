<template>
  <div
    ref="containerRef"
    tabindex="0"
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
    @keydown="handleContainerKeyDown"
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
        <canvas class="pdf-thumbnail-canvas" :style="thumbnailCanvasStyle" />
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
    PDFPageProxy,
    RenderTask,
} from 'pdfjs-dist';
import { isPdfDocumentUsable } from '@app/utils/pdf-document-guard';
import { BrowserLogger } from '@app/utils/browser-logger';
import { formatPageIndicator } from '@app/utils/pdf-page-labels';
import {
    arePageNumberListsEqual,
    normalizeSelectedPageNumbers,
    shouldSelectPageFromThumbnailClick,
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
    isActive?: boolean;
}

const THUMBNAIL_GAP = 8;
const DEFAULT_THUMBNAIL_ITEM_HEIGHT = 220;
const THUMBNAIL_WIDTH_CHANGE_THRESHOLD = 1;
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
const AUTO_SYNC_LAYOUT_RETRY_COUNT = 4;
const AUTO_SYNC_ACTIVATION_RETRY_DELAYS_MS = [
    0,
    50,
    150,
    350,
] as const;
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
let thumbnailSourceCycleId = 0;
let manualScrollSourceCycleId = -1;
const activePaneRefreshTimers = new Set<number>();

const scrollTop = ref(0);
const viewportHeight = ref(0);
const thumbnailItemHeight = ref(DEFAULT_THUMBNAIL_ITEM_HEIGHT);
const thumbnailRenderWidth = ref(THUMBNAIL_WIDTH);
const thumbnailAspectRatio = ref<number | null>(null);
const selectionFocusPage = ref<number | null>(null);

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

const thumbnailCanvasStyle = computed(() => {
    const aspectRatio = thumbnailAspectRatio.value;
    return aspectRatio && aspectRatio > 0
        ? {aspectRatio: `1 / ${aspectRatio}`}
        : {};
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
    handleExternalDrop,
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

function getThumbnailSelectionFallbackAnchor() {
    if (props.totalPages <= 0) {
        return null;
    }
    return clampPage(props.currentPage);
}

function handleThumbnailClick(event: MouseEvent, page: number) {
    if (consumeClickSkip()) {
        return;
    }

    if (!shouldSelectPageFromThumbnailClick(event)) {
        emit('go-to-page', page);
        return;
    }

    const allPages = Array.from({ length: props.totalPages }, (_, i) => i + 1);
    multiSelection.toggle(page, allPages, {
        shift: event.shiftKey,
        meta: event.metaKey || event.ctrlKey,
        fallbackAnchor: event.shiftKey ? getThumbnailSelectionFallbackAnchor() : null,
    });
    selectionFocusPage.value = page;
    const normalized = normalizeSelectedPageNumbers(
        Array.from(multiSelection.selected.value),
        props.totalPages,
    );
    emit('update:selected-pages', normalized);
}

function handleThumbnailContextMenu(event: MouseEvent, page: number) {
    if (!isSelected(page)) {
        multiSelection.selected.value = new Set([page]);
        multiSelection.anchor.value = page;
        selectionFocusPage.value = page;
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

function parseCssPixelValue(value: string) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function resolveHorizontalInset(style: CSSStyleDeclaration, ...properties: string[]) {
    return properties.reduce((total, property) => {
        const value = style.getPropertyValue(property);
        return total + parseCssPixelValue(value);
    }, 0);
}

function resolveThumbnailRenderWidth(container: HTMLElement) {
    const containerStyle = window.getComputedStyle(container);
    const containerContentWidth = container.clientWidth - resolveHorizontalInset(
        containerStyle,
        'padding-left',
        'padding-right',
    );
    const thumbnail = container.querySelector<HTMLElement>('.pdf-thumbnail');
    const thumbnailStyle = thumbnail
        ? window.getComputedStyle(thumbnail)
        : null;
    const thumbnailInset = thumbnailStyle
        ? resolveHorizontalInset(
            thumbnailStyle,
            'padding-left',
            'padding-right',
            'border-left-width',
            'border-right-width',
        )
        : 0;

    return Math.max(THUMBNAIL_WIDTH, Math.floor(containerContentWidth - thumbnailInset));
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

function resolveThumbnailItemHeightFromRenderWidth(renderWidth: number) {
    const aspectRatio = thumbnailAspectRatio.value;
    if (!aspectRatio || aspectRatio <= 0) {
        return thumbnailItemHeight.value;
    }

    return resolveThumbnailItemHeightFromCanvasHeight(renderWidth * aspectRatio);
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
    if (hasResolvedThumbnailItemHeight && normalizedHeight === thumbnailItemHeight.value) {
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

function updateThumbnailAspectRatio(
    viewportWidth: number,
    viewportHeightValue: number,
    reason: string,
    data: Record<string, unknown> = {},
) {
    if (viewportWidth <= 0 || viewportHeightValue <= 0) {
        return false;
    }

    const nextAspectRatio = viewportHeightValue / viewportWidth;
    if (!Number.isFinite(nextAspectRatio) || nextAspectRatio <= 0) {
        return false;
    }

    const previousAspectRatio = thumbnailAspectRatio.value;
    if (previousAspectRatio !== null && Math.abs(previousAspectRatio - nextAspectRatio) < 0.001) {
        return false;
    }

    thumbnailAspectRatio.value = nextAspectRatio;
    BrowserLogger.warn(THUMBNAIL_LOG_SECTION, 'Thumbnail aspect ratio changed', {
        reason,
        previousAspectRatio: previousAspectRatio === null ? null : roundMetric(previousAspectRatio),
        nextAspectRatio: roundMetric(nextAspectRatio),
        currentPage: props.currentPage,
        totalPages: props.totalPages,
        ...data,
    });

    updateThumbnailItemHeight(
        resolveThumbnailItemHeightFromRenderWidth(thumbnailRenderWidth.value),
        `${reason}-layout`,
        data,
    );
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
    if ((Date.now() - lastUserInteractionAtMs) < AUTO_SYNC_INTERACTION_COOLDOWN_MS) {
        return true;
    }

    return manualScrollSourceCycleId === thumbnailSourceCycleId
        && isThumbnailLayoutStabilizing();
}

function waitForNextFrame() {
    return new Promise<void>((resolve) => {
        if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
            resolve();
            return;
        }

        window.requestAnimationFrame(() => resolve());
    });
}

function isThumbnailLayoutStabilizing() {
    return (
        !hasResolvedThumbnailItemHeight
        || measurementState !== 'ready'
        || renderedCanvases.size === 0
    );
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

function clampPage(page: number) {
    return Math.max(1, Math.min(props.totalPages, page));
}

function resolveViewportAnchorPage(pitch = itemPitch.value) {
    if (props.totalPages <= 0 || pitch <= 0) {
        return null;
    }

    return clampPage(Math.floor(scrollTop.value / pitch) + 1);
}

function shouldPreferVisibleAnchorOverCurrentPage() {
    return !getThumbnailElement(props.currentPage);
}

function markManualThumbnailScroll(reason: string) {
    manualScrollSourceCycleId = thumbnailSourceCycleId;
    markUserInteraction(reason);
}

function preserveVisibleAnchorAfterThumbnailHeightChange(previousHeight: number) {
    if (manualScrollSourceCycleId !== thumbnailSourceCycleId) {
        return false;
    }

    const container = resolveVisibleContainer('thumbnail-measure-anchor');
    if (!container) {
        return false;
    }

    const previousPitch = Math.max(1, previousHeight + THUMBNAIL_GAP);
    const anchorPage = resolveViewportAnchorPage(previousPitch);
    if (anchorPage === null) {
        return false;
    }

    const anchorOffset = scrollTop.value - ((anchorPage - 1) * previousPitch);
    const nextScrollTop = ((anchorPage - 1) * itemPitch.value) + anchorOffset;
    return applyThumbnailScrollTop(
        container,
        Math.max(0, Math.min(getMaxScrollTop(container), nextScrollTop)),
    );
}

function getKeyboardSelectionBasePage() {
    if (
        selectionFocusPage.value !== null
        && selectionFocusPage.value >= 1
        && selectionFocusPage.value <= props.totalPages
    ) {
        return selectionFocusPage.value;
    }

    const normalized = normalizeSelectedPageNumbers(props.selectedPages ?? [], props.totalPages);
    return normalized.at(-1) ?? clampPage(props.currentPage);
}

function getKeyboardSelectionAnchorPage(basePage: number) {
    if (
        multiSelection.anchor.value !== null
        && multiSelection.anchor.value >= 1
        && multiSelection.anchor.value <= props.totalPages
    ) {
        return multiSelection.anchor.value;
    }

    const normalized = normalizeSelectedPageNumbers(props.selectedPages ?? [], props.totalPages);
    return normalized[0] ?? basePage;
}

function scrollPageIntoKeyboardView(page: number) {
    const container = resolveVisibleContainer('keyboard-selection');
    if (!container) {
        return;
    }

    const targetScrollTop = resolveCurrentPageSyncScrollTop(container, page);
    if (targetScrollTop !== null) {
        applyThumbnailScrollTop(container, targetScrollTop);
    }
}

function handleContainerKeyDown(event: KeyboardEvent) {
    if (
        !event.shiftKey
        || event.altKey
        || event.metaKey
        || event.ctrlKey
        || props.totalPages <= 0
        || isDragging.value
        || isExternalDragOver.value
    ) {
        return;
    }

    const direction = (() => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
            return -1;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
            return 1;
        }
        return 0;
    })();

    if (direction === 0) {
        return;
    }

    event.preventDefault();
    markUserInteraction('keyboard-selection');

    const basePage = getKeyboardSelectionBasePage();
    const nextFocusPage = clampPage(basePage + direction);
    const anchorPage = getKeyboardSelectionAnchorPage(basePage);
    const allPages = Array.from({ length: props.totalPages }, (_, i) => i + 1);

    multiSelection.anchor.value = anchorPage;
    multiSelection.toggle(nextFocusPage, allPages, {shift: true});
    selectionFocusPage.value = nextFocusPage;

    const normalized = normalizeSelectedPageNumbers(
        Array.from(multiSelection.selected.value),
        props.totalPages,
    );
    emit('update:selected-pages', normalized);
    emit('go-to-page', nextFocusPage);
    scrollPageIntoKeyboardView(nextFocusPage);
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

function resolveRefinedCurrentPageScrollTop(container: HTMLElement, page: number) {
    const thumbnail = getThumbnailElement(page);
    if (!thumbnail || isPageWithinComfortViewport(container, page)) {
        return null;
    }

    const containerRect = container.getBoundingClientRect();
    const thumbnailRect = thumbnail.getBoundingClientRect();
    const thumbnailTop = container.scrollTop + thumbnailRect.top - containerRect.top;
    const thumbnailBottom = thumbnailTop + thumbnailRect.height;
    const comfortPadding = getComfortPaddingPx(container);
    const scrollsTowardBottom = thumbnailBottom > (
        container.scrollTop + container.clientHeight - comfortPadding
    );
    const nextScrollTop = scrollsTowardBottom
        ? thumbnailBottom + comfortPadding - container.clientHeight
        : thumbnailTop - comfortPadding;

    return Math.max(0, Math.min(getMaxScrollTop(container), nextScrollTop));
}

function isThumbnailElementFullyVisible(container: HTMLElement, page: number) {
    const thumbnail = getThumbnailElement(page);
    if (!thumbnail) {
        return false;
    }

    const containerRect = container.getBoundingClientRect();
    const thumbnailRect = thumbnail.getBoundingClientRect();
    return (
        thumbnailRect.top >= containerRect.top
        && thumbnailRect.bottom <= containerRect.bottom
    );
}

function applyThumbnailScrollTop(container: HTMLElement, nextScrollTop: number) {
    if (Math.abs(nextScrollTop - container.scrollTop) < 1) {
        return false;
    }

    lastProgrammaticScrollAtMs = Date.now();
    container.scrollTop = nextScrollTop;
    updateViewportMetrics();
    void scheduleVisibleThumbnailRender();
    return true;
}

function resolveCurrentPageSyncRequest(
    reason: string,
    options: { force?: boolean } = {},
) {
    const container = resolveVisibleContainer(`current-page-sync:${reason}`);
    if (
        !container ||
        props.totalPages <= 0 ||
        isDragging.value ||
        isExternalDragOver.value ||
        (!options.force && isCurrentPageAutoSyncSuppressed())
    ) {
        return null;
    }
    const targetScrollTop = resolveCurrentPageSyncScrollTop(container, props.currentPage);
    return targetScrollTop === null ? null : {
        container,
        targetScrollTop,
    };
}

async function isCurrentPageSyncRunActive(syncRunId: number) {
    await nextTick();
    return syncRunId === currentPageSyncRunId;
}

function applyRefinedCurrentPageSync(
    container: HTMLElement,
    options: { force?: boolean } = {},
) {
    if (!options.force && isCurrentPageAutoSyncSuppressed()) {
        return;
    }

    const refinedScrollTop = resolveRefinedCurrentPageScrollTop(container, props.currentPage);
    if (refinedScrollTop !== null) {
        applyThumbnailScrollTop(container, refinedScrollTop);
    }
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
    if (props.isActive === false) {
        return null;
    }

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
    const nextThumbnailRenderWidth = resolveThumbnailRenderWidth(container);
    if (Math.abs(nextThumbnailRenderWidth - thumbnailRenderWidth.value) >= THUMBNAIL_WIDTH_CHANGE_THRESHOLD) {
        const previousThumbnailRenderWidth = thumbnailRenderWidth.value;
        thumbnailRenderWidth.value = nextThumbnailRenderWidth;
        updateThumbnailItemHeight(
            resolveThumbnailItemHeightFromRenderWidth(nextThumbnailRenderWidth),
            'render-width',
            {
                previousThumbnailRenderWidth: roundMetric(previousThumbnailRenderWidth),
                nextThumbnailRenderWidth: roundMetric(thumbnailRenderWidth.value),
                geometry: describeContainerGeometry(container),
            },
        );
        BrowserLogger.warn(THUMBNAIL_LOG_SECTION, 'Thumbnail render width changed', {
            previousThumbnailRenderWidth: roundMetric(previousThumbnailRenderWidth),
            nextThumbnailRenderWidth: roundMetric(thumbnailRenderWidth.value),
            currentPage: props.currentPage,
            totalPages: props.totalPages,
            geometry: describeContainerGeometry(container),
        });
    }
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

async function syncCurrentPageIntoView(
    reason: string,
    options: { force?: boolean } = {},
) {
    const request = resolveCurrentPageSyncRequest(reason, options);
    if (!request || !applyThumbnailScrollTop(request.container, request.targetScrollTop)) {
        return;
    }

    const syncRunId = ++currentPageSyncRunId;
    if (!await isCurrentPageSyncRunActive(syncRunId)) {
        return;
    }

    applyRefinedCurrentPageSync(request.container, options);
}

function findRenderedMeasurementItem(container: HTMLElement) {
    return Array.from(
        container.querySelectorAll<HTMLElement>('.pdf-thumbnail'),
    ).find((candidate) => {
        const candidateCanvas = candidate.querySelector<HTMLCanvasElement>('canvas');
        return Boolean(
            candidateCanvas
            && candidateCanvas.width > 0
            && candidateCanvas.height > 0
            && candidateCanvas.getBoundingClientRect().height > 0,
        );
    }) ?? null;
}

function warnMissingMeasurementItem(container: HTMLElement) {
    if (measurementState === 'no-item') {
        return;
    }

    measurementState = 'no-item';
    BrowserLogger.warn(THUMBNAIL_LOG_SECTION, 'Skipping thumbnail height measurement: no thumbnail items', {
        currentPage: props.currentPage,
        totalPages: props.totalPages,
        geometry: describeContainerGeometry(container),
    });
}

function warnMissingRenderedCanvas(
    container: HTMLElement,
    measurementItem: HTMLElement,
    canvas: HTMLCanvasElement | null,
) {
    if (measurementState === 'no-rendered-canvas') {
        return;
    }

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

function logMeasurementReady(
    measurementItem: HTMLElement,
    canvas: HTMLCanvasElement,
) {
    if (measurementState === 'ready') {
        return;
    }

    measurementState = 'ready';
    BrowserLogger.warn(THUMBNAIL_LOG_SECTION, 'Thumbnail height measurement resumed with rendered canvas', {
        currentPage: props.currentPage,
        totalPages: props.totalPages,
        itemPage: measurementItem.dataset.page ?? null,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
    });
}

function measureRenderedThumbnailHeight(container: HTMLElement) {
    const item = container.querySelector<HTMLElement>('.pdf-thumbnail');
    if (!item) {
        warnMissingMeasurementItem(container);
        return;
    }

    const renderedItem = findRenderedMeasurementItem(container);
    const measurementItem = renderedItem ?? item;
    const canvas = measurementItem.querySelector<HTMLCanvasElement>('canvas');
    if (!renderedItem || !canvas) {
        warnMissingRenderedCanvas(container, measurementItem, canvas);
        return;
    }

    logMeasurementReady(measurementItem, canvas);
    updateThumbnailItemHeight(resolveThumbnailItemHeightFromRenderWidth(thumbnailRenderWidth.value), 'layout-measure', {
        geometry: describeContainerGeometry(container),
        itemPage: measurementItem.dataset.page ?? null,
    });
}

const measureThumbnailHeight = useDebounceFn(() => {
    const container = resolveVisibleContainer('measure-thumbnail-height');
    if (container) {
        measureRenderedThumbnailHeight(container);
    }
}, 16);

function handleContainerScroll() {
    updateViewportMetrics();
    if (!isRecentProgrammaticScroll()) {
        markManualThumbnailScroll('scroll');
    }
    void scheduleVisibleThumbnailRender();
}

function handleContainerWheel() {
    if (!isRecentProgrammaticScroll()) {
        markManualThumbnailScroll('wheel');
    }
}

function handleContainerPointerDown() {
    markManualThumbnailScroll('pointerdown');
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
            selectionFocusPage.value = null;
            return;
        }

        if (
            multiSelection.anchor.value === null ||
            !normalized.includes(multiSelection.anchor.value)
        ) {
            multiSelection.anchor.value = normalized[normalized.length - 1] ?? null;
        }
        if (
            selectionFocusPage.value === null ||
            !normalized.includes(selectionFocusPage.value)
        ) {
            selectionFocusPage.value = normalized[normalized.length - 1] ?? null;
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

function cancelStaleThumbnailRender(pageNum: number) {
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

function prepareThumbnailCanvas(pageNum: number) {
    const canvas = getCanvas(pageNum);
    if (!canvas || isCurrentThumbnailCanvasRendered(pageNum)) {
        return null;
    }

    if (renderingPages.has(pageNum)) {
        if (renderingCanvases.get(pageNum) === canvas) {
            return null;
        }
        cancelStaleThumbnailRender(pageNum);
    }

    delete canvas.dataset.thumbnailRendered;
    renderingPages.add(pageNum);
    renderingCanvases.set(pageNum, canvas);
    return canvas;
}

function resolveThumbnailRenderMetrics(page: PDFPageProxy, pageNum: number) {
    const viewport = page.getViewport({ scale: 1 });
    if (thumbnailAspectRatio.value === null) {
        updateThumbnailAspectRatio(
            viewport.width,
            viewport.height,
            'render-viewport',
            {page: pageNum},
        );
    }
    const scale = thumbnailRenderWidth.value / viewport.width;
    const scaledViewport = page.getViewport({ scale });
    const outputScale = resolveThumbnailOutputScale();
    const pixelWidth = Math.max(1, Math.round(scaledViewport.width * outputScale));
    const pixelHeight = Math.max(1, Math.round(scaledViewport.height * outputScale));

    return {
        scaledViewport,
        pixelWidth,
        pixelHeight,
        scaleX: pixelWidth / scaledViewport.width,
        scaleY: pixelHeight / scaledViewport.height,
    };
}

function applyThumbnailCanvasSize(
    canvas: HTMLCanvasElement,
    metrics: ReturnType<typeof resolveThumbnailRenderMetrics>,
) {
    canvas.width = metrics.pixelWidth;
    canvas.height = metrics.pixelHeight;
    canvas.style.removeProperty('width');
    canvas.style.removeProperty('height');
}

function buildThumbnailRenderTransform(scaleX: number, scaleY: number) {
    return scaleX !== 1 || scaleY !== 1
        ? [
            scaleX,
            0,
            0,
            scaleY,
            0,
            0,
        ]
        : undefined;
}

function finalizeRenderedThumbnail(pageNum: number, canvas: HTMLCanvasElement) {
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
}

function shouldIgnoreThumbnailRenderError(
    error: unknown,
    pdfDocument: PDFDocumentProxy,
    runId: number,
) {
    return (
        (error instanceof Error && error.name === 'RenderingCancelledException') ||
        runId !== renderRunId ||
        !isPdfDocumentUsable(pdfDocument)
    );
}

async function renderPreparedThumbnail(
    pdfDocument: PDFDocumentProxy,
    pageNum: number,
    runId: number,
    canvas: HTMLCanvasElement,
) {
    const page = await pdfDocument.getPage(pageNum);
    if (runId !== renderRunId || !isPdfDocumentUsable(pdfDocument)) {
        return;
    }

    const metrics = resolveThumbnailRenderMetrics(page, pageNum);
    applyThumbnailCanvasSize(canvas, metrics);
    const context = canvas.getContext('2d');
    if (!context) {
        return;
    }

    const task = page.render({
        canvasContext: context,
        viewport: metrics.scaledViewport,
        canvas,
        transform: buildThumbnailRenderTransform(metrics.scaleX, metrics.scaleY),
    });
    renderTasks.set(pageNum, task);
    await task.promise;
    renderTasks.delete(pageNum);
    finalizeRenderedThumbnail(pageNum, canvas);
}

function cleanupThumbnailRenderState(pageNum: number, canvas: HTMLCanvasElement) {
    if (renderingCanvases.get(pageNum) === canvas) {
        renderingPages.delete(pageNum);
        renderingCanvases.delete(pageNum);
    }
}

function handleThumbnailRenderError(
    error: unknown,
    pdfDocument: PDFDocumentProxy,
    pageNum: number,
    runId: number,
) {
    renderTasks.delete(pageNum);
    if (shouldIgnoreThumbnailRenderError(error, pdfDocument, runId)) {
        return;
    }

    BrowserLogger.error(
        'pdf-thumbnails',
        `Failed to render thumbnail for page ${pageNum}`,
        error,
    );
}

async function renderThumbnail(
    pdfDocument: PDFDocumentProxy,
    pageNum: number,
    runId: number,
) {
    const canvas = runId === renderRunId && isPdfDocumentUsable(pdfDocument)
        ? prepareThumbnailCanvas(pageNum)
        : null;
    if (!canvas) {
        return;
    }

    try {
        await renderPreparedThumbnail(pdfDocument, pageNum, runId, canvas);
    } catch (error) {
        handleThumbnailRenderError(error, pdfDocument, pageNum, runId);
    } finally {
        cleanupThumbnailRenderState(pageNum, canvas);
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
    const currentPage = shouldPreferVisibleAnchorOverCurrentPage()
        ? resolveViewportAnchorPage() ?? props.currentPage
        : props.currentPage;

    return buildThumbnailRenderQueue({
        totalPages,
        currentPage,
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

async function refreshVisibleThumbnailPane(reason: string) {
    if (props.isActive === false) {
        return;
    }

    for (let attempt = 0; attempt < AUTO_SYNC_LAYOUT_RETRY_COUNT; attempt += 1) {
        await nextTick();
        await waitForNextFrame();
        updateViewportMetrics();
        await syncCurrentPageIntoView(reason, {force: true});
        await nextTick();

        const container = containerRef.value;
        if (container && isContainerVisible(container) && isThumbnailElementFullyVisible(container, props.currentPage)) {
            break;
        }
    }

    void scheduleVisibleThumbnailRender();
    void measureThumbnailHeight();
}

function clearActivePaneRefreshTimers() {
    if (typeof window === 'undefined') {
        activePaneRefreshTimers.clear();
        return;
    }

    for (const timer of activePaneRefreshTimers) {
        window.clearTimeout(timer);
    }
    activePaneRefreshTimers.clear();
}

function scheduleActivePaneRefresh(reason: string) {
    if (typeof window === 'undefined') {
        return;
    }

    if (props.isActive === false) {
        clearActivePaneRefreshTimers();
        return;
    }

    clearActivePaneRefreshTimers();
    for (const delayMs of AUTO_SYNC_ACTIVATION_RETRY_DELAYS_MS) {
        const timer = window.setTimeout(() => {
            activePaneRefreshTimers.delete(timer);
            void refreshVisibleThumbnailPane(reason);
        }, delayMs);
        activePaneRefreshTimers.add(timer);
    }
}

async function preloadThumbnailAspectRatio(pdfDocument: PDFDocumentProxy, runId: number) {
    const pageNum = Math.max(1, Math.min(props.totalPages, props.currentPage || 1));
    try {
        const page = await pdfDocument.getPage(pageNum);
        if (runId !== renderRunId || !isPdfDocumentUsable(pdfDocument)) {
            return;
        }

        const viewport = page.getViewport({scale: 1});
        updateThumbnailAspectRatio(
            viewport.width,
            viewport.height,
            'preload-viewport',
            {page: pageNum},
        );
        void refreshVisibleThumbnailPane('preload-viewport');
    } catch (error) {
        if (shouldIgnoreThumbnailRenderError(error, pdfDocument, runId)) {
            return;
        }
        BrowserLogger.warn(THUMBNAIL_LOG_SECTION, 'Failed to preload thumbnail aspect ratio', {
            page: pageNum,
            currentPage: props.currentPage,
            totalPages: props.totalPages,
            error,
        });
    }
}

function clearRenderedState(options: {
    preserveRenderWidth?: boolean;
    preserveAspectRatio?: boolean;
} = {}) {
    renderedCanvases.clear();
    renderingPages.clear();
    renderingCanvases.clear();
    renderTasks.clear();
    thumbnailItemHeight.value = DEFAULT_THUMBNAIL_ITEM_HEIGHT;
    if (!options.preserveRenderWidth) {
        thumbnailRenderWidth.value = THUMBNAIL_WIDTH;
    }
    if (!options.preserveAspectRatio) {
        thumbnailAspectRatio.value = null;
    }
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
        thumbnailSourceCycleId += 1;
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
            if (thumbnailAspectRatio.value === null) {
                void preloadThumbnailAspectRatio(doc, renderRunId);
                return;
            }

            void refreshVisibleThumbnailPane('document-ready');
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
        scheduleActivePaneRefresh('current-page');
    },
    {
        flush: 'post',
        immediate: true,
    },
);

watch(
    () => thumbnailItemHeight.value,
    (nextHeight, previousHeight) => {
        if (Math.abs(nextHeight - previousHeight) < 1) {
            return;
        }
        void nextTick(() => {
            if (preserveVisibleAnchorAfterThumbnailHeightChange(previousHeight)) {
                return;
            }
            if (isCurrentPageAutoSyncSuppressed()) {
                return;
            }
            void syncCurrentPageIntoView('thumbnail-measure');
        });
    },
);

watch(
    () => props.isActive ?? true,
    (isActive) => {
        if (!isActive) {
            clearActivePaneRefreshTimers();
            return;
        }

        scheduleActivePaneRefresh('pane-active');
    },
    {
        flush: 'post',
        immediate: true,
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

onMounted(() => {
    scheduleActivePaneRefresh('mounted');
});

useResizeObserver(containerRef, () => {
    resolveVisibleContainer('resize-observer');
    updateViewportMetrics();
    void scheduleVisibleThumbnailRender();
    void measureThumbnailHeight();
    void syncCurrentPageIntoView('resize-observer');
});

onBeforeUnmount(() => {
    clearActivePaneRefreshTimers();
    cancelAllRenders();
    renderRunId += 1;
    clearRenderedState();
});
</script>

<style scoped>
.pdf-thumbnails {
  position: relative;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  overflow: auto;
  overflow-anchor: none;
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
  width: 100%;
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
