<template>
    <div
        ref="viewerHost"
        class="relative h-full w-full"
        :class="{ 'pdf-viewer-container--dark': invertColors }"
    >
        <div v-if="isViewerLoadingOverlayVisible" class="absolute inset-0 z-[1] flex items-center justify-center bg-[var(--ui-bg-muted)]">
            <div class="flex flex-col items-center gap-2">
                <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin text-[var(--ui-text-muted)]" />
                <span class="text-sm text-[var(--ui-text-muted)]">{{ t('common.loading') }}</span>
            </div>
        </div>
        <div
            id="pdf-viewer"
            ref="viewerContainer"
            class="pdfViewer app-scrollbar"
            :class="{
                'is-dragging': isDragging,
                'drag-mode': dragMode,
                'is-placing-comment': highlightComposable.isPlacingComment.value,
                'pdfViewer--single-page': !continuousScroll,
                'pdfViewer--mode-single': viewMode === 'single',
                'pdfViewer--mode-facing': viewMode === 'facing',
                'pdfViewer--mode-facing-first-single': viewMode === 'facing-first-single',
                'pdfViewer--hidden': isViewerLoadingOverlayVisible,
                'pdfViewer--fit-height': fitMode === 'height',
                'pdfViewer--resize-transition': resizeTransitionVisible,
                'pdfViewer--zoom-snap-suppressed': zoomSnapSuppressed,
            }"
            :style="containerStyle"
            @scroll.passive="handleViewerScroll"
            @wheel="handleViewerWheel"
            @mousedown="handleViewerMouseDown"
            @mousemove="handleViewerMouseMove"
            @mouseup="handleViewerMouseUp"
            @mouseleave="handleViewerMouseLeave"
            @click="handleViewerClick"
            @dblclick="handleViewerDblClick"
            @contextmenu="handleViewerContextMenu"
        >
            <div
                v-if="topVirtualSpacerStyle"
                class="pdf-viewer-virtual-spacer"
                :style="topVirtualSpacerStyle"
            />
            <PdfViewerPage
                v-for="page in pagesToRender"
                :key="page"
                :page="page"
                :show-skeleton="shouldShowSkeleton(page)"
                :force-skeleton="resizeTransitionVisible"
                :spread-single="isSpreadSingle(page)"
                :placeholder-style="pagePlaceholderStyle"
            />
            <div
                v-if="bottomVirtualSpacerStyle"
                class="pdf-viewer-virtual-spacer"
                :style="bottomVirtualSpacerStyle"
            />
        </div>
        <PdfRegionSnipOverlay
            :active="regionSnip.isActive.value"
            :selection-rect="regionSnip.selectionRect.value"
            :flash-rect="regionSnip.flashRect.value"
            :badge-position="regionSnip.badgePosition.value"
            :hint-label="t('toolbar.captureHint')"
            :copied-label="t('toolbar.captureCopied')"
            @pointer-start="regionSnip.onPointerStart"
            @pointer-move="regionSnip.onPointerMove"
            @pointer-end="regionSnip.onPointerEnd"
            @cancel="regionSnip.cancelCapture"
        />
        <template v-for="[pageNum, markers] in markersByPage" :key="`markers-${pageNum}`">
            <Teleport v-if="markerLayerTargets.get(pageNum)" :to="markerLayerTargets.get(pageNum)!">
                <PdfCommentMarkerLayer
                    :page-number="pageNum"
                    :markers="markers"
                    @open-note="handleMarkerOpenNote"
                    @context-menu="handleMarkerContextMenu"
                />
            </Teleport>
        </template>
    </div>
</template>

<script setup lang="ts">

import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import { AnnotationEditorParamsType } from 'pdfjs-dist';
import type { GenericL10n } from 'pdfjs-dist/web/pdf_viewer.mjs';
import PdfViewerPage from '@app/components/pdf/PdfViewerPage.vue';
import PdfRegionSnipOverlay from '@app/components/pdf/PdfRegionSnipOverlay.vue';
import PdfCommentMarkerLayer from '@app/components/pdf/annotations/PdfCommentMarkerLayer.vue';
import { usePdfDocument } from '@app/composables/pdf/usePdfDocument';
import { usePdfDrag } from '@app/composables/pdf/usePdfDrag';
import { usePdfPageRenderer } from '@app/composables/pdf/usePdfPageRenderer';
import { usePdfScale } from '@app/composables/pdf/usePdfScale';
import { usePdfScroll } from '@app/composables/pdf/usePdfScroll';
import { usePdfSkeletonInsets } from '@app/composables/pdf/usePdfSkeletonInsets';
import { useAnnotationShapes } from '@app/composables/pdf/useAnnotationShapes';
import {
    clamp,
    range,
} from 'es-toolkit/math';
import { usePdfSinglePageScroll } from '@app/composables/pdf/usePdfSinglePageScroll';
import { useAnnotationOrchestrator } from '@app/composables/pdf/annotations/useAnnotationOrchestrator';
import { usePdfViewerCore } from '@app/modules/pdf-viewer-runtime/service';
import { usePdfShapeContext } from '@app/composables/pdf/usePdfShapeContext';
import { usePdfRegionSnip } from '@app/composables/pdf/usePdfRegionSnip';
import {
    captureScrollSnapshot,
    restoreScrollFromSnapshot,
} from '@app/composables/pdf/pdfPageRenderPipeline';
import { ZOOM } from '@app/constants/pdf-layout';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
    IScrollSnapshot,
    PDFDocumentProxy,
    TPdfSource,
    TFitMode,
    TPdfViewMode,
} from '@app/types/pdf';
import { isStandaloneSpreadPage } from '@app/utils/pdf-view-mode';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    IAnnotationSettings,
    IShapeAnnotation,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IAnnotationContextMenuPayload } from '@app/composables/pdf/annotations/types';
import { logPdfNav } from '@app/utils/pdf-nav-log';
import { BrowserLogger } from '@app/utils/browser-logger';

import '@app/assets/css/vendor/pdfjs-viewer-sanitized.css';

interface IProps {
    src: TPdfSource | null;
    bufferPages?: number;
    zoom?: number;
    dragMode?: boolean;
    fitMode?: TFitMode;
    viewMode?: TPdfViewMode;
    continuousScroll?: boolean;
    isResizing?: boolean;
    invertColors?: boolean;
    showAnnotations?: boolean;
    annotationTool?: TAnnotationTool;
    annotationCursorMode?: boolean;
    annotationKeepActive?: boolean;
    annotationSettings?: IAnnotationSettings | null;
    searchPageMatches?: Map<number, IPdfPageMatches>;
    currentSearchMatch?: IPdfSearchMatch | null;
    workingCopyPath?: string | null;
    authorName?: string | null;
}

const props = defineProps<IProps>();

const src = computed(() => props.src);
const bufferPages = computed(() => props.bufferPages ?? 2);
const zoom = computed(() => props.zoom ?? 1);
const dragMode = computed(() => props.dragMode ?? false);
const fitMode = computed<TFitMode>(() => props.fitMode ?? 'width');
const viewMode = computed<TPdfViewMode>(() => props.viewMode ?? 'single');
const isResizing = computed(() => props.isResizing ?? false);
const invertColors = computed(() => props.invertColors ?? false);
const showAnnotations = computed(() => props.showAnnotations ?? true);
const annotationTool = computed<TAnnotationTool>(() => props.annotationTool ?? 'none');
const annotationCursorMode = computed(() => props.annotationCursorMode ?? false);
const annotationKeepActive = computed(() => props.annotationKeepActive ?? true);
const annotationSettings = computed<IAnnotationSettings | null>(() => props.annotationSettings ?? null);
const emptySearchPageMatches = new Map<number, IPdfPageMatches>();
const searchPageMatches = computed(() => props.searchPageMatches ?? emptySearchPageMatches);
const currentSearchMatch = computed(() => props.currentSearchMatch ?? null);
const workingCopyPath = computed(() => props.workingCopyPath ?? null);
const continuousScroll = computed(() => props.continuousScroll ?? true);
const authorName = computed(() => props.authorName);
const { t } = useTypedI18n();

const emit = defineEmits<{
    (e: 'update:zoom', value: number): void;
    (e: 'update:currentPage', page: number): void;
    (e: 'update:totalPages', total: number): void;
    (e: 'update:loading', loading: boolean): void;
    (e: 'update:document', document: PDFDocumentProxy | null): void;
    (e: 'loading', loading: boolean): void;
    (e: 'annotation-state', state: IAnnotationEditorState): void;
    (e: 'annotation-modified'): void;
    (e: 'annotation-comments', comments: IAnnotationCommentSummary[]): void;
    (e: 'annotation-open-note', comment: IAnnotationCommentSummary): void;
    (e: 'annotation-context-menu', payload: IAnnotationContextMenuPayload): void;
    (e: 'annotation-tool-auto-reset'): void;
    (e: 'annotation-setting', payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings]
    }): void;
    (e: 'annotation-comment-click', comment: IAnnotationCommentSummary): void;
    (e: 'annotation-tool-cancel'): void;
    (e: 'annotation-note-placement-change', active: boolean): void;
    (e: 'shape-context-menu', payload: {
        shapeId: string;
        clientX: number;
        clientY: number;
    }): void;
}>();

