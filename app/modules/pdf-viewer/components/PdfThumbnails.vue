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
    @pointercancel="handleDragPointerCancel"
    @lostpointercapture="handleDragPointerCancel"
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
        <AppTooltip
          :text="getThumbnailSelectionLabel(page)"
          :delay-duration="400"
        >
          <button
            type="button"
            class="pdf-thumbnail-selection-toggle"
            :class="{ 'is-selected': isSelected(page) }"
            :aria-label="getThumbnailSelectionLabel(page)"
            :aria-pressed="isSelected(page) ? 'true' : 'false'"
            @mousedown.stop
            @click.stop="toggleSinglePageSelection(page)"
          >
            <UIcon
              v-if="isSelected(page)"
              name="i-ph-check"
              class="pdf-thumbnail-selection-icon"
            />
          </button>
        </AppTooltip>
        <canvas
          class="pdf-thumbnail-canvas"
          :style="getThumbnailCanvasStyle(page)"
        />
        <span class="pdf-thumbnail-number">{{ formatPageIndicatorWithOptions(page, pageLabels ?? null) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
    useDebounceFn,
    useResizeObserver,
} from '@vueuse/core';
import { clamp } from 'es-toolkit/math';
import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
} from '@app/types/annotations';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { BrowserLogger } from '@app/utils/browserLogger';
import { formatPageIndicatorWithOptions } from '@app/utils/pdfPageLabels';
import { THUMBNAIL_WIDTH } from '@app/constants/pdfLayout';
import { usePageDragDrop } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePageDragDrop';
import {
    createEditedTextMarkupThumbnailVisualSignature,
    createHiddenAnnotationIdsSignature,
    getEditedTextMarkupThumbnailComments,
} from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailTextMarkupVisuals';
import { collectEditedTextMarkupCanvasSuppressionIds } from '@app/modules/pdf-viewer/annotations/edited-text-markup-canvas-suppression/collectEditedTextMarkupCanvasSuppressionIds';
import {
    DEFAULT_THUMBNAIL_ITEM_HEIGHT,
    VIRTUAL_OVERSCAN,
    createThumbnailCanvasStyle,
    createThumbnailItemStyle,
    getMaxThumbnailScrollTop,
    getThumbnailComfortPaddingPx,
    isThumbnailPageWithinComfortViewport,
    isValidThumbnailAspectRatio,
    resolveCurrentPageThumbnailScrollTop,
    resolvePageAtScrollOffset as resolvePageAtThumbnailScrollOffset,
    resolveThumbnailInsertionIndex,
    resolveThumbnailPageBounds,
    type IThumbnailLayoutSnapshot,
} from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailLayout';
import { ThumbnailFenwickLayout } from '@app/modules/pdf-viewer/thumbnails/thumbnailFenwickLayout';
import { usePdfThumbnailSelection } from '@app/modules/pdf-viewer/thumbnails/usePdfThumbnailSelection';
import {
    resolveThumbnailRasterWidth,
    roundMetric,
} from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailRenderMetrics';
import {
    PDF_THUMBNAIL_LOG_SECTION,
    usePdfThumbnailRenderRuntime,
} from '@app/modules/pdf-viewer/thumbnails/usePdfThumbnailRenderRuntime';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/scrollToPageOptions';

interface IProps {
    pdfDocument: PDFDocumentProxy | null;
    currentPage: number;
    totalPages: number;
    pageLabels?: string[] | null | undefined;
    selectedPages?: number[] | undefined;
    invalidationRequest?: {
        id: number;
        pages: number[];
    } | null | undefined;
    hiddenAnnotationIds?: string[] | undefined;
    annotationComments?: IAnnotationCommentSummary[] | undefined;
    annotationSettings?: IAnnotationSettings | null | undefined;
    isActive?: boolean | undefined;
    isResizing?: boolean | undefined;
}

const THUMBNAIL_WIDTH_CHANGE_THRESHOLD = 1;
const THUMBNAIL_RASTER_RESIZE_SETTLE_MS = 120;
const AUTO_SYNC_INTERACTION_COOLDOWN_MS = 700;
const AUTO_SYNC_PROGRAMMATIC_SCROLL_GUARD_MS = 160;
const AUTO_SYNC_LAYOUT_RETRY_COUNT = 4;

