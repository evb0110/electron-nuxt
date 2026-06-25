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
          :key="getThumbnailRenderKey(page)"
          class="pdf-thumbnail-canvas"
          :style="getThumbnailCanvasStyle(page)"
          :data-thumbnail-render-key="getThumbnailRenderKey(page)"
        />
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
import { clamp } from 'es-toolkit/math';
import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
} from '@app/types/annotations';
import type {
    PDFDocumentProxy,
    PDFPageProxy,
    RenderTask,
} from 'pdfjs-dist';
import { isPdfDocumentUsable } from '@app/utils/isPdfDocumentUsable';
import { BrowserLogger } from '@app/utils/browserLogger';
import { formatPageIndicatorWithOptions } from '@app/utils/pdfPageLabels';
import { AnnotationMode } from '@app/services/pdfjs/runtimeLib';
import { THUMBNAIL_WIDTH } from '@app/constants/pdfLayout';
import { getPerformanceProfile } from '@app/utils/performanceProfile';
import { buildThumbnailRenderQueue } from '@app/modules/pdf-viewer/thumbnails/buildThumbnailRenderQueue';
import { resolveThumbnailRenderConcurrency } from '@app/modules/pdf-viewer/thumbnails/resolveThumbnailRenderConcurrency';
import { usePageDragDrop } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePageDragDrop';
import { runGuardedTask } from '@app/utils/asyncGuard';
import { createHiddenAnnotationOperationsFilter } from '@app/modules/pdf-viewer/engine/pdf-hidden-annotation-operations/createHiddenAnnotationOperationsFilter';
import {
    createEditedTextMarkupThumbnailVisualSignature,
    createHiddenAnnotationIdsSignature,
    drawEditedTextMarkupThumbnailVisuals,
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
    resolveThumbnailContentHeight,
    resolveThumbnailInsertionIndex,
    resolveThumbnailItemHeightFromAspect,
    resolveThumbnailItemHeights,
    resolveThumbnailPageBounds,
    resolveThumbnailPageTops,
    type IThumbnailLayoutSnapshot,
} from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailLayout';
import { usePdfThumbnailSelection } from '@app/modules/pdf-viewer/thumbnails/usePdfThumbnailSelection';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { runCoordinatedPdfPageRender } from '@app/modules/pdf-viewer/engine/pdf-page-render-coordinator/coordinatedPdfPageRender';
import { resolveThumbnailRenderCoordination } from '@app/modules/pdf-viewer/thumbnails/resolveThumbnailRenderCoordination';
import type { IPdfPagePreviewEntry } from '@app/modules/pdf-viewer/engine/pdf-page-preview/pdfPagePreviewTypes';
import { isThumbnailRenderGenerationCurrent as isThumbnailRenderGenerationSnapshotCurrent } from '@app/modules/pdf-viewer/thumbnails/isThumbnailRenderGenerationCurrent';
import {
    buildThumbnailRenderTransform,
    resolveSeededThumbnailMetrics,
    resolveThumbnailRenderWidthFromStyles,
    roundMetric,
} from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailRenderMetrics';
import { createThumbnailRenderState } from '@app/modules/pdf-viewer/thumbnails/createThumbnailRenderState';

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
    pagePreviewProvider?: ((page: number) => IPdfPagePreviewEntry | null) | null | undefined;
}

const THUMBNAIL_WIDTH_CHANGE_THRESHOLD = 1;
const THUMBNAIL_RENDER_CONCURRENCY = getPerformanceProfile().thumbnailBaseConcurrency;
const THUMBNAIL_NAVIGATION_CONCURRENCY_COOLDOWN_MS = 250;
const IMMEDIATE_RENDER_RADIUS = 2;
const PREFETCH_RENDER_RADIUS = 4;
const MAX_THUMBNAIL_OUTPUT_SCALE = 2;
const AUTO_SYNC_INTERACTION_COOLDOWN_MS = 700;
const AUTO_SYNC_PROGRAMMATIC_SCROLL_GUARD_MS = 160;
const AUTO_SYNC_LAYOUT_RETRY_COUNT = 4;
const THUMBNAIL_LOG_SECTION = 'pdf-thumbnails';

const {
    annotationComments = undefined,
    annotationSettings = undefined,
    currentPage,
    hiddenAnnotationIds = undefined,
    invalidationRequest = undefined,
    isActive = true,
    pageLabels = undefined,
    pagePreviewProvider = null,
    pdfDocument,
    selectedPages = undefined,
    totalPages,
} = defineProps<IProps>();

const emit = defineEmits<{
    'go-to-page': [page: number];
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
const thumbnailRenderState = createThumbnailRenderState();
let renderRunId = 0;
let pendingInvalidation: number[] | null = null;
let reloadTransition = false;
let containerVisibilityState: 'unknown' | 'visible' | 'hidden' = 'unknown';
let measurementState: 'ready' | 'no-item' | 'no-rendered-canvas' = 'ready';
let lastUserInteractionAtMs = 0;
let lastUserInteractionLogAtMs = 0;
let lastUserInteractionReason: string | null = null;
let lastProgrammaticScrollAtMs = 0;
let lastNavigationAtMs = Number.NEGATIVE_INFINITY;
let currentPageSyncRunId = 0;
let thumbnailSourceCycleId = 0;
let manualScrollSourceCycleId = -1;
let activePaneRefreshRunId = 0;

const scrollTop = ref(0);
const viewportHeight = ref(0);
const thumbnailRenderWidth = ref(THUMBNAIL_WIDTH);
const thumbnailAspectRatios = ref<Array<number | null>>([]);
const documentRenderEpoch = ref(0);
const thumbnailKeySignal = ref(0);

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
    return thumbnailPageTops.value[page - 1] ?? 0;
}