const viewerHost = ref<HTMLElement | null>(null);
const viewerContainer = ref<HTMLElement | null>(null);
const resizeTransitionVisible = ref(false);
const annotationUiManager = shallowRef<AnnotationEditorUIManager | null>(null);
const annotationL10n = shallowRef<GenericL10n | null>(null);
const annotationCommentsCache = shallowRef<IAnnotationCommentSummary[]>([]);
const activeCommentStableKey = ref<string | null>(null);
const regionSnip = usePdfRegionSnip({ viewerContainer });
const PDF_VIEWER_LOADER_ICON_SIZE_PX = 20;
const WHEEL_ZOOM_SENSITIVITY = 0.0016;
const WHEEL_LINE_DELTA_PX = 16;
const ZOOM_VIEWPORT_ANCHOR_MAX_AGE_MS = 240;
const WHEEL_ZOOM_GESTURE_GRACE_MS = 180;
const WHEEL_ZOOM_SESSION_IDLE_MS = 220;
const WHEEL_ZOOM_SESSION_LOCK_EXTENSION_MS = 260;
const WHEEL_DISPATCH_LOG_THROTTLE_MS = 420;
const WHEEL_SCROLL_LOG_THROTTLE_MS = 420;
const WHEEL_DETAIL_LOG_THROTTLE_MS = 320;
const WHEEL_ZOOM_EXPECTED_SCROLL_WINDOW_MS = 1400;

interface IZoomViewportAnchorIntent {
    id: number;
    sessionId: number;
    x: number;
    y: number;
    capturedAtMs: number;
}

interface IWheelZoomSession {
    id: number;
    anchorX: number;
    anchorY: number;
    startZoom: number;
    cumulativeDelta: number;
    lastEmittedZoom: number;
    startedAtMs: number;
    lastPacketAtMs: number;
    lockUntilMs: number;
    lastEventId: number;
    packetCount: number;
    emittedCount: number;
    startScrollTop: number | null;
    startScrollLeft: number | null;
}

interface IZoomVirtualizationFreeze {
    sessionId: number | null;
    capturedAtMs: number;
    windowStart: number;
    windowEnd: number;
    topSpacerHeight: number;
    bottomSpacerHeight: number;
}

interface IImmediateZoomRestoreIntent {
    id: number;
    sessionId: number;
    snapshot: IScrollSnapshot;
    capturedAtMs: number;
}

const pendingZoomViewportAnchor = ref<IZoomViewportAnchorIntent | null>(null);
let zoomDebugWheelEventId = 0;
let lastViewerScrollTop = 0;
let lastViewerScrollLeft = 0;
let lastModifierWheelZoomAtMs = 0;
let lastModifierWheelZoomEventId = 0;
let wheelZoomSessionId = 0;
let activeWheelZoomSession: IWheelZoomSession | null = null;
let wheelZoomSessionIdleTimer: ReturnType<typeof setTimeout> | null = null;
let isZoomRerenderBusyFromCore = false;
let zoomRerenderBusyLockUntilMs = 0;
let expectedZoomScrollUntilMs = 0;
const zoomSnapSuppressed = ref(false);
const zoomVirtualizationFreeze = ref<IZoomVirtualizationFreeze | null>(null);
let zoomSnapSuppressedTimer: ReturnType<typeof setTimeout> | null = null;
let pendingImmediateZoomRestoreIntent: IImmediateZoomRestoreIntent | null = null;
const hasCompletedInitialRenderForCurrentSource = ref(false);
let initialRenderObserver: MutationObserver | null = null;

const pdfDocumentResult = usePdfDocument();
const {
    pdfDocument,
    numPages,
    isLoading,
    basePageWidth,
    basePageHeight,
    saveDocument,
} = pdfDocumentResult;

const {
    currentPage,
    visibleRange,
    getMostVisiblePage,
    scrollToPage: scrollToPageInternal,
    updateCurrentPage,
    updateVisibleRange,
    setUniformLayoutMetrics,
} = usePdfScroll();

function summarizeViewerStateForLog() {
    const container = viewerContainer.value;
    if (!container) {
        return null;
    }
    return {
        scrollTop: Math.round(container.scrollTop),
        scrollLeft: Math.round(container.scrollLeft),
        clientWidth: Math.round(container.clientWidth),
        clientHeight: Math.round(container.clientHeight),
        scrollWidth: Math.round(container.scrollWidth),
        scrollHeight: Math.round(container.scrollHeight),
    };
}

function handleResizeTransitionSignal(payload: {
    active: boolean;
    source: string;
    token: number;
    anchorPage: number | null;
}) {
    if (resizeTransitionVisible.value === payload.active) {
        return;
    }
    resizeTransitionVisible.value = payload.active;
    BrowserLogger.warn('pdf-nav', `[resize-transition-ui] active=${payload.active}`, {
        ...payload,
        viewer: summarizeViewerStateForLog(),
        currentPage: currentPage.value,
        visibleRange: {
            start: visibleRange.value.start,
            end: visibleRange.value.end,
        },
    });
}

watch(
    [
        () => Boolean(src.value),
        isLoading,
    ],
    ([
        hasSrc,
        loading,
    ], [
        prevHasSrc,
        prevLoading,
    ]) => {
        if (hasSrc === prevHasSrc && loading === prevLoading) {
            return;
        }

        const hostRect = viewerHost.value?.getBoundingClientRect();
        BrowserLogger.debug('loader', 'PDF viewer loader state changed', {
            hasSrc,
            loading,
            overlayVisible: hasSrc && loading,
            iconSizePx: PDF_VIEWER_LOADER_ICON_SIZE_PX,
            label: t('common.loading'),
            hostWidth: hostRect ? Math.round(hostRect.width) : null,
            hostHeight: hostRect ? Math.round(hostRect.height) : null,
        });
    },
    { immediate: true },
);
const {
    isDragging,
    startDrag,
    onDrag,
    stopDrag,
} = usePdfDrag(() => dragMode.value);
const {
    containerStyle,
    scaledMargin,
    computeFitWidthScale,
    effectiveScale,
    resetScale,
} = usePdfScale(
    zoom,
    fitMode,
    viewMode,
    numPages,
    basePageWidth,
    basePageHeight,
);
const {
    computeSkeletonInsets,
    resetInsets,
} = usePdfSkeletonInsets(basePageWidth, basePageHeight, effectiveScale);

const shapeComposable = useAnnotationShapes();

function registerShapeHistoryCommand(command: {
    cmd: () => void;
    undo: () => void;
}) {
    annotationUiManager.value?.addCommands({
        ...command,
        mustExec: false,
    });
}

function handleShapeCreated(shape: IShapeAnnotation) {
    emit('annotation-modified');

    registerShapeHistoryCommand({
        cmd: () => {
            shapeComposable.addShape(shape);
            shapeComposable.selectShape(shape.id);
            emit('annotation-modified');
        },
        undo: () => {
            shapeComposable.deleteShape(shape.id);
            emit('annotation-modified');
        },
    });
}

usePdfShapeContext({
    shapeComposable,
    annotationTool,
    annotationSettings,
    onShapeCreated: handleShapeCreated,
    onShapeContextMenu: (payload) => {
        emit('shape-context-menu', payload);
    },
});

const {
    setupPagePlaceholders,
    renderVisiblePages,
    reRenderAllVisiblePages,
    cleanupAllPages: cleanupRenderedPages,
    invalidatePages: invalidateRenderedPages,
    applySearchHighlights,
    isPageRendered,
    requestScrollToCurrentResult,
    cancelPendingSearchScroll,
    cancelInFlightRenders,
} = usePdfPageRenderer({
    container: viewerContainer,
    document: pdfDocumentResult,
    currentPage,
    effectiveScale,
    bufferPages,
    showAnnotations,
    annotationUiManager,
    annotationL10n,
    scrollToPage: (
        pageNumber: number,
        options?: { preferExactDom?: boolean; },
    ) => singlePageScroll.scrollToPage(pageNumber, options),
    suppressSnap: () => singlePageScroll.suppressSnapFor(220),
    beginSearchNavigation: (pageNumber: number) => singlePageScroll.beginSearchNavigation(pageNumber),
    endSearchNavigation: (settleMs?: number) => singlePageScroll.endSearchNavigation(settleMs),
    searchPageMatches,
    currentSearchMatch,
    workingCopyPath,
});

const singlePageScroll = usePdfSinglePageScroll({
    viewerContainer,
    numPages,
    currentPage,
    scaledMargin,
    viewMode,
    continuousScroll,
    isLoading,
    pdfDocument,
    getMostVisiblePage,
    scrollToPageInternal,
    updateVisibleRange,
    updateCurrentPage,
    renderVisiblePages,
    visibleRange,
    emitCurrentPage: (page) => emit('update:currentPage', page),
});

const annotations = useAnnotationOrchestrator({
    viewerContainer,
    pdfDocument,
    numPages,
    currentPage,
    effectiveScale,
    visibleRange,
    annotationTool,
    annotationCursorMode,
    annotationKeepActive,
    annotationSettings,
    annotationUiManager,
    annotationL10n,
    annotationCommentsCache,
    activeCommentStableKey,
    authorName,
    stopDrag,
    scrollToPage: (pageNumber) => singlePageScroll.scrollToPage(pageNumber),
    renderVisiblePages,
    updateVisibleRange,
    emitAnnotationModified: () => emit('annotation-modified'),
    emitAnnotationState: (state) => emit('annotation-state', state),
    emitAnnotationComments: (comments) => emit('annotation-comments', comments),
    emitAnnotationOpenNote: (comment) => emit('annotation-open-note', comment),
    emitAnnotationContextMenu: (payload) => emit('annotation-context-menu', payload),
    emitAnnotationToolAutoReset: () => emit('annotation-tool-auto-reset'),
    emitAnnotationSetting: (payload) => emit('annotation-setting', payload),
    emitAnnotationCommentClick: (comment) => emit('annotation-comment-click', comment),
    emitAnnotationToolCancel: () => emit('annotation-tool-cancel'),
    emitAnnotationNotePlacementChange: (active) => emit('annotation-note-placement-change', active),
});

