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
                'drag-mode': isViewerPanDragModeActive,
                'is-placing-comment': highlightComposable.isPlacingComment.value,
                'is-selection-markup-tool': isSelectionMarkupToolActive,
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
            @selectstart="handleSelectStart"
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
                :placeholder-style="getPagePlaceholderStyle(page)"
                :placed-image="pendingImagePlacement?.pageNumber === page ? pendingImagePlacement : null"
                :placed-image-busy="isPendingImagePlacementFinalizing"
                @update-placed-image-rect="updatePendingImagePlacementRect"
                @finalize-placed-image="requestPendingImagePlacementFinalize"
                @cancel-placed-image="clearPendingImagePlacement"
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
        <PdfCropOverlay
            :active="cropSelection.isSelecting.value"
            :selection-rect="cropSelection.selectionRect.value"
            :hint-label="t('toolbar.cropHint')"
            @pointer-start="cropSelection.onPointerStart"
            @pointer-move="cropSelection.onPointerMove"
            @pointer-end="cropSelection.onPointerEnd"
            @cancel="cropSelection.cancelSelection"
        />
        <template v-for="[pageNum, markers] in markersByPage" :key="`markers-${pageNum}`">
            <Teleport v-if="markerLayerTargets.get(pageNum)" :to="markerLayerTargets.get(pageNum)!">
                <PdfCommentMarkerLayer
                    :page-number="pageNum"
                    :markers="markers"
                    @open-note="handleMarkerOpenNote"
                    @context-menu="handleMarkerContextMenu"
                    @move-marker="handleMarkerMove"
                />
            </Teleport>
        </template>
        <template v-for="(links, pageNum) in linksByPage" :key="`links-${pageNum}`">
            <Teleport v-if="linkLayerTargets.get(Number(pageNum))" :to="linkLayerTargets.get(Number(pageNum))!">
                <PdfLinkOverlayLayer :links="links" />
            </Teleport>
        </template>
    </div>
</template>

<script setup lang="ts">

import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { GenericL10n } from 'pdfjs-dist/web/pdf_viewer.mjs';
import PdfViewerPage from '@app/components/pdf/PdfViewerPage.vue';
import PdfRegionSnipOverlay from '@app/components/pdf/PdfRegionSnipOverlay.vue';
import PdfCropOverlay from '@app/components/pdf/PdfCropOverlay.vue';
import PdfCommentMarkerLayer from '@app/components/pdf/annotations/PdfCommentMarkerLayer.vue';
import PdfLinkOverlayLayer from '@app/components/pdf/annotations/PdfLinkOverlayLayer.vue';
import { usePdfDocument } from '@app/composables/pdf/usePdfDocument';
import { usePdfDrag } from '@app/composables/pdf/usePdfDrag';
import { usePdfPageRenderer } from '@app/composables/pdf/usePdfPageRenderer';
import type { IPageRenderStallPayload } from '@app/composables/pdf/usePdfPageRenderer';
import { usePdfScale } from '@app/composables/pdf/usePdfScale';
import { usePdfScroll } from '@app/composables/pdf/usePdfScroll';
import { usePdfSkeletonInsets } from '@app/composables/pdf/usePdfSkeletonInsets';
import { computeInitialImagePlacementDimensions } from '@app/composables/pdf/pdfImagePlacementSizing';
import { useAnnotationShapes } from '@app/composables/pdf/useAnnotationShapes';
import { clamp } from 'es-toolkit/math';
import { usePdfSinglePageScroll } from '@app/composables/pdf/usePdfSinglePageScroll';
import { useAnnotationOrchestrator } from '@app/composables/pdf/annotations/useAnnotationOrchestrator';
import { usePdfViewerCore } from '@app/modules/pdf-viewer-runtime/usePdfViewerCore';
import {
    usePdfViewerVirtualization,
    type IZoomVirtualizationFreeze,
} from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerVirtualization';
import { usePdfShapeContext } from '@app/composables/pdf/usePdfShapeContext';
import { usePdfRegionSnip } from '@app/composables/pdf/usePdfRegionSnip';
import { usePdfCropSelection } from '@app/composables/pdf/usePdfCropSelection';
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
    TZoomMode,
    TPdfViewMode,
} from '@app/types/pdf';
import { isStandaloneSpreadPage } from '@app/utils/pdf-view-mode';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    IAnnotationMarkerRect,
    IAnnotationSettings,
    IShapeAnnotation,
    TAnnotationTool,
} from '@app/types/annotations';
import type {
    IPdfImagePlacementDraft,
    IPdfImagePlacementRectUpdate,
    IPdfPlacedImageFinalizePayload,
} from '@app/types/pdf-image-placement';
import type { IAnnotationContextMenuPayload } from '@app/composables/pdf/annotations/types';
import { isSelectionMarkupTool } from '@app/composables/pdf/annotations/types';
import { logPdfNav } from '@app/utils/pdf-nav-log';
import { BrowserLogger } from '@app/utils/browser-logger';