const {
    annotationComments = undefined,
    annotationSettings = undefined,
    currentPage,
    hiddenAnnotationIds = undefined,
    invalidationRequest = undefined,
    isActive = true,
    isResizing = false,
    pageLabels = undefined,
    pdfDocument,
    selectedPages = undefined,
    totalPages,
} = defineProps<IProps>();

const emit = defineEmits<{
    'go-to-page': [page: number, options?: IScrollToPageOptions];
    'update:selected-pages': [pages: number[]];
    'page-context-menu': [payload: {
        clientX: number;
        clientY: number;
        pages: number[];
    }];
    reorder: [newOrder: number[]];
    'file-drop': [payload: {
        afterPage: number;
        filePaths: TDocumentRef[];
    }];
}>();

const containerRef = ref<HTMLElement | null>(null);
let containerVisibilityState: 'unknown' | 'visible' | 'hidden' = 'unknown';
let measurementState: 'ready' | 'no-item' | 'no-rendered-canvas' = 'ready';
let lastUserInteractionAtMs = 0;
let lastUserInteractionLogAtMs = 0;
let lastUserInteractionReason: string | null = null;
let lastProgrammaticScrollAtMs = 0;
let currentPageSyncRunId = 0;
let thumbnailSourceCycleId = 0;
let manualScrollSourceCycleId = -1;
let activePaneRefreshRunId = 0;
let resizeViewportAnchor: {
    offset: number;
    page: number;
} | null = null;

const scrollTop = ref(0);
const viewportHeight = ref(0);
const thumbnailLayoutWidth = ref(THUMBNAIL_WIDTH);
const thumbnailRenderWidth = ref(THUMBNAIL_WIDTH);
const thumbnailAspectRatios = shallowRef<Array<number | null>>([]);
let getThumbnailRenderSummary = () => ({
    renderedCount: 0,
    renderingCount: 0,
});

const editedTextMarkupComments = computed(() => getEditedTextMarkupThumbnailComments(annotationComments ?? []));
const hiddenAnnotationIdSet = computed(() => collectEditedTextMarkupCanvasSuppressionIds(
    annotationComments ?? [],
    hiddenAnnotationIds ?? [],
));
const hiddenAnnotationIdsSignature = computed(() => createHiddenAnnotationIdsSignature(hiddenAnnotationIdSet.value));
const editedTextMarkupVisualSignature = computed(() => createEditedTextMarkupThumbnailVisualSignature(
    editedTextMarkupComments.value,
    annotationSettings,
));
function getThumbnailAspectRatio(page: number) {
    return thumbnailAspectRatios.value[page - 1] ?? null;
}
function getThumbnailTop(page: number) {
    return thumbnailFenwickLayout.value.getPageTop(page);
}

const thumbnailLayoutRevision = ref(0);
const thumbnailFenwickLayout = shallowRef(new ThumbnailFenwickLayout(
    totalPages,
    thumbnailLayoutWidth.value,
    thumbnailAspectRatios.value,
));
function updateThumbnailAspectRatio(page: number, aspectRatio: number | null) {
    thumbnailAspectRatios.value[page - 1] = aspectRatio;
    triggerRef(thumbnailAspectRatios);
    if (thumbnailFenwickLayout.value.updatePageAspect(page, aspectRatio)) {
        thumbnailLayoutRevision.value += 1;
        scheduleThumbnailLayoutReaction();
    }
}
function clearThumbnailAspectRatios() {
    const anchor = captureThumbnailLayoutAnchor();
    thumbnailAspectRatios.value = [];
    thumbnailFenwickLayout.value.reset(totalPages, thumbnailLayoutWidth.value);
    thumbnailLayoutRevision.value += 1;
    scheduleThumbnailLayoutReaction(anchor);
}
watch([
    () => totalPages,
    thumbnailLayoutWidth,
], () => {
    const anchor = captureThumbnailLayoutAnchor();
    thumbnailFenwickLayout.value.reset(totalPages, thumbnailLayoutWidth.value, thumbnailAspectRatios.value);
    thumbnailLayoutRevision.value += 1;
    scheduleThumbnailLayoutReaction(anchor);
});
const thumbnailContentHeight = computed(() => {
    void thumbnailLayoutRevision.value;
    return thumbnailFenwickLayout.value.getTotalHeight();
});
const thumbnailLayoutSnapshot = computed<IThumbnailLayoutSnapshot>(() => {
    void thumbnailLayoutRevision.value;
    return thumbnailFenwickLayout.value.snapshot();
});