const highlightComposable = annotations.highlight;
const commentCrud = annotations.crud;
const markersByPage = annotations.markersByPage;

const markerLayerTargets = computed<Map<number, HTMLElement>>(() => {
    const container = viewerContainer.value;
    if (!container) {
        return new Map();
    }
    const targets = new Map<number, HTMLElement>();
    for (const pageNumber of markersByPage.value.keys()) {
        const pageEl = container.querySelector<HTMLElement>(
            `.page_container[data-page="${pageNumber}"]`,
        );
        if (pageEl) {
            targets.set(pageNumber, pageEl);
        }
    }
    return targets;
});

function handleMarkerOpenNote(comment: IAnnotationCommentSummary) {
    activeCommentStableKey.value = comment.stableKey;
    emit('annotation-open-note', comment);
}

function handleMarkerContextMenu(comment: IAnnotationCommentSummary, event: MouseEvent) {
    activeCommentStableKey.value = comment.stableKey;
    emit(
        'annotation-context-menu',
        highlightComposable.buildAnnotationContextMenuPayload(comment, event.clientX, event.clientY),
    );
}

const {
    shouldShowSkeleton,
    handleDragStart,
    handleDragMove,
    undoAnnotation,
    redoAnnotation,
    invalidatePages,
} = usePdfViewerCore({
    viewerContainer,
    src,
    zoom,
    fitMode,
    viewMode,
    isResizing,
    continuousScroll,
    annotationTool,
    annotationCursorMode,
    annotationSettings,
    annotationUiManager,
    annotationCommentsCache,
    activeCommentStableKey,
    pdfDocumentResult,
    annotations,
    currentPage,
    visibleRange,
    effectiveScale,
    basePageWidth,
    basePageHeight,
    computeFitWidthScale,
    resetScale,
    computeSkeletonInsets,
    resetInsets,
    setupPagePlaceholders,
    renderVisiblePages,
    reRenderAllVisiblePages,
    cancelInFlightPageRenders: cancelInFlightRenders,
    cleanupRenderedPages,
    invalidateRenderedPages,
    applySearchHighlights,
    isPageRendered,
    getMostVisiblePage,
    updateCurrentPage,
    updateVisibleRange,
    scrollToPage: (
        pageNumber,
        options,
    ) => singlePageScroll.scrollToPage(pageNumber, options),
    resetContinuousScrollState: () => singlePageScroll.resetContinuousScrollState(),
    startDrag,
    onDrag,
    stopDrag,
    consumeZoomViewportAnchor: () => {
        const nowMs = Date.now();
        const pendingAnchor = pendingZoomViewportAnchor.value;
        if (!pendingAnchor) {
            const activeSession = getActiveWheelZoomSession(nowMs);
            const canUseSessionFallback = Boolean(
                activeSession
                && nowMs - activeSession.lastPacketAtMs <= WHEEL_ZOOM_GESTURE_GRACE_MS,
            );
            if (canUseSessionFallback && activeSession) {
                const fallbackAnchor: IZoomViewportAnchorIntent = {
                    id: activeSession.lastEventId,
                    sessionId: activeSession.id,
                    x: activeSession.anchorX,
                    y: activeSession.anchorY,
                    capturedAtMs: activeSession.lastPacketAtMs,
                };
                BrowserLogger.warnThrottled(
                    'pdf-zoom-debug',
                    'anchor-consume-session-fallback',
                    WHEEL_DETAIL_LOG_THROTTLE_MS,
                    `[anchor-consume] session-fallback id=${fallbackAnchor.id}`,
                    {
                        id: fallbackAnchor.id,
                        sessionId: fallbackAnchor.sessionId,
                        anchor: fallbackAnchor,
                        viewer: summarizeViewerStateForLog(),
                    },
                );
                return fallbackAnchor;
            }
            BrowserLogger.warnThrottled(
                'pdf-zoom-debug',
                'anchor-consume-none',
                WHEEL_DETAIL_LOG_THROTTLE_MS,
                '[anchor-consume] none',
            );
            return null;
        }
        const ageMs = nowMs - pendingAnchor.capturedAtMs;
        const zoomLockActive = isZoomInteractionLocked(nowMs);
        const activeSession = getActiveWheelZoomSession(nowMs);
        const belongsToActiveSession = activeSession?.id === pendingAnchor.sessionId;
        const staleWithoutZoomContext =
            ageMs > ZOOM_VIEWPORT_ANCHOR_MAX_AGE_MS
            && !zoomLockActive
            && !belongsToActiveSession;
        if (staleWithoutZoomContext) {
            pendingZoomViewportAnchor.value = null;
            BrowserLogger.warnThrottled(
                'pdf-zoom-debug',
                'anchor-consume-stale',
                WHEEL_DETAIL_LOG_THROTTLE_MS,
                `[anchor-consume] stale id=${pendingAnchor.id}`,
                {
                    id: pendingAnchor.id,
                    sessionId: pendingAnchor.sessionId,
                    ageMs,
                    anchor: pendingAnchor,
                    viewer: summarizeViewerStateForLog(),
                },
            );
            return null;
        }
        pendingZoomViewportAnchor.value = null;
        BrowserLogger.warnThrottled(
            'pdf-zoom-debug',
            'anchor-consume',
            WHEEL_DETAIL_LOG_THROTTLE_MS,
            `[anchor-consume] id=${pendingAnchor.id}`,
            {
                id: pendingAnchor.id,
                sessionId: pendingAnchor.sessionId,
                ageMs,
                zoomLockActive,
                anchor: pendingAnchor,
                viewer: summarizeViewerStateForLog(),
            },
        );
        return pendingAnchor;
    },
    isZoomInteractionLocked: () => isWheelZoomGestureLocked(),
    isZoomGestureSessionLocked: () => isWheelZoomGestureLocked(),
    setZoomRerenderBusy: (busy) => updateZoomRerenderBusyState(busy, 'viewer-core-callback'),
    setResizeTransitionVisible: handleResizeTransitionSignal,
    emit,
});

const VIRTUAL_MOUNT_BUFFER_MIN = 6;
const SEARCH_NAV_VIRTUAL_BUFFER_MIN = 18;
const pageHeightEstimate = computed(() => {
    const baseHeight = basePageHeight.value;
    if (!baseHeight) {
        return 0;
    }
    return baseHeight * effectiveScale.value;
});
const pageGapEstimate = computed(() => scaledMargin.value);
const pagePlaceholderStyle = computed<Record<string, string> | null>(() => {
    const baseWidth = basePageWidth.value;
    const baseHeight = basePageHeight.value;
    if (!baseWidth || !baseHeight) {
        return null;
    }

    return {
        width: `${baseWidth * effectiveScale.value}px`,
        height: `${baseHeight * effectiveScale.value}px`,
    };
});

const virtualizedContinuousMode = computed(() =>
    continuousScroll.value
    && viewMode.value === 'single'
    && numPages.value > 0
    && pageHeightEstimate.value > 0,
);
const isSearchNavigationActive = computed(() =>
    singlePageScroll.searchNavigationTargetPage.value !== null,
);
const virtualMountBuffer = computed(() =>
    isSearchNavigationActive.value
        ? Math.max(SEARCH_NAV_VIRTUAL_BUFFER_MIN, VIRTUAL_MOUNT_BUFFER_MIN, bufferPages.value + 2)
        : Math.max(VIRTUAL_MOUNT_BUFFER_MIN, bufferPages.value + 2),
);
const baseVirtualWindowStart = computed(() => {
    if (!virtualizedContinuousMode.value) {
        return 1;
    }
    return Math.max(1, visibleRange.value.start - virtualMountBuffer.value);
});
const baseVirtualWindowEnd = computed(() => {
    if (!virtualizedContinuousMode.value) {
        return numPages.value;
    }
    return Math.min(numPages.value, visibleRange.value.end + virtualMountBuffer.value);
});
const searchNavigationWindow = computed<{
    start: number;
    end: number;
} | null>(() => {
    const anchorPage = singlePageScroll.searchNavigationTargetPage.value;
    if (!virtualizedContinuousMode.value || numPages.value <= 0 || anchorPage === null) {
        return null;
    }

    return {
        start: Math.max(1, anchorPage - virtualMountBuffer.value),
        end: Math.min(numPages.value, anchorPage + virtualMountBuffer.value),
    };
});
const virtualWindowStart = computed(() => {
    if (!virtualizedContinuousMode.value) {
        return 1;
    }
    if (zoomVirtualizationFreeze.value) {
        return zoomVirtualizationFreeze.value.windowStart;
    }

    if (searchNavigationWindow.value) {
        return searchNavigationWindow.value.start;
    }
    return baseVirtualWindowStart.value;
});
const virtualWindowEnd = computed(() => {
    if (!virtualizedContinuousMode.value) {
        return numPages.value;
    }
    if (zoomVirtualizationFreeze.value) {
        return zoomVirtualizationFreeze.value.windowEnd;
    }

    if (searchNavigationWindow.value) {
        return searchNavigationWindow.value.end;
    }
    return baseVirtualWindowEnd.value;
});