import '@app/assets/css/vendor/pdfjs-viewer-sanitized.css';

interface IProps {
    src: TPdfSource | null;
    bufferPages?: number;
    zoom?: number;
    zoomMode?: TZoomMode;
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
const zoomMode = computed<TZoomMode>(() => props.zoomMode ?? (
    fitMode.value === 'height' ? 'fit-height' : 'fit-width'
));
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
    (e: 'update:zoomMode', mode: TZoomMode): void;
    (e: 'update:fitMode', mode: TFitMode): void;
    (e: 'update:effectiveZoom', value: number): void;
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
    (e: 'image-placement-finalize', payload: IPdfPlacedImageFinalizePayload): void;
}>();

const viewerHost = ref<HTMLElement | null>(null);
const viewerContainer = ref<HTMLElement | null>(null);
const resizeTransitionVisible = ref(false);
const annotationUiManager = shallowRef<AnnotationEditorUIManager | null>(null);
const annotationL10n = shallowRef<GenericL10n | null>(null);
const annotationCommentsCache = shallowRef<IAnnotationCommentSummary[]>([]);
const pendingMarkerMoves = new Map<string, IAnnotationMarkerRect>();
const activeCommentStableKey = ref<string | null>(null);
const pendingImagePlacement = ref<IPdfImagePlacementDraft | null>(null);
const isPendingImagePlacementFinalizing = ref(false);
const isImagePlacementActive = computed(() => pendingImagePlacement.value !== null);
const isViewerPanDragModeActive = computed(() => dragMode.value && !isImagePlacementActive.value);
const isSelectionMarkupToolActive = computed(() => isSelectionMarkupTool(annotationTool.value));
const regionSnip = usePdfRegionSnip({ viewerContainer });
const cropSelection = usePdfCropSelection({ viewerContainer });
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
    pageMetrics,
    saveDocument,
} = pdfDocumentResult;

const {
    currentPage,
    visibleRange,
    getMostVisiblePage,
    scrollToPage: scrollToPageInternal,
    updateCurrentPage,
    updateVisibleRange,
    setPageLayoutMetrics,
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
} = usePdfDrag(() => isViewerPanDragModeActive.value);
watch(isImagePlacementActive, (active) => {
    if (active) {
        stopDrag();
    }
});
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
    pageMetrics,
    basePageWidth,
    basePageHeight,
);

watch(
    () => effectiveScale.value,
    (value) => {
        emit('update:effectiveZoom', value);
    },
    { immediate: true },
);
const {
    computeSkeletonInsets,
    resetInsets,
} = usePdfSkeletonInsets(basePageWidth, basePageHeight, effectiveScale);

const shapeComposable = useAnnotationShapes();
let pageRenderStallRecoveryHandler: ((payload: IPageRenderStallPayload) => void) | null = null;