function resolvePageAtScrollOffset(
    offset: number,
    layout = thumbnailLayoutSnapshot.value,
) {
    return layout === thumbnailLayoutSnapshot.value
        ? thumbnailFenwickLayout.value.resolvePageAtOffset(offset)
        : resolvePageAtThumbnailScrollOffset(offset, totalPages, layout);
}

function resolveInsertionIndex(offset: number) {
    return resolveThumbnailInsertionIndex(offset, totalPages, thumbnailLayoutSnapshot.value);
}

const visibleStartIndex = computed(() => {
    if (totalPages <= 0) {
        return 0;
    }
    const startPage = resolvePageAtScrollOffset(scrollTop.value) ?? 1;
    return Math.max(
        0,
        startPage - 1 - VIRTUAL_OVERSCAN,
    );
});

const visibleEndIndex = computed(() => {
    if (totalPages <= 0) {
        return -1;
    }
    const viewportBottom = scrollTop.value + Math.max(viewportHeight.value, DEFAULT_THUMBNAIL_ITEM_HEIGHT);
    const endPage = resolvePageAtScrollOffset(viewportBottom) ?? totalPages;
    return Math.min(
        totalPages - 1,
        endPage - 1 + VIRTUAL_OVERSCAN,
    );
});

const virtualPages = computed(() => {
    if (totalPages <= 0 || visibleEndIndex.value < visibleStartIndex.value) {
        return [] as number[];
    }

    const pages: number[] = [];
    for (let index = visibleStartIndex.value; index <= visibleEndIndex.value; index += 1) {
        pages.push(index + 1);
    }
    return pages;
});

const virtualWrapperStyle = computed(() => {
    if (totalPages <= 0) {
        return {height: '0px'};
    }
    return {height: `${Math.max(0, thumbnailContentHeight.value)}px`};
});

function getThumbnailCanvasStyle(page: number) {
    return createThumbnailCanvasStyle(getThumbnailAspectRatio(page));
}

function getThumbnailStyle(page: number) {
    return createThumbnailItemStyle(getThumbnailTop(page));
}

const {
    isDragging,
    isExternalDragOver,
    draggedPages,
    dropInsertIndex,
    handleMouseDown: handleDragMouseDown,
    handlePointerCancel: handleDragPointerCancel,
    consumeClickSkip,
    handleDragEnter: handleExternalDragEnter,
    handleDragOver: handleExternalDragOver,
    handleDragLeave: handleExternalDragLeave,
    handleExternalDrop,
} = usePageDragDrop({
    containerRef,
    totalPages: computed(() => totalPages),
    selectedPages: computed(() => selectedPages ?? []),
    resolveDropIndex: (clientY, container) => {
        const rect = container.getBoundingClientRect();
        const offsetY = clientY - rect.top + container.scrollTop;
        return clamp(resolveInsertionIndex(offsetY), 0, totalPages);
    },
    onReorder: (newOrder) => emit('reorder', newOrder),
    onExternalFileDrop: (afterPage, filePaths) =>
        emit('file-drop', {
            afterPage,
            filePaths,
        }),
});

const { t } = useTypedI18n();

const {
    handleContainerKeyDown,
    handleThumbnailClick,
    handleThumbnailContextMenu,
    isSelected,
    toggleSinglePageSelection,
} = usePdfThumbnailSelection({
    consumeClickSkip,
    currentPage: computed(() => currentPage),
    isDragging,
    isExternalDragOver,
    markUserInteraction,
    onContextMenu: payload => emit('page-context-menu', payload),
    onGoToPage: page => emit('go-to-page', page, {navigationSource: 'thumbnail'}),
    onSelectedPagesChange: pages => emit('update:selected-pages', pages),
    scrollPageIntoKeyboardView,
    selectedPages: computed(() => selectedPages ?? []),
    totalPages: computed(() => totalPages),
});