function computeVirtualSpacerHeight(hiddenPages: number) {
    if (hiddenPages <= 0) {
        return 0;
    }
    return hiddenPages * pageHeightEstimate.value
        + Math.max(0, hiddenPages - 1) * pageGapEstimate.value;
}

function captureZoomVirtualizationFreeze(sessionId: number | null, reason: string) {
    void sessionId;
    void reason;
}

function releaseZoomVirtualizationFreeze(reason: string) {
    void reason;
    zoomVirtualizationFreeze.value = null;
}

function shouldHoldZoomVirtualizationFreeze(nowMs = Date.now()) {
    void nowMs;
    return false;
}

function maybeReleaseZoomVirtualizationFreeze(reason: string) {
    if (shouldHoldZoomVirtualizationFreeze()) {
        return;
    }
    releaseZoomVirtualizationFreeze(reason);
}

const topVirtualSpacerStyle = computed<Record<string, string> | null>(() => {
    if (!virtualizedContinuousMode.value) {
        return null;
    }
    const freeze = zoomVirtualizationFreeze.value;
    if (freeze) {
        if (freeze.topSpacerHeight <= 0) {
            return null;
        }
        return {height: `${freeze.topSpacerHeight}px`};
    }

    const hiddenBefore = Math.max(0, virtualWindowStart.value - 1);
    const spacerHeight = computeVirtualSpacerHeight(hiddenBefore);
    if (spacerHeight <= 0) {
        return null;
    }

    return {height: `${spacerHeight}px`};
});

const bottomVirtualSpacerStyle = computed<Record<string, string> | null>(() => {
    if (!virtualizedContinuousMode.value) {
        return null;
    }
    const freeze = zoomVirtualizationFreeze.value;
    if (freeze) {
        if (freeze.bottomSpacerHeight <= 0) {
            return null;
        }
        return {height: `${freeze.bottomSpacerHeight}px`};
    }

    const hiddenAfter = Math.max(0, numPages.value - virtualWindowEnd.value);
    const spacerHeight = computeVirtualSpacerHeight(hiddenAfter);
    if (spacerHeight <= 0) {
        return null;
    }

    return {height: `${spacerHeight}px`};
});

const pagesToRender = computed(() => {
    if (numPages.value <= 0) {
        return [];
    }

    if (!virtualizedContinuousMode.value) {
        return range(1, numPages.value + 1);
    }

    return range(virtualWindowStart.value, virtualWindowEnd.value + 1);
});

function stopInitialRenderObserver() {
    initialRenderObserver?.disconnect();
    initialRenderObserver = null;
}

function hasRenderedCanvasInDom() {
    const container = viewerContainer.value;
    if (!container) {
        return false;
    }

    return Boolean(container.querySelector('.page_container--rendered .page_canvas canvas'));
}

function markInitialRenderCompleteIfReady() {
    if (hasCompletedInitialRenderForCurrentSource.value) {
        return true;
    }

    if (!hasRenderedCanvasInDom()) {
        return false;
    }

    hasCompletedInitialRenderForCurrentSource.value = true;
    stopInitialRenderObserver();
    return true;
}

function ensureInitialRenderObserver() {
    if (initialRenderObserver || hasCompletedInitialRenderForCurrentSource.value || !viewerContainer.value) {
        return;
    }

    initialRenderObserver = new MutationObserver(() => {
        markInitialRenderCompleteIfReady();
    });
    initialRenderObserver.observe(viewerContainer.value, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
    });
}

watch(
    [
        () => src.value,
        isLoading,
    ],
    async ([
        hasSrc,
        loading,
    ]) => {
        if (!hasSrc || loading) {
            hasCompletedInitialRenderForCurrentSource.value = false;
            stopInitialRenderObserver();
            return;
        }

        await nextTick();
        if (!markInitialRenderCompleteIfReady()) {
            ensureInitialRenderObserver();
        }
    },
    { immediate: true },
);

watch(viewerContainer, () => {
    if (!src.value || isLoading.value || hasCompletedInitialRenderForCurrentSource.value) {
        stopInitialRenderObserver();
        return;
    }

    if (!markInitialRenderCompleteIfReady()) {
        ensureInitialRenderObserver();
    }
});

const isViewerLoadingOverlayVisible = computed(() => (
    Boolean(src.value) && (
        isLoading.value
        || !hasCompletedInitialRenderForCurrentSource.value
    )
));

watch(
    () => [
        !!searchNavigationWindow.value,
        virtualWindowStart.value,
        virtualWindowEnd.value,
        currentPage.value,
        visibleRange.value.start,
        visibleRange.value.end,
        singlePageScroll.searchNavigationTargetPage.value,
        singlePageScroll.searchNavigationState.value,
    ] as const,
    ([
        anchored,
        start,
        end,
        page,
        visibleStart,
        visibleEnd,
        navigationAnchorPage,
        searchNavigationState,
    ]) => {
        if (!virtualizedContinuousMode.value) {
            return;
        }
        if (searchNavigationState === 'idle') {
            return;
        }

        logPdfNav(
            `[PDF-NAV] virtualWindow anchored=${anchored}`
            + ` start=${start} end=${end} currentPage=${page}`
            + ` visibleRange=${visibleStart}-${visibleEnd}`
            + ` searchAnchor=${navigationAnchorPage ?? 'none'}`
            + ` searchState=${searchNavigationState}`,
        );
    },
);

watch(currentPage, (next, previous) => {
    if (next === previous) {
        return;
    }
    BrowserLogger.warn('pdf-nav', `[viewer-current-page-ref] ${previous}->${next}`, {
        previous,
        next,
        isLoading: isLoading.value,
        continuousScroll: continuousScroll.value,
        fitMode: fitMode.value,
        viewMode: viewMode.value,
        zoom: zoom.value,
        visibleRange: {
            start: visibleRange.value.start,
            end: visibleRange.value.end,
        },
        viewer: summarizeViewerStateForLog(),
    });
});

watch(
    () => [
        visibleRange.value.start,
        visibleRange.value.end,
    ] as const,
    ([
        nextStart,
        nextEnd,
    ], [
        prevStart,
        prevEnd,
    ]) => {
        if (nextStart === prevStart && nextEnd === prevEnd) {
            return;
        }
        BrowserLogger.warn('pdf-nav', `[viewer-visible-range] ${prevStart}-${prevEnd} -> ${nextStart}-${nextEnd}`, {
            previous: {
                start: prevStart,
                end: prevEnd, 
            },
            next: {
                start: nextStart,
                end: nextEnd, 
            },
            currentPage: currentPage.value,
            isLoading: isLoading.value,
            continuousScroll: continuousScroll.value,
            viewer: summarizeViewerStateForLog(),
        });
    },
);

watchEffect(() => {
    const totalPages = numPages.value;
    const pageHeight = pageHeightEstimate.value;
    const gap = pageGapEstimate.value;

    if (viewMode.value === 'single' && totalPages > 0 && pageHeight > 0) {
        setUniformLayoutMetrics({
            pageHeight,
            gap,
            paddingTop: scaledMargin.value,
            totalPages,
        });
        return;
    }

    setUniformLayoutMetrics(null);
});

watch(
    () => zoom.value,
    (nextZoom, previousZoom) => {
        const pendingIntent = pendingImmediateZoomRestoreIntent;
        if (!pendingIntent) {
            return;
        }
        const container = viewerContainer.value;
        if (!container) {
            pendingImmediateZoomRestoreIntent = null;
            return;
        }

        restoreScrollFromSnapshot(container, pendingIntent.snapshot, {
            restoreHorizontal: true,
            restoreVertical: true,
            preferPageAnchor: true,
            allowVerticalRatioFallback: false,
        });
        BrowserLogger.warnThrottled('pdf-zoom-debug', 'wheel-zoom-immediate-restore', WHEEL_DETAIL_LOG_THROTTLE_MS, `[wheel-zoom] immediate-restore id=${pendingIntent.id}`, {
            id: pendingIntent.id,
            sessionId: pendingIntent.sessionId,
            capturedAtMs: pendingIntent.capturedAtMs,
            previousZoom,
            nextZoom,
            viewer: summarizeViewerStateForLog(),
        });
        pendingImmediateZoomRestoreIntent = null;
    },
    { flush: 'post' },
);

onBeforeUnmount(() => {
    setUniformLayoutMetrics(null);
    stopInitialRenderObserver();
    resizeTransitionVisible.value = false;
    clearWheelZoomSessionIdleTimer();
    clearZoomSnapSuppressedTimer();
    activeWheelZoomSession = null;
    isZoomRerenderBusyFromCore = false;
    zoomRerenderBusyLockUntilMs = 0;
    expectedZoomScrollUntilMs = 0;
    zoomSnapSuppressed.value = false;
    zoomVirtualizationFreeze.value = null;
    pendingImmediateZoomRestoreIntent = null;
});

function isSpreadSingle(page: number) {
    return isStandaloneSpreadPage(page, viewMode.value, numPages.value);
}

function isSnipActive() {
    return regionSnip.isActive.value;
}

function normalizeWheelZoomDelta(event: WheelEvent, container: HTMLElement) {
    if (event.deltaMode === 1) {
        return event.deltaY * WHEEL_LINE_DELTA_PX;
    }
    if (event.deltaMode === 2) {
        return event.deltaY * Math.max(container.clientHeight, 1);
    }
    return event.deltaY;
}

function clampZoomLevel(level: number) {
    return clamp(level, ZOOM.MIN, ZOOM.MAX);
}