function relayPageRenderStall(payload: IPageRenderStallPayload) {
    pageRenderStallRecoveryHandler?.(payload);
}

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
    onRenderStall: relayPageRenderStall,
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
    emitAnnotationComments: (comments) => {
        if (pendingMarkerMoves.size > 0) {
            const merged = comments.map((c) => {
                const rect = pendingMarkerMoves.get(c.stableKey);
                if (!rect) {
                    return c;
                }
                return {
                    ...c,
                    markerRect: rect,
                };
            });
            annotationCommentsCache.value = merged;
            emit('annotation-comments', merged);
            return;
        }
        emit('annotation-comments', comments);
    },
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
const linksByPage = annotations.linksByPage;

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

const linkLayerTargets = computed<Map<number, HTMLElement>>(() => {
    const container = viewerContainer.value;
    if (!container) {
        return new Map();
    }
    const targets = new Map<number, HTMLElement>();
    for (const pageNumber of Object.keys(linksByPage.value).map(Number)) {
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

function handleMarkerMove(comment: IAnnotationCommentSummary, markerRect: IAnnotationMarkerRect) {
    const index = annotationCommentsCache.value.findIndex(c => c.stableKey === comment.stableKey);
    if (index === -1) {
        return;
    }
    pendingMarkerMoves.set(comment.stableKey, markerRect);
    const updated = {
        ...annotationCommentsCache.value[index]!,
        markerRect,
    };
    const next = [...annotationCommentsCache.value];
    next[index] = updated;
    annotationCommentsCache.value = next;
    emit('annotation-comments', next);
    emit('annotation-modified');
}

const {
    shouldShowSkeleton,
    handleDragStart,
    handleDragMove,
    undoAnnotation,
    redoAnnotation,
    invalidatePages,
    handlePageRenderStall: handlePageRenderStallFromCore,
} = usePdfViewerCore({
    viewerContainer,
    src,
    zoom,
    zoomMode,
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
pageRenderStallRecoveryHandler = handlePageRenderStallFromCore;

const {
    pageLayout,
    getPagePlaceholderStyle,
    virtualizedContinuousMode,
    searchNavigationWindow,
    virtualWindowStart,
    virtualWindowEnd,
    topVirtualSpacerStyle,
    bottomVirtualSpacerStyle,
    pagesToRender,
} = usePdfViewerVirtualization({
    bufferPages,
    continuousScroll,
    viewMode,
    numPages,
    basePageWidth,
    basePageHeight,
    pageMetrics,
    effectiveScale,
    scaledMargin,
    visibleRange,
    searchNavigationTargetPage: singlePageScroll.searchNavigationTargetPage,
    zoomVirtualizationFreeze,
});

function captureZoomVirtualizationFreeze(sessionId: number | null, reason: string) {
    if (!virtualizedContinuousMode.value || numPages.value <= 0) {
        zoomVirtualizationFreeze.value = null;
        return;
    }

    const topSpacerHeight = Number.parseFloat(
        topVirtualSpacerStyle.value?.height ?? '0',
    );
    const bottomSpacerHeight = Number.parseFloat(
        bottomVirtualSpacerStyle.value?.height ?? '0',
    );

    zoomVirtualizationFreeze.value = {
        sessionId,
        capturedAtMs: Date.now(),
        windowStart: virtualWindowStart.value,
        windowEnd: virtualWindowEnd.value,
        topSpacerHeight: Number.isFinite(topSpacerHeight) ? Math.max(0, topSpacerHeight) : 0,
        bottomSpacerHeight: Number.isFinite(bottomSpacerHeight) ? Math.max(0, bottomSpacerHeight) : 0,
    };

    BrowserLogger.warnThrottled(
        'pdf-zoom-debug',
        'virtualization-freeze-capture',
        WHEEL_DETAIL_LOG_THROTTLE_MS,
        `[zoom-virtualization] capture reason=${reason}`,
        {
            reason,
            freeze: zoomVirtualizationFreeze.value,
            currentPage: currentPage.value,
            visibleRange: {
                start: visibleRange.value.start,
                end: visibleRange.value.end,
            },
            viewer: summarizeViewerStateForLog(),
        },
    );
}

function releaseZoomVirtualizationFreeze(reason: string) {
    if (!zoomVirtualizationFreeze.value) {
        return;
    }

    BrowserLogger.warnThrottled(
        'pdf-zoom-debug',
        'virtualization-freeze-release',
        WHEEL_DETAIL_LOG_THROTTLE_MS,
        `[zoom-virtualization] release reason=${reason}`,
        {
            reason,
            freeze: zoomVirtualizationFreeze.value,
            viewer: summarizeViewerStateForLog(),
        },
    );
    zoomVirtualizationFreeze.value = null;
}

function shouldHoldZoomVirtualizationFreeze(nowMs = Date.now()) {
    if (!virtualizedContinuousMode.value) {
        return false;
    }

    if (isZoomRerenderBusyFromCore || zoomSnapSuppressed.value || nowMs <= expectedZoomScrollUntilMs) {
        return true;
    }

    return Boolean(getActiveWheelZoomSession(nowMs));
}

function maybeReleaseZoomVirtualizationFreeze(reason: string) {
    if (shouldHoldZoomVirtualizationFreeze()) {
        return;
    }
    releaseZoomVirtualizationFreeze(reason);
}

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

watch(() => src.value, (next, previous) => {
    if (next !== previous) {
        clearPendingImagePlacement();
    }
});

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
    if (viewMode.value === 'single' && pageLayout.value) {
        setPageLayoutMetrics(pageLayout.value);
        return;
    }

    setPageLayoutMetrics(null);
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
    clearPendingImagePlacement();
    setPageLayoutMetrics(null);
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
    return regionSnip.isActive.value || cropSelection.isSelecting.value;
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

function resolveZoomBaselineScale() {
    if (!Number.isFinite(zoom.value) || Math.abs(zoom.value) < 0.0001) {
        return 1;
    }
    const baseline = effectiveScale.value / zoom.value;
    if (!Number.isFinite(baseline) || baseline <= 0) {
        return 1;
    }
    return baseline;
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
        startZoom: effectiveScale.value,
        cumulativeDelta: 0,
        lastEmittedZoom: effectiveScale.value,
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

    const nextEffectiveZoom = clampZoomLevel(session.startZoom * zoomFactor);
    const previousEmittedZoom = session.lastEmittedZoom;
    if (Math.abs(nextEffectiveZoom - previousEmittedZoom) < 0.001) {
        BrowserLogger.warnThrottled(
            'pdf-zoom-debug',
            'wheel-zoom-ignored-no-change',
            WHEEL_DETAIL_LOG_THROTTLE_MS,
            `[wheel-zoom] ignored id=${debugId} reason=no-zoom-change`,
            {
                id: debugId,
                sessionId: session.id,
                currentZoomMultiplier: zoom.value,
                currentEffectiveZoom: effectiveScale.value,
                previousEmittedZoom,
                nextEffectiveZoom,
                delta,
                zoomFactor,
                cumulativeDelta: session.cumulativeDelta,
            },
        );
        return true;
    }
    session.lastEmittedZoom = nextEffectiveZoom;
    session.lastPacketAtMs = nowMs;
    session.lockUntilMs = nowMs + WHEEL_ZOOM_SESSION_IDLE_MS + WHEEL_ZOOM_SESSION_LOCK_EXTENSION_MS;
    session.emittedCount += 1;
    const baselineScale = resolveZoomBaselineScale();
    const nextZoom = clampZoomLevel(nextEffectiveZoom / baselineScale);
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
        currentZoomMultiplier: zoom.value,
        currentEffectiveZoom: effectiveScale.value,
        baselineScale,
        previousEmittedZoom,
        nextEffectiveZoom,
        nextZoom,
        anchor: pendingZoomViewportAnchor.value,
        viewerBeforeEmit: summarizeViewerStateForLog(),
        wheel: summarizeWheelEventForDebug(event),
    });

    if (zoomMode.value !== 'custom') {
        emit('update:zoomMode', 'custom');
    }
    emit('update:effectiveZoom', nextEffectiveZoom);
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
        event.target instanceof HTMLElement
        && event.target.closest('.pdf-image-placement')
    ) {
        return;
    }
    if (
        event.target instanceof HTMLElement &&
        event.target.closest(
            '.pdf-inline-comment-anchor-marker, .pdf-inline-comment-marker, .pdf-comment-marker-button, .pdf-annotation-has-note-target, .pdf-annotation-has-comment, .annotationLayer .popupTriggerArea, .annotation-layer .popupTriggerArea',
        )
    ) {
        event.preventDefault();
        return;
    }
    cancelPendingSearchScroll();
    handleDragStart(event);
}

function handleViewerMouseMove(event: MouseEvent) {
    if (isSnipActive()) {
        return;
    }
    if (
        event.target instanceof HTMLElement
        && event.target.closest('.pdf-image-placement')
    ) {
        return;
    }
    handleDragMove(event);
}

function handleViewerMouseUp(event: MouseEvent) {
    if (isSnipActive()) {
        return;
    }
    if (
        event.target instanceof HTMLElement
        && event.target.closest('.pdf-image-placement')
    ) {
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

function handleSelectStart(event: Event) {
    if (isViewerPanDragModeActive.value) {
        event.preventDefault();
    }
}

function handleViewerClick(event: MouseEvent) {
    if (isSnipActive()) {
        return;
    }
    if (
        event.target instanceof HTMLElement
        && event.target.closest('.pdf-image-placement')
    ) {
        return;
    }
    void commentCrud.handleAnnotationCommentClick(event);
}

function handleViewerDblClick(event: MouseEvent) {
    if (isSnipActive()) {
        return;
    }
    if (
        event.target instanceof HTMLElement
        && event.target.closest('.pdf-image-placement')
    ) {
        return;
    }
    commentCrud.handleAnnotationEditorDblClick(event);
}

function handleViewerContextMenu(event: MouseEvent) {
    if (isSnipActive()) {
        event.preventDefault();
        return;
    }
    if (
        event.target instanceof HTMLElement
        && event.target.closest('.pdf-image-placement')
    ) {
        event.preventDefault();
        return;
    }
    commentCrud.handleAnnotationCommentContextMenu(event);
}

function revokePendingImagePlacementPreview() {
    const previewUrl = pendingImagePlacement.value?.previewUrl;
    if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
    }
}

function clearPendingImagePlacement() {
    revokePendingImagePlacementPreview();
    pendingImagePlacement.value = null;
    isPendingImagePlacementFinalizing.value = false;
}

function restorePendingImagePlacement() {
    if (!pendingImagePlacement.value) {
        return;
    }
    isPendingImagePlacementFinalizing.value = false;
}

function getImagePlacementTarget(options?: {
    pageNumber?: number | null;
    pageX?: number | null;
    pageY?: number | null;
}) {
    const container = viewerContainer.value;
    const requestedPageNumber = Number.isFinite(options?.pageNumber)
        ? Math.max(1, Math.min(numPages.value, Math.floor(Number(options?.pageNumber))))
        : currentPage.value;
    const pageNumber = Math.max(1, requestedPageNumber);
    const pageContainer = container?.querySelector<HTMLElement>(
        `.page_container[data-page="${pageNumber}"]`,
    ) ?? null;
    const pageRect = pageContainer?.getBoundingClientRect() ?? null;
    const pageX = Number.isFinite(options?.pageX) ? Number(options?.pageX) : 0.5;
    const pageY = Number.isFinite(options?.pageY) ? Number(options?.pageY) : 0.5;

    return {
        pageNumber,
        pageX: clamp(pageX, 0, 1),
        pageY: clamp(pageY, 0, 1),
        pageWidthPx: pageRect?.width ?? null,
        pageHeightPx: pageRect?.height ?? null,
    };
}

async function getImageIntrinsicSize(file: File) {
    if (typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(file);
        try {
            return {
                width: bitmap.width,
                height: bitmap.height,
            };
        } finally {
            bitmap.close();
        }
    }

    const imageUrl = URL.createObjectURL(file);
    try {
        const dimensions = await new Promise<{
            width: number;
            height: number;
        }>((resolve, reject) => {
            const image = new Image();
            image.onload = () => {
                resolve({
                    width: image.naturalWidth,
                    height: image.naturalHeight,
                });
            };
            image.onerror = () => {
                reject(new Error('Failed to decode image dimensions'));
            };
            image.src = imageUrl;
        });
        return dimensions;
    } finally {
        URL.revokeObjectURL(imageUrl);
    }
}

async function getInitialImagePlacementDimensions(
    file: File,
    pageWidthPx: number | null,
    pageHeightPx: number | null,
) {
    if (
        !pageWidthPx
        || !pageHeightPx
        || pageWidthPx <= 0
        || pageHeightPx <= 0
    ) {
        return null;
    }

    const {
        width: imageWidth,
        height: imageHeight,
    } = await getImageIntrinsicSize(file);
    if (imageWidth <= 0 || imageHeight <= 0) {
        return null;
    }

    const devicePixelRatioValue = typeof window !== 'undefined' && window.devicePixelRatio > 0
        ? window.devicePixelRatio
        : 1;
    const imageCssWidth = imageWidth / devicePixelRatioValue;
    const imageCssHeight = imageHeight / devicePixelRatioValue;
    return computeInitialImagePlacementDimensions({
        pageWidthPx,
        pageHeightPx,
        imageCssWidth,
        imageCssHeight,
    });
}

function getInitialImagePlacementRect(
    target: {
        pageNumber: number;
        pageX: number;
        pageY: number;
        pageWidthPx: number | null;
        pageHeightPx: number | null;
    },
    dimensions: {
        width: number;
        height: number;
    },
) {
    const x = clamp(target.pageX - (dimensions.width / 2), 0, Math.max(0, 1 - dimensions.width));
    const y = clamp(target.pageY - (dimensions.height / 2), 0, Math.max(0, 1 - dimensions.height));

    return {
        pageNumber: target.pageNumber,
        x,
        y,
        width: dimensions.width,
        height: dimensions.height,
    };
}

async function startImagePlacement(
    file: File,
    options?: {
        pageNumber?: number | null;
        pageX?: number | null;
        pageY?: number | null;
    },
) {
    const {
        pageNumber,
        pageX,
        pageY,
        pageWidthPx,
        pageHeightPx,
    } = getImagePlacementTarget(options);
    const initialDimensions = await getInitialImagePlacementDimensions(file, pageWidthPx, pageHeightPx);
    if (!initialDimensions) {
        return false;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const previewUrl = URL.createObjectURL(new Blob([bytes], { type: file.type || 'image/png' }));
    const placementRect = getInitialImagePlacementRect({
        pageNumber,
        pageX,
        pageY,
        pageWidthPx,
        pageHeightPx,
    }, initialDimensions);

    clearPendingImagePlacement();
    pendingImagePlacement.value = {
        ...placementRect,
        rotationDegrees: 0,
        previewUrl,
        fileName: file.name,
        mimeType: file.type || 'image/png',
        bytes,
    };
    isPendingImagePlacementFinalizing.value = false;
    return true;
}

function updatePendingImagePlacementRect(update: IPdfImagePlacementRectUpdate) {
    if (!pendingImagePlacement.value) {
        return;
    }

    pendingImagePlacement.value = {
        ...pendingImagePlacement.value,
        ...update,
    };
}

function getPendingImagePlacementTargetPixels(placement: IPdfImagePlacementDraft) {
    const pageContainer = viewerContainer.value?.querySelector<HTMLElement>(
        `.page_container[data-page="${placement.pageNumber}"]`,
    ) ?? null;
    const canvas = pageContainer?.querySelector<HTMLCanvasElement>('.page_canvas canvas') ?? null;
    const devicePixelRatioValue = typeof window !== 'undefined' && window.devicePixelRatio > 0
        ? window.devicePixelRatio
        : 1;
    const renderedPagePixelWidth = canvas?.width
        ?? Math.max(1, Math.round((pageContainer?.clientWidth ?? 1) * devicePixelRatioValue));
    const renderedPagePixelHeight = canvas?.height
        ?? Math.max(1, Math.round((pageContainer?.clientHeight ?? 1) * devicePixelRatioValue));
    const renderScale = effectiveScale.value > 0 ? effectiveScale.value : 1;
    const basePagePixelWidth = Math.max(1, Math.round(renderedPagePixelWidth / renderScale));
    const basePagePixelHeight = Math.max(1, Math.round(renderedPagePixelHeight / renderScale));

    return {
        width: Math.max(1, Math.round(placement.width * basePagePixelWidth)),
        height: Math.max(1, Math.round(placement.height * basePagePixelHeight)),
    };
}

function captureViewerScrollSnapshot() {
    return captureScrollSnapshot(viewerContainer.value, { preferredAnchorPage: currentPage.value });
}

function restoreViewerScrollSnapshot(
    snapshot: IScrollSnapshot | null,
    options?: { fallbackPage?: number | null; },
) {
    const fallbackPage = typeof options?.fallbackPage === 'number' && Number.isFinite(options.fallbackPage)
        ? Math.max(1, Math.floor(options.fallbackPage))
        : currentPage.value;
    const container = viewerContainer.value;

    if (snapshot && container && container.scrollWidth > 0 && container.scrollHeight > 0) {
        restoreScrollFromSnapshot(container, snapshot, {
            restoreHorizontal: true,
            restoreVertical: true,
            preferPageAnchor: true,
            allowVerticalRatioFallback: true,
        });
        return;
    }

    singlePageScroll.scrollToPage(fallbackPage);
}

function requestPendingImagePlacementFinalize() {
    const placement = pendingImagePlacement.value;
    if (!placement || isPendingImagePlacementFinalizing.value) {
        return;
    }

    const targetPixels = getPendingImagePlacementTargetPixels(placement);
    isPendingImagePlacementFinalizing.value = true;
    emit('image-placement-finalize', {
        pageNumber: placement.pageNumber,
        x: placement.x,
        y: placement.y,
        width: placement.width,
        height: placement.height,
        rotationDegrees: placement.rotationDegrees,
        fileName: placement.fileName,
        mimeType: placement.mimeType,
        bytes: placement.bytes.slice(),
        targetPixelWidth: targetPixels.width,
        targetPixelHeight: targetPixels.height,
    });
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
    captureScrollSnapshot: captureViewerScrollSnapshot,
    restoreScrollSnapshot: restoreViewerScrollSnapshot,
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
    startImagePlacement,
    clearPendingImagePlacement,
    restorePendingImagePlacement,
    invalidatePages,
    suppressAnnotationId: annotations.commentSync.suppressAnnotationId,
    removeAnnotationFromDom: commentCrud.removeAnnotationFromDom,
    removeAnnotationFromInternalCache: (stableKey: string) => {
        pendingMarkerMoves.delete(stableKey);
        annotationCommentsCache.value = annotationCommentsCache.value.filter(c => c.stableKey !== stableKey);
    },
    clearPendingMarkerMoves: () => pendingMarkerMoves.clear(),
    captureRegionToClipboard: regionSnip.startCaptureSession,
    isCapturingRegion: regionSnip.isActive,
    startCropSelection: cropSelection.startCropSelection,
    cancelCropSelection: cropSelection.cancelSelection,
    isCropSelecting: cropSelection.isSelecting,
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

.pdfViewer.is-selection-markup-tool .annotation-editor-layer,
.pdfViewer.is-selection-markup-tool .annotationEditorLayer {
    pointer-events: none;
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
    .text-layer *,
    .textLayer,
    .textLayer *,
    .annotation-layer,
    .annotation-layer *,
    .annotation-layer a,
    .annotation-editor-layer,
    .annotation-editor-layer *,
    .annotationEditorLayer,
    .annotationEditorLayer *,
    .page_container,
    .page_container canvas,
    .pdf-link-overlay-layer,
    .pdf-link-overlay-layer *,
    .pdf-comment-marker-layer-vue,
    .pdf-comment-marker-layer-vue *,
    .pdf-shape-overlay,
    .pdf-shape-overlay *,
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