const thumbnailItemHeights = computed(() => {
    return resolveThumbnailItemHeights(
        totalPages,
        thumbnailAspectRatios.value,
        thumbnailRenderWidth.value,
    );
});

const thumbnailPageTops = computed(() => {
    return resolveThumbnailPageTops(thumbnailItemHeights.value);
});

const thumbnailContentHeight = computed(() => {
    return resolveThumbnailContentHeight(
        totalPages,
        thumbnailPageTops.value,
        thumbnailItemHeights.value,
    );
});

const thumbnailLayoutSnapshot = computed<IThumbnailLayoutSnapshot>(() => ({
    tops: thumbnailPageTops.value,
    heights: thumbnailItemHeights.value,
    totalHeight: thumbnailContentHeight.value,
}));

function resolvePageAtScrollOffset(
    offset: number,
    layout = thumbnailLayoutSnapshot.value,
) {
    return resolvePageAtThumbnailScrollOffset(offset, totalPages, layout);
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

function getThumbnailRenderKey(page: number) {
    // Read the signal so page-local epoch bumps invalidate Vue's keyed canvas.
    void thumbnailKeySignal.value;
    const pageEpoch = thumbnailRenderState.getPageRenderEpoch(page);
    const outputScale = resolveThumbnailOutputScale().toFixed(3);
    return [
        documentRenderEpoch.value,
        page,
        Math.round(thumbnailRenderWidth.value),
        outputScale,
        pageEpoch,
        hiddenAnnotationIdsSignature.value,
        editedTextMarkupVisualSignature.value,
    ].join(':');
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
    onGoToPage: page => emit('go-to-page', page),
    onSelectedPagesChange: pages => emit('update:selected-pages', pages),
    scrollPageIntoKeyboardView,
    selectedPages: computed(() => selectedPages ?? []),
    totalPages: computed(() => totalPages),
});

function getThumbnailSelectionLabel(page: number) {
    return isSelected(page)
        ? t('pageOps.deselectPage', { page: getPageIndicator(page) })
        : t('pageOps.selectPage', { page: getPageIndicator(page) });
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
    return formatPageIndicatorWithOptions(page, pageLabels ?? null);
}

function isCanvasRendered(canvas: HTMLCanvasElement | null) {
    return canvas?.dataset.thumbnailRendered === 'true';
}

function isCanvasForRenderKey(canvas: HTMLCanvasElement | null, renderKey: string) {
    return canvas?.dataset.thumbnailRenderKey === renderKey;
}

function isCurrentThumbnailCanvasRendered(pageNum: number) {
    const canvas = getCanvas(pageNum);
    if (!canvas) {
        return false;
    }

    const renderKey = getThumbnailRenderKey(pageNum);
    return thumbnailRenderState.isRenderedCanvas(pageNum, canvas)
        && isCanvasRendered(canvas)
        && isCanvasForRenderKey(canvas, renderKey);
}

function isCurrentThumbnailCanvasRendering(pageNum: number) {
    const canvas = getCanvas(pageNum);
    if (!canvas) {
        return false;
    }

    const renderKey = getThumbnailRenderKey(pageNum);
    return thumbnailRenderState.isRenderingCanvasKey({
        page: pageNum,
        canvas,
        renderKey,
    });
}

function resolveThumbnailRenderWidth(container: HTMLElement) {
    const containerStyle = window.getComputedStyle(container);
    const thumbnail = container.querySelector<HTMLElement>('.pdf-thumbnail');
    const thumbnailStyle = thumbnail
        ? window.getComputedStyle(thumbnail)
        : null;
    return resolveThumbnailRenderWidthFromStyles({
        containerClientWidth: container.clientWidth,
        containerStyle,
        minWidth: THUMBNAIL_WIDTH,
        thumbnailStyle,
    });
}

function resolveThumbnailOutputScale() {
    if (typeof window === 'undefined' || window.devicePixelRatio <= 0) {
        return 1;
    }

    return Math.min(MAX_THUMBNAIL_OUTPUT_SCALE, window.devicePixelRatio);
}

function clearThumbnailCanvas(canvas: HTMLCanvasElement, renderKey: string | null = null) {
    canvas.width = 0;
    canvas.height = 0;
    delete canvas.dataset.thumbnailRendered;
    delete canvas.dataset.thumbnailSeededPreview;
    delete canvas.dataset.thumbnailSeededPreviewId;
    if (renderKey) {
        canvas.dataset.thumbnailRenderKey = renderKey;
        return;
    }
    delete canvas.dataset.thumbnailRenderKey;
}