function summarizeWheelEventForDebug(event: WheelEvent) {
    return {
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        deltaMode: event.deltaMode,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaZ: event.deltaZ,
        cancelable: event.cancelable,
        defaultPrevented: event.defaultPrevented,
    };
}

function clearWheelZoomSessionIdleTimer() {
    if (wheelZoomSessionIdleTimer !== null) {
        clearTimeout(wheelZoomSessionIdleTimer);
        wheelZoomSessionIdleTimer = null;
    }
}

function clearZoomSnapSuppressedTimer() {
    if (zoomSnapSuppressedTimer !== null) {
        clearTimeout(zoomSnapSuppressedTimer);
        zoomSnapSuppressedTimer = null;
    }
}

function scheduleZoomSnapSuppressedRelease() {
    clearZoomSnapSuppressedTimer();
    const delayMs = expectedZoomScrollUntilMs - Date.now();
    if (delayMs <= 0) {
        zoomSnapSuppressed.value = false;
        maybeReleaseZoomVirtualizationFreeze('expected-scroll-window-expired');
        return;
    }
    zoomSnapSuppressedTimer = setTimeout(() => {
        zoomSnapSuppressedTimer = null;
        if (Date.now() <= expectedZoomScrollUntilMs) {
            scheduleZoomSnapSuppressedRelease();
            return;
        }
        zoomSnapSuppressed.value = false;
        maybeReleaseZoomVirtualizationFreeze('expected-scroll-window-expired');
    }, delayMs + 32);
}

function markExpectedZoomScroll(ms: number) {
    expectedZoomScrollUntilMs = Math.max(
        expectedZoomScrollUntilMs,
        Date.now() + Math.max(0, ms),
    );
    zoomSnapSuppressed.value = true;
    captureZoomVirtualizationFreeze(
        activeWheelZoomSession?.id ?? null,
        'expected-scroll-window',
    );
    scheduleZoomSnapSuppressedRelease();
}

function endWheelZoomSession(reason: string) {
    clearWheelZoomSessionIdleTimer();
    const finishedSession = activeWheelZoomSession;
    if (!finishedSession) {
        return;
    }
    const viewerState = summarizeViewerStateForLog();
    BrowserLogger.warn('pdf-zoom-debug', `[wheel-zoom-session] end reason=${reason}`, {
        reason,
        session: finishedSession,
        viewer: viewerState,
        sessionDurationMs: Date.now() - finishedSession.startedAtMs,
        packetCount: finishedSession.packetCount,
        emittedCount: finishedSession.emittedCount,
        scrollDriftFromSessionStart: {
            top: (
                viewerState?.scrollTop !== undefined
                && finishedSession.startScrollTop !== null
            )
                ? viewerState.scrollTop - finishedSession.startScrollTop
                : null,
            left: (
                viewerState?.scrollLeft !== undefined
                && finishedSession.startScrollLeft !== null
            )
                ? viewerState.scrollLeft - finishedSession.startScrollLeft
                : null,
        },
    });
    activeWheelZoomSession = null;
    maybeReleaseZoomVirtualizationFreeze(`session-end:${reason}`);
}

function getActiveWheelZoomSession(nowMs = Date.now()) {
    if (!activeWheelZoomSession) {
        return null;
    }
    if (nowMs > activeWheelZoomSession.lockUntilMs) {
        endWheelZoomSession('lock-expired');
        return null;
    }
    return activeWheelZoomSession;
}

function scheduleWheelZoomSessionIdleTimeout(sessionId: number) {
    clearWheelZoomSessionIdleTimer();
    wheelZoomSessionIdleTimer = setTimeout(() => {
        if (!activeWheelZoomSession || activeWheelZoomSession.id !== sessionId) {
            return;
        }
        const idleMs = Date.now() - activeWheelZoomSession.lastPacketAtMs;
        if (idleMs < WHEEL_ZOOM_SESSION_IDLE_MS) {
            scheduleWheelZoomSessionIdleTimeout(sessionId);
            return;
        }
        endWheelZoomSession('idle-timeout');
    }, WHEEL_ZOOM_SESSION_IDLE_MS + WHEEL_ZOOM_SESSION_LOCK_EXTENSION_MS);
}

function ensureWheelZoomSession(
    nowMs: number,
    anchorX: number,
    anchorY: number,
    eventId: number,
) {
    const current = activeWheelZoomSession;
    const shouldReuseCurrent = Boolean(
        current
        && nowMs - current.lastPacketAtMs <= WHEEL_ZOOM_GESTURE_GRACE_MS,
    );
    if (shouldReuseCurrent && current) {
        if (!zoomVirtualizationFreeze.value) {
            captureZoomVirtualizationFreeze(current.id, 'session-reuse');
        }
        current.lastPacketAtMs = nowMs;
        current.lockUntilMs = nowMs + WHEEL_ZOOM_SESSION_IDLE_MS + WHEEL_ZOOM_SESSION_LOCK_EXTENSION_MS;
        current.lastEventId = eventId;
        scheduleWheelZoomSessionIdleTimeout(current.id);
        return {
            session: current,
            reused: true,
        };
    }

    wheelZoomSessionId += 1;
    const nextSession: IWheelZoomSession = {
        id: wheelZoomSessionId,
        anchorX,
        anchorY,
        startZoom: zoom.value,
        cumulativeDelta: 0,
        lastEmittedZoom: zoom.value,
        startedAtMs: nowMs,
        lastPacketAtMs: nowMs,
        lockUntilMs: nowMs + WHEEL_ZOOM_SESSION_IDLE_MS + WHEEL_ZOOM_SESSION_LOCK_EXTENSION_MS,
        lastEventId: eventId,
        packetCount: 0,
        emittedCount: 0,
        startScrollTop: viewerContainer.value ? Math.round(viewerContainer.value.scrollTop) : null,
        startScrollLeft: viewerContainer.value ? Math.round(viewerContainer.value.scrollLeft) : null,
    };
    activeWheelZoomSession = nextSession;
    captureZoomVirtualizationFreeze(nextSession.id, 'session-start');
    BrowserLogger.warn('pdf-zoom-debug', '[wheel-zoom-session] start', {
        session: nextSession,
        viewer: summarizeViewerStateForLog(),
    });
    scheduleWheelZoomSessionIdleTimeout(nextSession.id);
    return {
        session: nextSession,
        reused: false,
    };
}

function updateZoomRerenderBusyState(busy: boolean, reason: string) {
    isZoomRerenderBusyFromCore = busy;
    zoomRerenderBusyLockUntilMs = Date.now()
        + (busy ? WHEEL_ZOOM_SESSION_LOCK_EXTENSION_MS : WHEEL_ZOOM_GESTURE_GRACE_MS);
    if (busy) {
        markExpectedZoomScroll(WHEEL_ZOOM_EXPECTED_SCROLL_WINDOW_MS);
        captureZoomVirtualizationFreeze(
            activeWheelZoomSession?.id ?? null,
            'core-rerender-busy',
        );
    } else {
        maybeReleaseZoomVirtualizationFreeze('core-rerender-idle');
    }
    BrowserLogger.warn('pdf-zoom-debug', `[wheel-zoom-session] core-busy=${busy}`, {
        reason,
        busy,
        lockUntilMs: zoomRerenderBusyLockUntilMs,
        activeSessionId: activeWheelZoomSession?.id ?? null,
    });
}

function isWheelZoomGestureLocked(nowMs = Date.now()) {
    const session = getActiveWheelZoomSession(nowMs);
    return Boolean(session && nowMs <= session.lockUntilMs);
}

function isZoomInteractionLocked(nowMs = Date.now()) {
    const sessionLocked = isWheelZoomGestureLocked(nowMs);
    const coreLocked = isZoomRerenderBusyFromCore || nowMs <= zoomRerenderBusyLockUntilMs;
    return sessionLocked || coreLocked;
}