function getThumbnailSelectionLabel(page: number) {
    return isSelected(page)
        ? t('pageOps.deselectPage', { page: formatPageIndicatorWithOptions(page, pageLabels ?? null) })
        : t('pageOps.selectPage', { page: formatPageIndicatorWithOptions(page, pageLabels ?? null) });
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
    BrowserLogger.diagnostic(PDF_THUMBNAIL_LOG_SECTION, 'Thumbnail user interaction detected', {
        reason,
        currentPage: currentPage,
        totalPages: totalPages,
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

function isThumbnailPaneActive() {
    return isActive !== false;
}

function isThumbnailLayoutStabilizing() {
    return (
        thumbnailAspectRatios.value.every(aspectRatio => !isValidThumbnailAspectRatio(aspectRatio))
        || measurementState !== 'ready'
        || !thumbnailRenderRuntime.hasRenderedThumbnails()
    );
}

function clampPage(page: number) {
    return clamp(page, 1, Math.max(1, totalPages));
}

function resolveViewportAnchorPage(
    layout = thumbnailLayoutSnapshot.value,
) {
    if (totalPages <= 0) {
        return null;
    }

    return clampPage(resolvePageAtScrollOffset(scrollTop.value, layout) ?? 1);
}

function shouldPreferVisibleAnchorOverCurrentPage() {
    return !getThumbnailElement(currentPage);
}

function markManualThumbnailScroll(reason: string) {
    manualScrollSourceCycleId = thumbnailSourceCycleId;
    markUserInteraction(reason);
}

interface IThumbnailLayoutAnchor {
    offset: number;
    page: number;
}

function captureThumbnailLayoutAnchor(): IThumbnailLayoutAnchor | null {
    if (!isResizing && manualScrollSourceCycleId !== thumbnailSourceCycleId) {
        return null;
    }

    const container = resolveVisibleContainer('thumbnail-measure-anchor');
    if (!container) {
        return null;
    }

    const anchorPage = resizeViewportAnchor?.page ?? resolveViewportAnchorPage();
    if (anchorPage === null) {
        return null;
    }

    return {
        page: anchorPage,
        offset: resizeViewportAnchor?.offset ?? scrollTop.value - getThumbnailTop(anchorPage),
    };
}

function preserveVisibleAnchorAfterThumbnailLayoutChange(anchor: IThumbnailLayoutAnchor | null) {
    if (!anchor) {
        return false;
    }
    const container = resolveVisibleContainer('thumbnail-measure-anchor');
    if (!container) {
        return false;
    }
    const nextScrollTop = getThumbnailTop(anchor.page) + anchor.offset;
    return applyThumbnailScrollTop(
        container,
        clamp(nextScrollTop, 0, getMaxThumbnailScrollTop(container)),
    );
}

let pendingThumbnailLayoutAnchor: IThumbnailLayoutAnchor | null | undefined;
function scheduleThumbnailLayoutReaction(
    capturedAnchor: IThumbnailLayoutAnchor | null = captureThumbnailLayoutAnchor(),
) {
    if (pendingThumbnailLayoutAnchor !== undefined) {
        return;
    }
    pendingThumbnailLayoutAnchor = capturedAnchor;
    void nextTick(() => {
        const anchor = pendingThumbnailLayoutAnchor ?? null;
        pendingThumbnailLayoutAnchor = undefined;
        if (preserveVisibleAnchorAfterThumbnailLayoutChange(anchor)) {
            return;
        }
        if (!isCurrentPageAutoSyncSuppressed()) {
            void syncCurrentPageIntoView('thumbnail-measure');
        }
    });
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

function resolveCurrentPageSyncScrollTop(container: HTMLElement, page: number) {
    return resolveCurrentPageThumbnailScrollTop(
        container,
        resolveThumbnailPageBounds(page, thumbnailLayoutSnapshot.value),
    );
}

function resolveRefinedCurrentPageScrollTop(container: HTMLElement, page: number) {
    const thumbnail = getThumbnailElement(page);
    if (
        !thumbnail
        || isThumbnailPageWithinComfortViewport(
            container,
            resolveThumbnailPageBounds(page, thumbnailLayoutSnapshot.value),
        )
    ) {
        return null;
    }

    const containerRect = container.getBoundingClientRect();
    const thumbnailRect = thumbnail.getBoundingClientRect();
    const thumbnailTop = container.scrollTop + thumbnailRect.top - containerRect.top;
    const thumbnailBottom = thumbnailTop + thumbnailRect.height;
    const comfortPadding = getThumbnailComfortPaddingPx(container);
    const scrollsTowardBottom = thumbnailBottom > (
        container.scrollTop + container.clientHeight - comfortPadding
    );
    const nextScrollTop = scrollsTowardBottom
        ? thumbnailBottom + comfortPadding - container.clientHeight
        : thumbnailTop - comfortPadding;

    return clamp(nextScrollTop, 0, getMaxThumbnailScrollTop(container));
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
        totalPages <= 0 ||
        isResizing ||
        isDragging.value ||
        isExternalDragOver.value ||
        (!options.force && isCurrentPageAutoSyncSuppressed())
    ) {
        return null;
    }
    const targetScrollTop = resolveCurrentPageSyncScrollTop(container, currentPage);
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

    const refinedScrollTop = resolveRefinedCurrentPageScrollTop(container, currentPage);
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
    if (isActive === false) {
        return null;
    }

    const container = containerRef.value;
    if (!container) {
        if (containerVisibilityState !== 'unknown') {
            BrowserLogger.diagnostic(PDF_THUMBNAIL_LOG_SECTION, 'Thumbnail container detached', {
                reason,
                stateBeforeDetach: containerVisibilityState,
                currentPage: currentPage,
                totalPages: totalPages,
            });
            containerVisibilityState = 'unknown';
        }
        return null;
    }

    const isVisible = isContainerVisible(container);
    const nextState = isVisible ? 'visible' : 'hidden';
    if (containerVisibilityState !== nextState) {
        const renderSummary = getThumbnailRenderSummary();
        containerVisibilityState = nextState;
        BrowserLogger.diagnostic(PDF_THUMBNAIL_LOG_SECTION, nextState === 'visible'
            ? 'Thumbnail container became visible'
            : 'Thumbnail container became hidden', {
            reason,
            currentPage: currentPage,
            totalPages: totalPages,
            geometry: describeContainerGeometry(container),
            contentHeight: roundMetric(thumbnailContentHeight.value),
            renderedPages: renderSummary.renderedCount,
            renderingPages: renderSummary.renderingCount,
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
    const nextThumbnailLayoutWidth = thumbnailRenderRuntime.resolveThumbnailRenderWidth(container);
    if (Math.abs(nextThumbnailLayoutWidth - thumbnailLayoutWidth.value) >= THUMBNAIL_WIDTH_CHANGE_THRESHOLD) {
        const previousThumbnailLayoutWidth = thumbnailLayoutWidth.value;
        thumbnailLayoutWidth.value = nextThumbnailLayoutWidth;
        BrowserLogger.diagnostic(PDF_THUMBNAIL_LOG_SECTION, 'Thumbnail layout width changed', {
            previousThumbnailLayoutWidth: roundMetric(previousThumbnailLayoutWidth),
            nextThumbnailLayoutWidth: roundMetric(thumbnailLayoutWidth.value),
            currentPage: currentPage,
            totalPages: totalPages,
            geometry: describeContainerGeometry(container),
        });
    }
    if (Math.abs(previousViewportHeight - viewportHeight.value) >= 1) {
        BrowserLogger.diagnostic(PDF_THUMBNAIL_LOG_SECTION, 'Thumbnail viewport height changed', {
            previousViewportHeight: roundMetric(previousViewportHeight),
            nextViewportHeight: roundMetric(viewportHeight.value),
            currentPage: currentPage,
            totalPages: totalPages,
            geometry: describeContainerGeometry(container),
        });
    }
}

function commitThumbnailRasterWidth() {
    const nextThumbnailRenderWidth = resolveThumbnailRasterWidth(thumbnailLayoutWidth.value);
    if (nextThumbnailRenderWidth === thumbnailRenderWidth.value) {
        return false;
    }

    const previousThumbnailRenderWidth = thumbnailRenderWidth.value;
    thumbnailRenderWidth.value = nextThumbnailRenderWidth;
    BrowserLogger.diagnostic(PDF_THUMBNAIL_LOG_SECTION, 'Thumbnail raster width committed', {
        previousThumbnailRenderWidth: roundMetric(previousThumbnailRenderWidth),
        nextThumbnailRenderWidth: roundMetric(nextThumbnailRenderWidth),
        thumbnailLayoutWidth: roundMetric(thumbnailLayoutWidth.value),
        currentPage,
        totalPages,
    });
    return true;
}

const scheduleThumbnailRasterWidthCommit = useDebounceFn(() => {
    if (isResizing || !commitThumbnailRasterWidth()) {
        return;
    }
    void nextTick(() => scheduleVisibleThumbnailRender());
}, THUMBNAIL_RASTER_RESIZE_SETTLE_MS);

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
    BrowserLogger.diagnostic(PDF_THUMBNAIL_LOG_SECTION, 'Skipping thumbnail height measurement: no thumbnail items', {
        currentPage: currentPage,
        totalPages: totalPages,
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
    BrowserLogger.diagnostic(PDF_THUMBNAIL_LOG_SECTION, 'Skipping thumbnail height measurement: no rendered canvas in virtual window yet', {
        currentPage: currentPage,
        totalPages: totalPages,
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
    BrowserLogger.diagnostic(PDF_THUMBNAIL_LOG_SECTION, 'Thumbnail height measurement resumed with rendered canvas', {
        currentPage: currentPage,
        totalPages: totalPages,
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
    BrowserLogger.diagnostic(PDF_THUMBNAIL_LOG_SECTION, 'Thumbnail layout measurement checked', {
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

async function refreshVisibleThumbnailPane(reason: string) {
    if (!isThumbnailPaneActive()) {
        return;
    }

    const refreshRunId = ++activePaneRefreshRunId;
    for (let attempt = 0; attempt < AUTO_SYNC_LAYOUT_RETRY_COUNT; attempt += 1) {
        await nextTick();
        await waitForNextFrame();
        if (refreshRunId !== activePaneRefreshRunId || !isThumbnailPaneActive()) {
            return;
        }
        updateViewportMetrics();
        await syncCurrentPageIntoView(reason, {force: true});
        await nextTick();
        if (refreshRunId !== activePaneRefreshRunId || !isThumbnailPaneActive()) {
            return;
        }

        const container = containerRef.value;
        if (container && isContainerVisible(container) && isThumbnailElementFullyVisible(container, currentPage)) {
            break;
        }
    }

    void scheduleVisibleThumbnailRender();
    void measureThumbnailHeight();
}

function cancelActivePaneRefresh() {
    activePaneRefreshRunId += 1;
}

function scheduleActivePaneRefresh(reason: string) {
    if (!isThumbnailPaneActive()) {
        cancelActivePaneRefresh();
        return;
    }

    void refreshVisibleThumbnailPane(reason);
}

const thumbnailRenderRuntime = usePdfThumbnailRenderRuntime({
    dom: {
        getCanvas,
        resolveVisibleContainer,
    },
    effects: {
        cancelActivePaneRefresh,
        measureThumbnailHeight,
        onSourceCycleStarted: () => {
            thumbnailSourceCycleId += 1;
        },
        refreshVisibleThumbnailPane,
        resetMeasurementState: () => {
            measurementState = 'ready';
        },
        scheduleActivePaneRefresh,
    },
    layout: {
        resolveViewportAnchorPage,
        shouldPreferVisibleAnchorOverCurrentPage,
        thumbnailAspectRatios,
        thumbnailRenderWidth,
        clearThumbnailAspectRatios,
        updateThumbnailAspectRatio,
        virtualPages,
    },
    source: {
        currentPage: computed(() => currentPage),
        invalidationRequest: computed(() => invalidationRequest),
        isActive: computed(() => isActive ?? true),
        pdfDocument: computed(() => pdfDocument),
        totalPages: computed(() => totalPages),
    },
    visuals: {
        annotationSettings: computed(() => annotationSettings),
        editedTextMarkupComments,
        editedTextMarkupVisualSignature,
        hiddenAnnotationIdSet,
        hiddenAnnotationIdsSignature,
    },
});
const { scheduleVisibleThumbnailRender } = thumbnailRenderRuntime;
getThumbnailRenderSummary = thumbnailRenderRuntime.getRenderSummary;

watch(
    containerRef,
    () => {
        updateViewportMetrics();
        void syncCurrentPageIntoView('container-ref');
    },
    { immediate: true },
);

useResizeObserver(containerRef, () => {
    resolveVisibleContainer('resize-observer');
    updateViewportMetrics();
    if (!isResizing) {
        void scheduleThumbnailRasterWidthCommit();
        void scheduleVisibleThumbnailRender();
    }
    void measureThumbnailHeight();
    if (!isResizing) {
        void syncCurrentPageIntoView('resize-observer');
    }
});

watch(
    () => isResizing,
    (resizing, wasResizing) => {
        updateViewportMetrics();
        if (resizing) {
            const anchorPage = resolveViewportAnchorPage();
            resizeViewportAnchor = anchorPage === null
                ? null
                : {
                    page: anchorPage,
                    offset: scrollTop.value - getThumbnailTop(anchorPage),
                };
            currentPageSyncRunId += 1;
            return;
        }
        if (!wasResizing) {
            return;
        }
        if (commitThumbnailRasterWidth()) {
            void nextTick(() => scheduleVisibleThumbnailRender());
        }
        void measureThumbnailHeight();
        void nextTick(() => {
            resizeViewportAnchor = null;
        });
    },
);
</script>

<style scoped src="./PdfThumbnails.css"></style>