function clearVisibleThumbnailCanvases(pages: number[] | null = null) {
    const container = containerRef.value;
    if (!container) {
        return;
    }

    const pageFilter = pages ? new Set(pages) : null;
    const thumbnails = container.querySelectorAll<HTMLElement>('.pdf-thumbnail');
    for (const thumbnail of thumbnails) {
        const page = Number(thumbnail.dataset.page);
        if (pageFilter && !pageFilter.has(page)) {
            continue;
        }
        const canvas = thumbnail.querySelector<HTMLCanvasElement>('canvas');
        if (canvas) {
            clearThumbnailCanvas(canvas, null);
        }
    }
}

function updateThumbnailAspectRatioForPage(
    page: number,
    viewportWidth: number,
    viewportHeightValue: number,
    reason: string,
    data: Record<string, unknown> = {},
) {
    if (
        page < 1
        || page > totalPages
        || viewportWidth <= 0
        || viewportHeightValue <= 0
    ) {
        return false;
    }

    const nextAspectRatio = viewportHeightValue / viewportWidth;
    if (!Number.isFinite(nextAspectRatio) || nextAspectRatio <= 0) {
        return false;
    }

    const previousAspectRatio = thumbnailAspectRatios.value[page - 1] ?? null;
    if (previousAspectRatio !== null && Math.abs(previousAspectRatio - nextAspectRatio) < 0.001) {
        return false;
    }

    const nextRatios = thumbnailAspectRatios.value.slice(0, Math.max(totalPages, page));
    nextRatios[page - 1] = nextAspectRatio;
    thumbnailAspectRatios.value = nextRatios;
    BrowserLogger.diagnostic(THUMBNAIL_LOG_SECTION, 'Thumbnail aspect ratio changed', {
        reason,
        page,
        previousAspectRatio: previousAspectRatio === null ? null : roundMetric(previousAspectRatio),
        nextAspectRatio: roundMetric(nextAspectRatio),
        itemHeight: roundMetric(resolveThumbnailItemHeightFromAspect(
            nextAspectRatio,
            thumbnailRenderWidth.value,
        )),
        currentPage: currentPage,
        totalPages: totalPages,
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
    BrowserLogger.diagnostic(THUMBNAIL_LOG_SECTION, 'Thumbnail user interaction detected', {
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

function isThumbnailRenderGenerationCurrent(pdfDocument: PDFDocumentProxy, runId: number) {
    return isThumbnailRenderGenerationSnapshotCurrent({
        runId,
        renderRunId,
        isDocumentUsable: isPdfDocumentUsable(pdfDocument),
        isPaneActive: isThumbnailPaneActive(),
    });
}

function isThumbnailLayoutStabilizing() {
    return (
        thumbnailAspectRatios.value.every(aspectRatio => !isValidThumbnailAspectRatio(aspectRatio))
        || measurementState !== 'ready'
        || thumbnailRenderState.renderedCount === 0
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

function preserveVisibleAnchorAfterThumbnailLayoutChange(
    previousLayout: typeof thumbnailLayoutSnapshot.value,
) {
    if (manualScrollSourceCycleId !== thumbnailSourceCycleId) {
        return false;
    }

    const container = resolveVisibleContainer('thumbnail-measure-anchor');
    if (!container) {
        return false;
    }

    const anchorPage = resolveViewportAnchorPage(previousLayout);
    if (anchorPage === null) {
        return false;
    }

    const previousTop = previousLayout.tops[anchorPage - 1] ?? 0;
    const anchorOffset = scrollTop.value - previousTop;
    const nextScrollTop = getThumbnailTop(anchorPage) + anchorOffset;
    return applyThumbnailScrollTop(
        container,
        clamp(nextScrollTop, 0, getMaxThumbnailScrollTop(container)),
    );
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
            BrowserLogger.diagnostic(THUMBNAIL_LOG_SECTION, 'Thumbnail container detached', {
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
        containerVisibilityState = nextState;
        BrowserLogger.diagnostic(THUMBNAIL_LOG_SECTION, nextState === 'visible'
            ? 'Thumbnail container became visible'
            : 'Thumbnail container became hidden', {
            reason,
            currentPage: currentPage,
            totalPages: totalPages,
            geometry: describeContainerGeometry(container),
            contentHeight: roundMetric(thumbnailContentHeight.value),
            renderedPages: thumbnailRenderState.renderedCount,
            renderingPages: thumbnailRenderState.renderingCount,
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
        BrowserLogger.diagnostic(THUMBNAIL_LOG_SECTION, 'Thumbnail render width changed', {
            previousThumbnailRenderWidth: roundMetric(previousThumbnailRenderWidth),
            nextThumbnailRenderWidth: roundMetric(thumbnailRenderWidth.value),
            currentPage: currentPage,
            totalPages: totalPages,
            geometry: describeContainerGeometry(container),
        });
    }
    if (Math.abs(previousViewportHeight - viewportHeight.value) >= 1) {
        BrowserLogger.diagnostic(THUMBNAIL_LOG_SECTION, 'Thumbnail viewport height changed', {
            previousViewportHeight: roundMetric(previousViewportHeight),
            nextViewportHeight: roundMetric(viewportHeight.value),
            currentPage: currentPage,
            totalPages: totalPages,
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
    BrowserLogger.diagnostic(THUMBNAIL_LOG_SECTION, 'Skipping thumbnail height measurement: no thumbnail items', {
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
    BrowserLogger.diagnostic(THUMBNAIL_LOG_SECTION, 'Skipping thumbnail height measurement: no rendered canvas in virtual window yet', {
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
    BrowserLogger.diagnostic(THUMBNAIL_LOG_SECTION, 'Thumbnail height measurement resumed with rendered canvas', {
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
    BrowserLogger.diagnostic(THUMBNAIL_LOG_SECTION, 'Thumbnail layout measurement checked', {
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

function cancelAllRenders() {
    thumbnailRenderState.cancelAll();
}

function cancelRenderForPage(page: number) {
    thumbnailRenderState.cancelPage(page);
}

function pruneDetachedThumbnailState() {
    const mountedPages = new Set(virtualPages.value);
    thumbnailRenderState.pruneDetached({
        mountedPages,
        resolveCanvas: getCanvas,
    });
}

function getPagePreviewSeed(pageNum: number) {
    const preview = pagePreviewProvider?.(pageNum) ?? null;
    if (
        !preview
        || preview.width <= 0
        || preview.height <= 0
    ) {
        return null;
    }

    return preview;
}

function seedThumbnailCanvasFromPagePreview(
    pageNum: number,
    canvas: HTMLCanvasElement,
    renderKey: string,
    reason: string,
) {
    const preview = getPagePreviewSeed(pageNum);
    if (!preview) {
        return false;
    }

    const metrics = resolveSeededThumbnailMetrics({
        cssWidth: thumbnailRenderWidth.value,
        outputScale: resolveThumbnailOutputScale(),
        sourceHeight: preview.height,
        sourceWidth: preview.width,
    });
    if (!metrics) {
        return false;
    }

    const context = canvas.getContext('2d');
    if (!context) {
        return false;
    }

    updateThumbnailAspectRatioForPage(
        pageNum,
        preview.width,
        preview.height,
        'page-preview-seed',
    );
    canvas.width = metrics.pixelWidth;
    canvas.height = metrics.pixelHeight;
    canvas.style.removeProperty('width');
    canvas.style.removeProperty('height');
    canvas.dataset.thumbnailRenderKey = renderKey;
    canvas.dataset.thumbnailSeededPreview = 'true';
    canvas.dataset.thumbnailSeededPreviewId = String(preview.id);
    context.drawImage(preview.source, 0, 0, metrics.pixelWidth, metrics.pixelHeight);
    logPdfRenderTrace('thumbnail-seeded-from-page-preview', {
        pageNumber: pageNum,
        previewId: preview.id,
        reason,
        renderKey,
        sourceWidth: preview.width,
        sourceHeight: preview.height,
        pixelWidth: metrics.pixelWidth,
        pixelHeight: metrics.pixelHeight,
        sourceAspectRatio: metrics.sourceAspectRatio,
    });
    return true;
}

function seedVisibleThumbnailsFromPagePreview(reason: string) {
    for (const pageNum of virtualPages.value) {
        const canvas = getCanvas(pageNum);
        if (!canvas || isCurrentThumbnailCanvasRendered(pageNum)) {
            continue;
        }

        const preview = getPagePreviewSeed(pageNum);
        if (!preview) {
            continue;
        }

        const renderKey = getThumbnailRenderKey(pageNum);
        if (
            isCanvasForRenderKey(canvas, renderKey)
            && canvas.dataset.thumbnailSeededPreviewId === String(preview.id)
        ) {
            continue;
        }

        seedThumbnailCanvasFromPagePreview(pageNum, canvas, renderKey, reason);
    }
}

const visiblePagePreviewSignature = computed(() => {
    if (!pagePreviewProvider) {
        return '';
    }

    return virtualPages.value
        .map((pageNum) => {
            const preview = pagePreviewProvider(pageNum);
            return preview
                ? `${pageNum}:${preview.id}:${preview.width}:${preview.height}`
                : `${pageNum}:`;
        })
        .join('|');
});

function prepareThumbnailCanvas(pageNum: number) {
    const canvas = getCanvas(pageNum);
    if (!canvas || isCurrentThumbnailCanvasRendered(pageNum)) {
        return null;
    }

    const renderKey = getThumbnailRenderKey(pageNum);
    if (thumbnailRenderState.hasRenderingPage(pageNum)) {
        if (thumbnailRenderState.isRenderingCanvasKey({
            page: pageNum,
            canvas,
            renderKey,
        })) {
            return null;
        }
        cancelRenderForPage(pageNum);
    }

    clearThumbnailCanvas(canvas, renderKey);
    seedThumbnailCanvasFromPagePreview(pageNum, canvas, renderKey, 'render-prepare');
    thumbnailRenderState.beginRender({
        page: pageNum,
        canvas,
        renderKey,
    });
    return {
        canvas,
        renderKey,
    };
}

function resolveThumbnailRenderMetrics(page: PDFPageProxy, pageNum: number) {
    const viewport = page.getViewport({ scale: 1 });
    updateThumbnailAspectRatioForPage(
        pageNum,
        viewport.width,
        viewport.height,
        'render-viewport',
    );
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

function cleanupPdfPage(page: PDFPageProxy, pageNumber: number, reason: string) {
    try {
        logPdfRenderTrace('thumbnail-page-cleanup-begin', {
            pageNumber,
            reason,
        });
        page.cleanup();
        logPdfRenderTrace('thumbnail-page-cleanup-end', {
            pageNumber,
            reason,
        });
    } catch (error) {
        logPdfRenderTrace('thumbnail-page-cleanup-error', {
            pageNumber,
            reason,
            errorName: error instanceof Error ? error.name : null,
            errorMessage: error instanceof Error ? error.message : String(error),
        });
        BrowserLogger.diagnostic(THUMBNAIL_LOG_SECTION, 'Failed to cleanup thumbnail PDF page', {error});
    }
}

function finalizeRenderedThumbnail(pageNum: number, canvas: HTMLCanvasElement, renderKey: string) {
    if (
        getCanvas(pageNum) !== canvas
        || getThumbnailRenderKey(pageNum) !== renderKey
        || !isCanvasForRenderKey(canvas, renderKey)
    ) {
        logPdfRenderTrace('thumbnail-finalize-skip-stale', {
            pageNumber: pageNum,
            renderKey,
            currentRenderKey: getThumbnailRenderKey(pageNum),
            hasCanvas: Boolean(getCanvas(pageNum)),
        });
        void scheduleVisibleThumbnailRender();
        return;
    }

    canvas.dataset.thumbnailRendered = 'true';
    delete canvas.dataset.thumbnailSeededPreview;
    delete canvas.dataset.thumbnailSeededPreviewId;
    const renderedCount = thumbnailRenderState.markRendered({
        page: pageNum,
        canvas,
    });
    logPdfRenderTrace('thumbnail-finalize-rendered', {
        pageNumber: pageNum,
        renderKey,
        renderedCount,
    });
    void measureThumbnailHeight();
    if (renderedCount === 1) {
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
        !isThumbnailRenderGenerationCurrent(pdfDocument, runId)
    );
}

async function renderPreparedThumbnail(
    pdfDocument: PDFDocumentProxy,
    pageNum: number,
    runId: number,
    canvas: HTMLCanvasElement,
    renderKey: string,
) {
    logPdfRenderTrace('thumbnail-page-load-begin', {
        pageNumber: pageNum,
        runId,
        renderKey,
        renderRunId,
    });
    const page = await pdfDocument.getPage(pageNum);
    const renderAbortController = new AbortController();
    logPdfRenderTrace('thumbnail-page-load-end', {
        pageNumber: pageNum,
        runId,
        renderKey,
        renderRunId,
    });
    try {
        const isCurrentThumbnailRender = () => (
            isThumbnailRenderGenerationCurrent(pdfDocument, runId)
            && getCanvas(pageNum) === canvas
            && getThumbnailRenderKey(pageNum) === renderKey
            && isCanvasForRenderKey(canvas, renderKey)
            && thumbnailRenderState.isRenderingCanvasKey({
                page: pageNum,
                canvas,
                renderKey,
            })
        );
        if (
            !isCurrentThumbnailRender()
        ) {
            logPdfRenderTrace('thumbnail-render-skip-stale', {
                pageNumber: pageNum,
                runId,
                renderRunId,
                renderKey,
                currentRenderKey: getThumbnailRenderKey(pageNum),
                usableDocument: isPdfDocumentUsable(pdfDocument),
                thumbnailPaneActive: isThumbnailPaneActive(),
            });
            return;
        }

        const annotationMode = AnnotationMode?.ENABLE_STORAGE
            ?? AnnotationMode?.ENABLE_FORMS
            ?? AnnotationMode?.ENABLE
            ?? 1;
        const metrics = resolveThumbnailRenderMetrics(page, pageNum);
        const renderCoordination = resolveThumbnailRenderCoordination(pageNum, currentPage);
        thumbnailRenderState.trackAbortController(pageNum, renderAbortController);
        const operationsFilter = await createHiddenAnnotationOperationsFilter(
            page,
            annotationMode,
            hiddenAnnotationIdSet.value,
            {
                owner: renderCoordination.owner,
                priority: renderCoordination.priority,
                signal: renderAbortController.signal,
                shouldStart: isCurrentThumbnailRender,
                shouldContinue: isCurrentThumbnailRender,
            },
        );
        if (!isCurrentThumbnailRender()) {
            return;
        }
        const renderCanvas = canvas.dataset.thumbnailSeededPreview === 'true'
            ? document.createElement('canvas')
            : canvas;
        applyThumbnailCanvasSize(renderCanvas, metrics);
        const context = renderCanvas.getContext('2d');
        if (!context) {
            if (renderCanvas !== canvas) {
                renderCanvas.remove();
            }
            return;
        }

        const hiddenIds = Array.from(hiddenAnnotationIdSet.value);
        logPdfRenderTrace('thumbnail-render-start', {
            pageNumber: pageNum,
            runId,
            renderKey,
            hiddenAnnotationCount: hiddenIds.length,
            hiddenAnnotationIds: hiddenIds.slice(0, 30),
            hiddenAnnotationIdsSignature: hiddenAnnotationIdsSignature.value,
            pixelWidth: metrics.pixelWidth,
            pixelHeight: metrics.pixelHeight,
            scaleX: metrics.scaleX,
            scaleY: metrics.scaleY,
            target: renderCanvas === canvas ? 'visible' : 'buffered',
            renderOwner: renderCoordination.owner,
            renderPriority: renderCoordination.priority,
        });

        let task: RenderTask | null = null;
        try {
            await runCoordinatedPdfPageRender({
                owner: renderCoordination.owner,
                pageNumber: pageNum,
                pdfPage: page,
                priority: renderCoordination.priority,
                shouldStart: isCurrentThumbnailRender,
                startRender: () => page.render({
                    canvasContext: context,
                    viewport: metrics.scaledViewport,
                    canvas: renderCanvas,
                    transform: buildThumbnailRenderTransform(metrics.scaleX, metrics.scaleY),
                    annotationMode,
                    operationsFilter,
                }),
                onTask: (nextTask) => {
                    task = nextTask;
                    thumbnailRenderState.trackRenderTask(pageNum, nextTask);
                },
            });
            logPdfRenderTrace('thumbnail-render-resolve', {
                pageNumber: pageNum,
                runId,
                renderKey,
            });
        } catch (error) {
            logPdfRenderTrace('thumbnail-render-reject', {
                pageNumber: pageNum,
                runId,
                renderKey,
                errorName: error instanceof Error ? error.name : null,
                errorMessage: error instanceof Error ? error.message : String(error),
            });
            if (renderCanvas !== canvas) {
                renderCanvas.width = 0;
                renderCanvas.height = 0;
                renderCanvas.remove();
            }
            throw error;
        } finally {
            if (task) {
                thumbnailRenderState.clearRenderTask(pageNum, task);
            }
        }
        const isStillCurrentCanvas = (
            isThumbnailRenderGenerationCurrent(pdfDocument, runId)
            &&
            getCanvas(pageNum) === canvas
            && getThumbnailRenderKey(pageNum) === renderKey
            && isCanvasForRenderKey(canvas, renderKey)
        );
        if (isStillCurrentCanvas) {
            drawEditedTextMarkupThumbnailVisuals({
                annotationSettings,
                canvas: renderCanvas,
                comments: editedTextMarkupComments.value,
                context,
                pageNum,
            });
        }
        if (renderCanvas !== canvas && isStillCurrentCanvas) {
            const visibleContext = canvas.getContext('2d');
            if (!visibleContext) {
                renderCanvas.remove();
                return;
            }

            applyThumbnailCanvasSize(canvas, metrics);
            visibleContext.drawImage(renderCanvas, 0, 0);
            renderCanvas.width = 0;
            renderCanvas.height = 0;
            renderCanvas.remove();
        }
        if (renderCanvas !== canvas && !isStillCurrentCanvas) {
            renderCanvas.width = 0;
            renderCanvas.height = 0;
            renderCanvas.remove();
        }
        finalizeRenderedThumbnail(pageNum, canvas, renderKey);
    } finally {
        thumbnailRenderState.clearAbortController(pageNum, renderAbortController);
        cleanupPdfPage(page, pageNum, 'render-thumbnail');
    }
}

function cleanupThumbnailRenderState(pageNum: number, canvas: HTMLCanvasElement, renderKey: string) {
    thumbnailRenderState.clearFinishedRender({
        page: pageNum,
        canvas,
        renderKey,
    });
}

function handleThumbnailRenderError(
    error: unknown,
    pdfDocument: PDFDocumentProxy,
    pageNum: number,
    runId: number,
) {
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
    const canvas = isThumbnailRenderGenerationCurrent(pdfDocument, runId)
        ? prepareThumbnailCanvas(pageNum)
        : null;
    if (!canvas) {
        return;
    }

    try {
        await renderPreparedThumbnail(
            pdfDocument,
            pageNum,
            runId,
            canvas.canvas,
            canvas.renderKey,
        );
    } catch (error) {
        handleThumbnailRenderError(error, pdfDocument, pageNum, runId);
    } finally {
        cleanupThumbnailRenderState(pageNum, canvas.canvas, canvas.renderKey);
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
    const queueCurrentPage = shouldPreferVisibleAnchorOverCurrentPage()
        ? resolveViewportAnchorPage() ?? currentPage
        : currentPage;

    return buildThumbnailRenderQueue({
        totalPages,
        currentPage: queueCurrentPage,
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

    const concurrency = resolveThumbnailRenderConcurrency({
        baseConcurrency: THUMBNAIL_RENDER_CONCURRENCY,
        lastNavigationAtMs,
        navigationCooldownMs: THUMBNAIL_NAVIGATION_CONCURRENCY_COOLDOWN_MS,
        nowMs: Date.now(),
    });
    logPdfRenderTrace('thumbnail-queue-start', {
        pages: pages.slice(0, 40),
        totalPages: pages.length,
        runId,
        renderRunId,
        concurrency,
        currentPage,
        virtualPages: virtualPages.value.slice(0, 40),
        hiddenAnnotationIdsSignature: hiddenAnnotationIdsSignature.value,
    });
    const workers = Array.from({length: Math.min(concurrency, queue.length)}, async () => {
        while (queue.length > 0) {
            if (runId !== renderRunId || !isPdfDocumentUsable(pdfDocument)) {
                logPdfRenderTrace('thumbnail-queue-stop-stale', {
                    runId,
                    renderRunId,
                    usableDocument: isPdfDocumentUsable(pdfDocument),
                    remaining: queue.length,
                });
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
    const renderStateSnapshot = thumbnailRenderState.createSnapshot();
    logPdfRenderTrace('thumbnail-queue-end', {
        runId,
        renderRunId,
        renderedCount: renderStateSnapshot.renderedCount,
        activeTasks: renderStateSnapshot.activeTasks,
    });
}

const scheduleVisibleThumbnailRender = useDebounceFn(() => {
    const doc = pdfDocument;

    if (!doc || totalPages <= 0) {
        return;
    }
    if (!isThumbnailPaneActive()) {
        return;
    }
    if (!resolveVisibleContainer('schedule-visible-render')) {
        return;
    }

    const runId = renderRunId;
    const pages = buildRenderQueue(totalPages);
    logPdfRenderTrace('thumbnail-schedule-visible-render-run', {
        runId,
        currentPage,
        totalPages,
        pages: pages.slice(0, 40),
        pageCount: pages.length,
        isActive,
        hiddenAnnotationIdsSignature: hiddenAnnotationIdsSignature.value,
    });

    runGuardedTask(() => renderThumbnailQueue(doc, pages, runId), {
        scope: 'pdf-thumbnails',
        message: 'Failed to render virtual thumbnail list',
    });
}, 20);

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

async function preloadThumbnailAspectRatio(pdfDocument: PDFDocumentProxy, runId: number) {
    const pageNum = clamp(currentPage || 1, 1, Math.max(1, totalPages));
    try {
        const page = await pdfDocument.getPage(pageNum);
        try {
            if (!isThumbnailRenderGenerationCurrent(pdfDocument, runId)) {
                return;
            }

            const viewport = page.getViewport({scale: 1});
            updateThumbnailAspectRatioForPage(
                pageNum,
                viewport.width,
                viewport.height,
                'preload-viewport',
            );
            void refreshVisibleThumbnailPane('preload-viewport');
        } finally {
            cleanupPdfPage(page, pageNum, 'preload-aspect-ratio');
        }
    } catch (error) {
        if (shouldIgnoreThumbnailRenderError(error, pdfDocument, runId)) {
            return;
        }
        BrowserLogger.diagnostic(THUMBNAIL_LOG_SECTION, 'Failed to preload thumbnail aspect ratio', {
            page: pageNum,
            currentPage: currentPage,
            totalPages: totalPages,
            error,
        });
    }
}

function clearRenderedState(options: {
    preserveRenderWidth?: boolean;
    preserveAspectRatio?: boolean;
} = {}) {
    thumbnailRenderState.clearAllState();
    clearVisibleThumbnailCanvases();
    if (!options.preserveRenderWidth) {
        thumbnailRenderWidth.value = THUMBNAIL_WIDTH;
    }
    if (!options.preserveAspectRatio) {
        thumbnailAspectRatios.value = [];
    }
    measurementState = 'ready';
}

watch(
    [
        () => pdfDocument,
        () => totalPages,
    ],
    ([
        doc,
        total,
    ], [oldDoc]) => {
        cancelAllRenders();
        renderRunId += 1;
        thumbnailSourceCycleId += 1;
        documentRenderEpoch.value += 1;
        thumbnailKeySignal.value += 1;
        thumbnailRenderState.clearPageRenderEpochs();
        clearVisibleThumbnailCanvases();
        BrowserLogger.diagnostic(THUMBNAIL_LOG_SECTION, 'Thumbnail source/watch cycle started', {
            hasDocument: Boolean(doc),
            hadDocument: Boolean(oldDoc),
            totalPages: total,
            renderRunId,
            reloadTransition,
            pendingInvalidation: pendingInvalidation?.slice(0, 24) ?? null,
            currentPage: currentPage,
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
                    thumbnailRenderState.deleteRenderedPage(page);
                    thumbnailRenderState.clearRenderingPage(page);
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
            if (!isValidThumbnailAspectRatio(getThumbnailAspectRatio(clampPage(currentPage || 1)))) {
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
            currentPage,
            visibleStartIndex.value,
            visibleEndIndex.value,
        ] as const,
    () => {
        void scheduleVisibleThumbnailRender();
    },
);

watch(
    () => currentPage,
    (nextPage, previousPage) => {
        if (previousPage !== undefined && nextPage !== previousPage) {
            lastNavigationAtMs = Date.now();
        }
        scheduleActivePaneRefresh('current-page');
    },
    {
        flush: 'post',
        immediate: true,
    },
);

watch(
    thumbnailLayoutSnapshot,
    (nextLayout, previousLayout) => {
        if (Math.abs(nextLayout.totalHeight - previousLayout.totalHeight) < 1) {
            return;
        }
        void nextTick(() => {
            if (preserveVisibleAnchorAfterThumbnailLayoutChange(previousLayout)) {
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
    () => isActive ?? true,
    (isActive) => {
        if (!isActive) {
            cancelActivePaneRefresh();
            cancelAllRenders();
            renderRunId += 1;
            return;
        }

        scheduleActivePaneRefresh('pane-active');
    },
    {
        flush: 'post',
        immediate: true,
    },
);

watch(
    visiblePagePreviewSignature,
    async () => {
        await nextTick();
        seedVisibleThumbnailsFromPagePreview('page-preview-ready');
    },
    {
        flush: 'post',
        immediate: true,
    },
);

function invalidatePages(pages: number[]) {
    pendingInvalidation = pages;
    for (const page of pages) {
        thumbnailRenderState.bumpPageRenderEpoch(page);
    }
    const nextRatios = thumbnailAspectRatios.value.slice();
    let didClearRatio = false;
    for (const page of pages) {
        if (nextRatios[page - 1] !== undefined) {
            nextRatios[page - 1] = null;
            didClearRatio = true;
        }
    }
    if (didClearRatio) {
        thumbnailAspectRatios.value = nextRatios;
    }
    thumbnailKeySignal.value += 1;
    logPdfRenderTrace('thumbnail-invalidate-pages', {
        pages: pages.slice(0, 40),
        totalPages: pages.length,
        renderRunId,
        currentPage,
        hiddenAnnotationIdsSignature: hiddenAnnotationIdsSignature.value,
        editedTextMarkupVisualSignature: editedTextMarkupVisualSignature.value,
    });
    BrowserLogger.diagnostic(THUMBNAIL_LOG_SECTION, 'Invalidating thumbnail pages', {
        pages: pages.slice(0, 40),
        totalPages: pages.length,
        renderRunId,
        currentPage: currentPage,
    });
    for (const page of pages) {
        thumbnailRenderState.deleteRenderedPage(page);
        cancelRenderForPage(page);

        const canvas = getCanvas(page);
        if (canvas) {
            clearThumbnailCanvas(canvas, getThumbnailRenderKey(page));
        }
    }

    void scheduleVisibleThumbnailRender();
}

watch(
    () => [
        hiddenAnnotationIdsSignature.value,
        editedTextMarkupVisualSignature.value,
    ],
    (nextSignature, previousSignature) => {
        if (
            nextSignature[0] === previousSignature?.[0]
            && nextSignature[1] === previousSignature?.[1]
        ) {
            return;
        }
        const pages = virtualPages.value.length > 0
            ? virtualPages.value
            : [currentPage];
        invalidatePages([...new Set(pages)]);
    },
);

watch(
    () => invalidationRequest?.id,
    () => {
        const pages = invalidationRequest?.pages;
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
    cancelActivePaneRefresh();
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
  scrollbar-gutter: stable;
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

.pdf-thumbnail-selection-toggle {
  position: absolute;
  z-index: 1;
  top: 0.5rem;
  left: 0.5rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.25rem;
  height: 1.25rem;
  border: 1px solid var(--ui-border);
  border-radius: 0.25rem;
  background: var(--ui-bg);
  color: var(--ui-primary);
  opacity: 0;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease,
    opacity 0.15s ease;
}

.pdf-thumbnail:hover .pdf-thumbnail-selection-toggle,
.pdf-thumbnail-selection-toggle:focus-visible,
.pdf-thumbnail-selection-toggle.is-selected {
  opacity: 1;
}

.pdf-thumbnail-selection-toggle:hover,
.pdf-thumbnail-selection-toggle:focus-visible {
  border-color: var(--ui-primary);
  background: var(--app-sidebar-control-hover-bg);
}

.pdf-thumbnail-selection-toggle.is-selected {
  border-color: var(--ui-primary);
  background: var(--ui-primary);
  color: var(--ui-bg);
}

.pdf-thumbnail-selection-icon {
  width: 0.875rem;
  height: 0.875rem;
}

.pdf-thumbnail--virtual {
  position: absolute;
  left: 0;
  right: 0;
}

.pdf-thumbnail:hover {
  background: var(--app-sidebar-control-hover-bg);
}

.pdf-thumbnail.is-selected {
  background: color-mix(in oklab, var(--ui-bg) 65%, var(--ui-primary) 12%);
}

.pdf-thumbnail-canvas {
  display: block;
  width: 100%;
  height: auto;
  max-width: 100%;
  border: 1px solid var(--ui-border);
  border-radius: 2px;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.pdf-thumbnail.is-active .pdf-thumbnail-canvas {
  border-color: var(--ui-text);
  box-shadow: 0 0 0 1px var(--ui-text);
}

.pdf-thumbnail.is-selected .pdf-thumbnail-canvas {
  border-color: var(--ui-primary);
}

.pdf-thumbnail-number {
  display: block;
  font-size: 12px;
  line-height: 16px;
  min-height: 16px;
  color: var(--ui-text-muted);
  font-variant-numeric: tabular-nums;
}

.pdf-thumbnail.is-active .pdf-thumbnail-number {
  color: var(--ui-text);
  font-weight: 600;
}

.pdf-thumbnail.is-selected .pdf-thumbnail-number {
  color: var(--ui-text);
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