function handleViewerModifierWheelZoom(event: WheelEvent) {
    const nowMs = Date.now();
    const debugId = ++zoomDebugWheelEventId;
    const activeSession = getActiveWheelZoomSession(nowMs);
    const isContinuationPacket = Boolean(
        activeSession
        && nowMs - activeSession.lastPacketAtMs <= WHEEL_ZOOM_GESTURE_GRACE_MS,
    );
    const hasModifierZoomSignal = event.ctrlKey
        || event.metaKey
        || Math.abs(event.deltaZ) > Number.EPSILON;
    const shouldTreatAsZoomSignal = hasModifierZoomSignal || isContinuationPacket;
    BrowserLogger.warnThrottled('pdf-zoom-debug', 'wheel-zoom-received', WHEEL_DETAIL_LOG_THROTTLE_MS, `[wheel-zoom] received id=${debugId}`, {
        id: debugId,
        hasModifierZoomSignal,
        shouldTreatAsZoomSignal,
        isContinuationPacket,
        activeSessionId: activeSession?.id ?? null,
        viewer: summarizeViewerStateForLog(),
        wheel: summarizeWheelEventForDebug(event),
    });
    if (!shouldTreatAsZoomSignal) {
        BrowserLogger.warnThrottled(
            'pdf-zoom-debug',
            'wheel-zoom-ignored-no-modifier',
            WHEEL_DETAIL_LOG_THROTTLE_MS,
            `[wheel-zoom] ignored id=${debugId} reason=no-zoom-signal`,
        );
        return false;
    }

    lastModifierWheelZoomAtMs = nowMs;
    lastModifierWheelZoomEventId = debugId;
    markExpectedZoomScroll(WHEEL_ZOOM_EXPECTED_SCROLL_WINDOW_MS);

    event.preventDefault();
    BrowserLogger.warnThrottled(
        'pdf-zoom-debug',
        'wheel-zoom-prevent-default',
        WHEEL_DETAIL_LOG_THROTTLE_MS,
        `[wheel-zoom] prevent-default id=${debugId}`,
        {
            id: debugId,
            cancelable: event.cancelable,
            defaultPrevented: event.defaultPrevented,
        },
    );
    const container = viewerContainer.value;
    if (!container || !src.value || isLoading.value) {
        BrowserLogger.warnThrottled(
            'pdf-zoom-debug',
            'wheel-zoom-ignored-not-ready',
            WHEEL_DETAIL_LOG_THROTTLE_MS,
            `[wheel-zoom] ignored id=${debugId} reason=viewer-not-ready`,
            {
                id: debugId,
                hasContainer: Boolean(container),
                hasSrc: Boolean(src.value),
                isLoading: isLoading.value,
                viewer: summarizeViewerStateForLog(),
            },
        );
        return true;
    }

    const containerRect = container.getBoundingClientRect();
    const eventAnchorX = clamp(
        event.clientX - containerRect.left,
        0,
        Math.max(container.clientWidth, 0),
    );
    const eventAnchorY = clamp(
        event.clientY - containerRect.top,
        0,
        Math.max(container.clientHeight, 0),
    );
    const {
        session,
        reused: reusedGestureAnchor,
    } = ensureWheelZoomSession(nowMs, eventAnchorX, eventAnchorY, debugId);
    session.packetCount += 1;
    const anchorX = session.anchorX;
    const anchorY = session.anchorY;

    let delta = normalizeWheelZoomDelta(event, container);
    if (Math.abs(delta) < Number.EPSILON && Math.abs(event.deltaZ) > Number.EPSILON) {
        delta = event.deltaMode === 1
            ? event.deltaZ * WHEEL_LINE_DELTA_PX
            : event.deltaMode === 2
                ? event.deltaZ * Math.max(container.clientHeight, 1)
                : event.deltaZ;
    }
    if (Math.abs(delta) < Number.EPSILON) {
        BrowserLogger.warnThrottled(
            'pdf-zoom-debug',
            'wheel-zoom-ignored-zero-delta',
            WHEEL_DETAIL_LOG_THROTTLE_MS,
            `[wheel-zoom] ignored id=${debugId} reason=zero-delta`,
            {
                id: debugId,
                wheel: summarizeWheelEventForDebug(event),
            },
        );
        return true;
    }

    session.cumulativeDelta += delta;
    // Match browser feel: wheel up zooms in, wheel down zooms out with
    // exponential scaling for smooth touchpad pinch and Ctrl/Cmd+wheel.
    const zoomFactor = Math.exp(-session.cumulativeDelta * WHEEL_ZOOM_SENSITIVITY);
    if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) {
        BrowserLogger.warnThrottled(
            'pdf-zoom-debug',
            'wheel-zoom-ignored-invalid-factor',
            WHEEL_DETAIL_LOG_THROTTLE_MS,
            `[wheel-zoom] ignored id=${debugId} reason=invalid-factor`,
            {
                id: debugId,
                deltaCumulative: session.cumulativeDelta,
                zoomFactor,
                sessionId: session.id,
            },
        );
        return true;
    }

    const nextZoom = clampZoomLevel(session.startZoom * zoomFactor);
    const previousEmittedZoom = session.lastEmittedZoom;
    if (Math.abs(nextZoom - previousEmittedZoom) < 0.001) {
        BrowserLogger.warnThrottled(
            'pdf-zoom-debug',
            'wheel-zoom-ignored-no-change',
            WHEEL_DETAIL_LOG_THROTTLE_MS,
            `[wheel-zoom] ignored id=${debugId} reason=no-zoom-change`,
            {
                id: debugId,
                sessionId: session.id,
                currentZoom: zoom.value,
                previousEmittedZoom,
                nextZoom,
                delta,
                zoomFactor,
                cumulativeDelta: session.cumulativeDelta,
            },
        );
        return true;
    }
    session.lastEmittedZoom = nextZoom;
    session.lastPacketAtMs = nowMs;
    session.lockUntilMs = nowMs + WHEEL_ZOOM_SESSION_IDLE_MS + WHEEL_ZOOM_SESSION_LOCK_EXTENSION_MS;
    session.emittedCount += 1;
    const snapshotForImmediateRestore = captureScrollSnapshot(container, {
        anchorViewportX: anchorX,
        anchorViewportY: anchorY,
    });
    if (snapshotForImmediateRestore) {
        pendingImmediateZoomRestoreIntent = {
            id: debugId,
            sessionId: session.id,
            snapshot: snapshotForImmediateRestore,
            capturedAtMs: nowMs,
        };
    }

    pendingZoomViewportAnchor.value = {
        id: debugId,
        sessionId: session.id,
        x: anchorX,
        y: anchorY,
        capturedAtMs: nowMs,
    };
    BrowserLogger.warnThrottled('pdf-zoom-debug', 'wheel-zoom-emit', WHEEL_DETAIL_LOG_THROTTLE_MS, `[wheel-zoom] emit id=${debugId}`, {
        id: debugId,
        sessionId: session.id,
        gestureAnchorReused: reusedGestureAnchor,
        sessionStartZoom: session.startZoom,
        sessionCumulativeDelta: session.cumulativeDelta,
        eventAnchorX,
        eventAnchorY,
        delta,
        zoomFactor,
        currentZoom: zoom.value,
        previousEmittedZoom,
        nextZoom,
        anchor: pendingZoomViewportAnchor.value,
        viewerBeforeEmit: summarizeViewerStateForLog(),
        wheel: summarizeWheelEventForDebug(event),
    });

    emit('update:zoom', nextZoom);
    markExpectedZoomScroll(WHEEL_ZOOM_EXPECTED_SCROLL_WINDOW_MS);
    return true;
}

function handleViewerWheel(event: WheelEvent) {
    const nowMs = Date.now();
    const recentZoomAnchor = pendingZoomViewportAnchor.value;
    const recentZoomAgeMs = recentZoomAnchor
        ? nowMs - recentZoomAnchor.capturedAtMs
        : null;
    const modifierZoomAgeMs = lastModifierWheelZoomAtMs > 0
        ? nowMs - lastModifierWheelZoomAtMs
        : null;
    const isWithinModifierZoomGraceWindow = modifierZoomAgeMs !== null
        && modifierZoomAgeMs <= WHEEL_ZOOM_GESTURE_GRACE_MS;
    const activeSession = getActiveWheelZoomSession(nowMs);
    const zoomInteractionLocked = isZoomInteractionLocked(nowMs);
    BrowserLogger.warnThrottled('pdf-zoom-debug', 'wheel-dispatch', WHEEL_DISPATCH_LOG_THROTTLE_MS, '[wheel] dispatch', {
        recentZoomIntentId: recentZoomAnchor?.id ?? null,
        recentZoomAgeMs,
        recentModifierZoomEventId: lastModifierWheelZoomEventId || null,
        modifierZoomAgeMs,
        withinModifierZoomGraceWindow: isWithinModifierZoomGraceWindow,
        activeSessionId: activeSession?.id ?? null,
        zoomInteractionLocked,
        coreZoomRerenderBusy: isZoomRerenderBusyFromCore,
        coreZoomRerenderLockAgeMs: zoomRerenderBusyLockUntilMs > nowMs
            ? zoomRerenderBusyLockUntilMs - nowMs
            : 0,
        viewer: summarizeViewerStateForLog(),
        wheel: summarizeWheelEventForDebug(event),
    });
    if (isSnipActive()) {
        event.preventDefault();
        BrowserLogger.warnThrottled('pdf-zoom-debug', 'wheel-blocked-snip', WHEEL_DETAIL_LOG_THROTTLE_MS, '[wheel] blocked by snip mode');
        return;
    }

    if (handleViewerModifierWheelZoom(event)) {
        singlePageScroll.suppressSnapFor(
            Math.max(
                WHEEL_ZOOM_SESSION_IDLE_MS + WHEEL_ZOOM_SESSION_LOCK_EXTENSION_MS,
                WHEEL_ZOOM_EXPECTED_SCROLL_WINDOW_MS,
            ),
        );
        cancelPendingSearchScroll();
        return;
    }

    if (zoomInteractionLocked || isWithinModifierZoomGraceWindow) {
        event.preventDefault();
        singlePageScroll.suppressSnapFor(
            Math.max(
                WHEEL_ZOOM_SESSION_IDLE_MS + WHEEL_ZOOM_SESSION_LOCK_EXTENSION_MS,
                WHEEL_ZOOM_EXPECTED_SCROLL_WINDOW_MS,
            ),
        );
        BrowserLogger.warnThrottled(
            'pdf-zoom-debug',
            'wheel-suppressed-non-modifier',
            WHEEL_DETAIL_LOG_THROTTLE_MS,
            '[wheel] suppressed non-modifier packet during active zoom lock',
            {
                zoomInteractionLocked,
                graceWindowMs: WHEEL_ZOOM_GESTURE_GRACE_MS,
                recentModifierZoomEventId: lastModifierWheelZoomEventId || null,
                modifierZoomAgeMs,
                activeSessionId: activeSession?.id ?? null,
                viewer: summarizeViewerStateForLog(),
                wheel: summarizeWheelEventForDebug(event),
            },
        );
        cancelPendingSearchScroll();
        return;
    }

    cancelPendingSearchScroll();
    singlePageScroll.handleWheel(event);
}

function handleViewerScroll(event: Event) {
    const nowMs = Date.now();
    const container = viewerContainer.value;
    const currentTop = container ? Math.round(container.scrollTop) : null;
    const currentLeft = container ? Math.round(container.scrollLeft) : null;
    const deltaTop = currentTop === null ? null : currentTop - lastViewerScrollTop;
    const deltaLeft = currentLeft === null ? null : currentLeft - lastViewerScrollLeft;

    if (currentTop !== null) {
        lastViewerScrollTop = currentTop;
    }
    if (currentLeft !== null) {
        lastViewerScrollLeft = currentLeft;
    }

    const activeZoomIntent = pendingZoomViewportAnchor.value;
    const activeSession = getActiveWheelZoomSession(nowMs);
    const zoomInteractionLocked = isZoomInteractionLocked(nowMs);
    const zoomScrollExpected = nowMs <= expectedZoomScrollUntilMs;
    BrowserLogger.warnThrottled('pdf-zoom-debug', 'scroll-viewer', WHEEL_SCROLL_LOG_THROTTLE_MS, '[scroll] viewer', {
        type: event.type,
        deltaTop,
        deltaLeft,
        viewer: summarizeViewerStateForLog(),
        activeZoomIntentId: activeZoomIntent?.id ?? null,
        activeZoomIntentAgeMs: activeZoomIntent
            ? nowMs - activeZoomIntent.capturedAtMs
            : null,
        activeSessionId: activeSession?.id ?? null,
        zoomInteractionLocked,
        zoomScrollExpected,
    });
    if (
        zoomInteractionLocked
        && !zoomScrollExpected
        && (
            (typeof deltaTop === 'number' && Math.abs(deltaTop) >= 10)
            || (typeof deltaLeft === 'number' && Math.abs(deltaLeft) >= 10)
        )
    ) {
        BrowserLogger.warnThrottled(
            'pdf-zoom-debug',
            'scroll-drift-unexpected-during-zoom-lock',
            WHEEL_SCROLL_LOG_THROTTLE_MS,
            '[scroll-drift] unexpected scroll delta during active zoom lock',
            {
                deltaTop,
                deltaLeft,
                activeSessionId: activeSession?.id ?? null,
                recentZoomIntentId: activeZoomIntent?.id ?? null,
                recentZoomIntentAgeMs: activeZoomIntent
                    ? nowMs - activeZoomIntent.capturedAtMs
                    : null,
                expectedZoomScrollUntilMs,
                viewer: summarizeViewerStateForLog(),
            },
        );
    }

    if (zoomInteractionLocked || zoomScrollExpected) {
        singlePageScroll.suppressSnapFor(
            Math.max(
                WHEEL_ZOOM_SESSION_IDLE_MS + WHEEL_ZOOM_SESSION_LOCK_EXTENSION_MS,
                WHEEL_ZOOM_EXPECTED_SCROLL_WINDOW_MS,
            ),
        );
    }

    singlePageScroll.handleScroll();
}

function handleViewerMouseDown(event: MouseEvent) {
    if (isSnipActive()) {
        return;
    }
    if (
        event.target instanceof HTMLElement &&
        event.target.closest(
            '.pdf-inline-comment-anchor-marker, .pdf-inline-comment-marker, .pdf-comment-marker-button, .pdf-annotation-has-note-target, .pdf-annotation-has-comment, .annotationLayer .popupTriggerArea, .annotation-layer .popupTriggerArea',
        )
    ) {
        event.preventDefault();
    }
    cancelPendingSearchScroll();
    handleDragStart(event);
}

function handleViewerMouseMove(event: MouseEvent) {
    if (isSnipActive()) {
        return;
    }
    handleDragMove(event);
}

function handleViewerMouseUp() {
    if (isSnipActive()) {
        return;
    }
    highlightComposable.handleViewerMouseUp();
}

function handleViewerMouseLeave() {
    if (isSnipActive()) {
        return;
    }
    stopDrag();
}

function handleViewerClick(event: MouseEvent) {
    if (isSnipActive()) {
        return;
    }
    commentCrud.handleAnnotationCommentClick(event);
}

function handleViewerDblClick(event: MouseEvent) {
    if (isSnipActive()) {
        return;
    }
    commentCrud.handleAnnotationEditorDblClick(event);
}

function handleViewerContextMenu(event: MouseEvent) {
    if (isSnipActive()) {
        event.preventDefault();
        return;
    }
    commentCrud.handleAnnotationCommentContextMenu(event);
}

function applyStampImage(file: File) {
    const uiManager = annotationUiManager.value;
    if (!uiManager) {
        return;
    }
    uiManager.updateParams(AnnotationEditorParamsType.CREATE, { bitmapFile: file });
}

function getSelectedShape(): IShapeAnnotation | null {
    const id = shapeComposable.selectedShapeId.value;
    if (!id) {
        return null;
    }
    return shapeComposable.getShapeById(id);
}

function updateShape(id: string, updates: Partial<IShapeAnnotation>) {
    const previousShape = shapeComposable.getShapeById(id);
    if (!previousShape) {
        return;
    }

    const hasChanges = Object.entries(updates).some(
        ([
            key,
            value,
        ]) => previousShape[key as keyof IShapeAnnotation] !== value,
    );
    if (!hasChanges) {
        return;
    }

    const nextShape: IShapeAnnotation = {
        ...previousShape,
        ...updates,
    };

    shapeComposable.updateShape(id, updates);
    emit('annotation-modified');

    registerShapeHistoryCommand({
        cmd: () => {
            shapeComposable.updateShape(id, nextShape);
            shapeComposable.selectShape(id);
            emit('annotation-modified');
        },
        undo: () => {
            shapeComposable.updateShape(id, previousShape);
            shapeComposable.selectShape(id);
            emit('annotation-modified');
        },
    });
}

function deleteSelectedShape() {
    const id = shapeComposable.selectedShapeId.value;
    if (!id) {
        return;
    }

    const deletedShape = shapeComposable.getShapeById(id);
    if (!deletedShape) {
        return;
    }

    shapeComposable.deleteShape(id);
    emit('annotation-modified');

    registerShapeHistoryCommand({
        cmd: () => {
            shapeComposable.deleteShape(id);
            emit('annotation-modified');
        },
        undo: () => {
            shapeComposable.addShape(deletedShape);
            shapeComposable.selectShape(id);
            emit('annotation-modified');
        },
    });
}

defineExpose({
    getViewerContainer: () => viewerContainer.value,
    scrollToPage: (pageNumber: number) => {
        cancelPendingSearchScroll();
        singlePageScroll.scrollToPage(pageNumber);
    },
    saveDocument,
    highlightSelection: highlightComposable.highlightSelection,
    commentSelection: highlightComposable.commentSelection,
    commentAtPoint: highlightComposable.commentAtPoint,
    startCommentPlacement: highlightComposable.startCommentPlacement,
    cancelCommentPlacement: highlightComposable.cancelCommentPlacement,
    undoAnnotation,
    redoAnnotation,
    focusAnnotationComment: commentCrud.focusAnnotationComment,
    updateAnnotationComment: commentCrud.updateAnnotationComment,
    deleteAnnotationComment: commentCrud.deleteAnnotationComment,
    getMarkupSubtypeOverrides: annotations.editor.getMarkupSubtypeOverrides,
    getAllShapes: shapeComposable.getAllShapes,
    loadShapes: shapeComposable.loadShapes,
    clearShapes: shapeComposable.clearShapes,
    deleteSelectedShape,
    hasShapes: shapeComposable.hasShapes,
    selectedShapeId: shapeComposable.selectedShapeId,
    updateShape,
    getSelectedShape,
    applyStampImage,
    invalidatePages,
    captureRegionToClipboard: regionSnip.startCaptureSession,
    isCapturingRegion: regionSnip.isActive,
    requestScrollToCurrentResult,
});
</script>

<style lang="scss">
/* ── Page Container & Canvas ───────────────────────────────────────── */

.page_container {
    position: relative;
    margin: 0 auto;
    flex-shrink: 0;

    --scale-round-x: 1px;
    --scale-round-y: 1px;

    canvas {
        background: transparent;
        box-shadow: none;
        border-radius: inherit;
    }
}

.pdf-viewer-virtual-spacer {
    flex-shrink: 0;
    width: 1px;
    pointer-events: none;
    opacity: 0;
}

.pdfViewer .page_container--rendered .pdf-page-skeleton {
    display: none;
}

.page_canvas {
    position: relative;
    width: 100%;
    height: 100%;
    z-index: 0;
    background: var(--pdf-page-bg);
    box-shadow: var(--pdf-page-shadow);
    border-radius: 2px;

    > canvas {
        width: 100% !important;
        height: 100% !important;
    }
}

/* ── Text Layer (PDF.js) ───────────────────────────────────────────── */

.pdfViewer .text-layer {
    position: absolute;
    text-align: initial;
    inset: 0;
    overflow: clip;
    opacity: 1;
    line-height: 1;
    text-size-adjust: none;
    forced-color-adjust: none;
    transform-origin: 0 0;
    caret-color: CanvasText;
    z-index: 1;
    pointer-events: auto;
    user-select: text;

    --min-font-size: 1;
    --text-scale-factor: calc(var(--total-scale-factor, 1) * var(--min-font-size));
    --min-font-size-inv: calc(1 / var(--min-font-size));

    span,
    br {
        color: transparent;
        position: absolute;
        white-space: pre;
        cursor: text;
        transform-origin: 0% 0%;
    }

    > :not(.markedContent),
    .markedContent span:not(.markedContent) {
        z-index: 1;
        font-size: calc(var(--text-scale-factor) * var(--font-height, 10px));
        transform: rotate(var(--rotate, 0deg)) scaleX(var(--scale-x, 1)) scale(var(--min-font-size-inv));
    }

    .markedContent {
        display: contents;
    }

    br {
        user-select: none;
    }

    ::selection {
        background: var(--app-pdf-text-selection-bg);
    }

    br::selection {
        background: transparent;
    }

    .end-of-content {
        display: block;
        position: absolute;
        inset: 100% 0 0;
        z-index: 0;
        cursor: default;
        user-select: none;
    }

    &.selecting .end-of-content {
        top: 0;
    }
}

/* ── Annotation Layers ─────────────────────────────────────────────── */

.pdfViewer .annotation-layer {
    position: absolute;
    inset: 0;
    overflow: hidden;
    z-index: 2;
    pointer-events: none;

    a {
        pointer-events: auto;
        display: block;
        position: absolute;
    }

    section {
        position: absolute;
    }

    .linkAnnotation > a {
        background: var(--app-pdf-link-bg);
        transition: background 150ms ease;

        &:hover {
            background: var(--app-pdf-link-hover-bg);
        }
    }
}

.pdfViewer .annotation-editor-layer,
.pdfViewer .annotationEditorLayer {
    position: absolute;
    inset: 0;
    z-index: 3;
}

.pdfViewer.pdfViewer--resize-transition .page_container .pdf-page-skeleton {
    display: flex !important;
}

.pdfViewer.pdfViewer--resize-transition .page_canvas,
.pdfViewer.pdfViewer--resize-transition .text-layer,
.pdfViewer.pdfViewer--resize-transition .annotation-layer,
.pdfViewer.pdfViewer--resize-transition .annotation-editor-layer,
.pdfViewer.pdfViewer--resize-transition .pdf-shape-overlay {
    opacity: 0;
    pointer-events: none;
}

/* ── Container & Viewer ────────────────────────────────────────────── */

.pdfViewer {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: auto;
    scroll-behavior: auto;
    overflow-anchor: none;
    background: var(--app-pdf-viewer-bg);
    display: flex;
    flex-direction: column;

    &.pdfViewer--mode-facing,
    &.pdfViewer--mode-facing-first-single {
        display: grid;
        grid-template-columns: repeat(2, max-content);
        place-content: flex-start center;
    }

    &.is-placing-comment {
        cursor: crosshair;
    }

    &.pdfViewer--fit-height {
        overflow-x: auto;
    }

    &.pdfViewer--single-page {
        scroll-snap-type: y mandatory;
        scroll-snap-stop: always;
    }

    &.pdfViewer--single-page.pdfViewer--zoom-snap-suppressed {
        scroll-snap-type: none;
        scroll-snap-stop: normal;
    }

    &.pdfViewer--hidden {
        opacity: 0;
        pointer-events: none;
    }

    /* Hidden PDF.js UI — Okular-style workflow: comment editing is handled from side reviews + note window. */
    /* stylelint-disable selector-id-pattern -- pdf.js internal element ID */
    .editToolbar,
    .annotationCommentButton,
    .popupTriggerArea,
    .commentPopup,
    #commentManagerDialog {
        display: none !important;
    }
    /* stylelint-enable selector-id-pattern */
}

.pdfViewer.pdfViewer--mode-facing .page_container,
.pdfViewer.pdfViewer--mode-facing-first-single .page_container {
    margin: 0;
}

.pdfViewer .page_container--spread-single {
    grid-column: 1 / -1;
    justify-self: center;
}

/* ── Drag Mode Cursor Overrides ────────────────────────────────────── */

.pdfViewer.drag-mode {
    &.is-dragging {
        cursor: grabbing !important;
        user-select: none;
    }

    &:not(.is-dragging) {
        cursor: grab !important;
    }

    *,
    &.is-dragging * {
        cursor: inherit !important;
    }

    /* stylelint-disable no-descending-specificity -- drag mode uses !important on all props; specificity order is irrelevant */
    .text-layer,
    .text-layer span,
    .text-layer br,
    .annotation-layer a,
    .annotation-editor-layer,
    .annotationEditorLayer,
    .page_container,
    .page_container canvas,
    .annotationLayer,
    .annotationLayer *,
    .canvasWrapper {
        cursor: inherit !important;
        user-select: none !important;
        pointer-events: none !important;
    }
    /* stylelint-enable no-descending-specificity */
}

/* ── Markup Subtype Visual Overrides (underline / strikethrough) ──── */

.pdfViewer .annotationEditorLayer .highlightEditor[class*='pdf-markup-subtype-underline'] .internal,
.pdfViewer .annotation-editor-layer .highlightEditor[class*='pdf-markup-subtype-underline'] .internal,
.pdfViewer .annotationEditorLayer .highlightEditor[class*='pdf-markup-subtype-strikeout'] .internal,
.pdfViewer .annotation-editor-layer .highlightEditor[class*='pdf-markup-subtype-strikeout'] .internal {
    opacity: 0 !important;
}

.pdfViewer svg.highlight.pdf-markup-subtype-draw-underline,
.pdfViewer svg.highlight.pdf-markup-subtype-draw-strikeout {
    fill: transparent !important;
    fill-opacity: 0 !important;
    mix-blend-mode: normal !important;
}

.pdfViewer .annotationEditorLayer .highlightEditor[class*='pdf-markup-subtype-underline']::after,
.pdfViewer .annotation-editor-layer .highlightEditor[class*='pdf-markup-subtype-underline']::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: 7%;
    border-bottom: max(1.5px, calc(var(--total-scale-factor, 1) * 1px)) solid var(--pdf-markup-subtype-color, #2563eb);
    pointer-events: none;
}

.pdfViewer .annotationEditorLayer .highlightEditor[class*='pdf-markup-subtype-strikeout']::after,
.pdfViewer .annotation-editor-layer .highlightEditor[class*='pdf-markup-subtype-strikeout']::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    border-top: max(1.5px, calc(var(--total-scale-factor, 1) * 1px)) solid var(--pdf-markup-subtype-color, #dc2626);
    pointer-events: none;
}

/* ── Dark Mode (Invert Colors) Overrides ───────────────────────────── */

.pdf-viewer-container--dark {
    .text-layer ::selection {
        background: var(--app-pdf-text-selection-bg);
    }

    /* stylelint-disable no-descending-specificity -- dark mode filter targets different properties than drag mode */
    .page_container,
    .page_container canvas {
        filter: invert(1) hue-rotate(180deg) saturate(1.05);
    }
    /* stylelint-enable no-descending-specificity */

    .pdfViewer {
        background: var(--app-pdf-viewer-bg);
    }
}

/* ── Single-Page Snap (after dark mode to satisfy specificity order) ── */

.pdfViewer.pdfViewer--single-page .page_container {
    scroll-snap-align: center;
}

.page {
    margin: 1px auto -3px !important;
    border: 1px dashed transparent !important;
    box-shadow: var(--pdf-page-shadow);
    box-sizing: content-box;
    user-select: none;
    position: relative;
}

/* ── FreeText Editor & Resize Handles ──────────────────────────────── */

.pdfViewer .freeTextEditor {
    --resizer-size: var(--evb-resizer-size, clamp(6px, calc(8px / var(--total-scale-factor, 1)), 10px));
    --resizer-shift: calc(
        0px - (var(--outline-width, 1px) + var(--resizer-size)) / 2 - var(--outline-around-width, 0px)
    );

    .overlay.enabled {
        display: block !important;
    }

    > .resizers {
        pointer-events: none;

        > .resizer {
            pointer-events: auto;
            background: transparent !important;
            border: none !important;
            box-sizing: border-box;
            touch-action: none;

            &::after {
                content: '';
                position: absolute;
                width: 6px;
                height: 6px;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: var(--resizer-bg-color, #0060df);
                border-radius: 2px;
                pointer-events: none;
            }

            &.topLeft,
            &.bottomRight {
                cursor: nwse-resize !important;
            }

            &.topRight,
            &.bottomLeft {
                cursor: nesw-resize !important;
            }

            &.topMiddle,
            &.middleRight,
            &.bottomMiddle,
            &.middleLeft {
                display: none !important;
            }
        }
    }
}

.pdfViewer .annotationEditorLayer.disabled.nonEditing .freeTextEditor,
.pdfViewer .annotation-editor-layer.disabled.nonEditing .freeTextEditor {
    pointer-events: auto !important;
}

.pdfViewer .annotationEditorLayer.disabled.nonEditing .freeTextEditor > .resizers,
.pdfViewer .annotation-editor-layer.disabled.nonEditing .freeTextEditor > .resizers,
.pdfViewer .annotationEditorLayer.disabled.nonEditing .freeTextEditor > .resizers > .resizer,
.pdfViewer .annotation-editor-layer.disabled.nonEditing .freeTextEditor > .resizers > .resizer,
.pdfViewer .annotationEditorLayer.disabled.nonEditing .freeTextEditor .overlay,
.pdfViewer .annotation-editor-layer.disabled.nonEditing .freeTextEditor .overlay {
    pointer-events: auto !important;
}
</style>
