<template>
    <div
        ref="viewerHost"
        class="relative h-full w-full"
        :class="{ 'pdf-viewer-container--dark': invertColors }"
    >
        <PdfViewerViewport
            :set-viewer-container="handleViewerContainerRef"
            :viewer-class="viewerClass"
            :container-style="containerStyle"
            :pages-to-render="pagesToRender"
            :should-show-skeleton="shouldShowPageSkeleton"
            :is-spread-single="isSpreadSingle"
            :is-buffered-page="isPageBuffered"
            :is-rendered-page="isPageRenderedForClass"
            :get-page-placeholder-style="getPagePlaceholderStyle"
            :top-virtual-spacer-style="topVirtualSpacerStyle"
            :bottom-virtual-spacer-style="bottomVirtualSpacerStyle"
            :pending-image-placement="pendingImagePlacement"
            :is-pending-image-placement-finalizing="isPendingImagePlacementFinalizing"
            @scroll="handleViewportScroll"
            @wheel="handleViewerWheel"
            @mousedown="handleViewerMouseDown"
            @mousemove="handleViewerMouseMove"
            @mouseup="handleViewerMouseUp"
            @mouseleave="handleViewerMouseLeave"
            @click="handleViewerClick"
            @dblclick="handleViewerDblClick"
            @contextmenu="handleViewerContextMenu"
            @selectstart="handleSelectStart"
            @update-placed-image-rect="updatePendingImagePlacementRect"
            @finalize-placed-image="requestPendingImagePlacementFinalize"
            @cancel-placed-image="clearPendingImagePlacement"
        />
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
        <PdfViewerPortalLayers
            :viewer-container="viewerContainer"
            :markers-by-page="visibleMarkersByPage"
            :links-by-page="visibleLinksByPage"
            @open-note="handleMarkerOpenNote"
            @context-menu="handleMarkerContextMenu"
            @move-marker="handleMarkerMove"
        />
    </div>
</template>

<script setup lang="ts">

import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { GenericL10n } from 'pdfjs-dist/web/pdf_viewer.mjs';
import PdfViewerPortalLayers from '@app/components/pdf/PdfViewerPortalLayers.vue';
import PdfViewerViewport from '@app/components/pdf/PdfViewerViewport.vue';
import PdfRegionSnipOverlay from '@app/components/pdf/PdfRegionSnipOverlay.vue';
import PdfCropOverlay from '@app/components/pdf/PdfCropOverlay.vue';
import { usePdfDocument } from '@app/composables/pdf/usePdfDocument';
import { usePdfDrag } from '@app/composables/pdf/usePdfDrag';
import { usePdfPageRenderer } from '@app/composables/pdf/usePdfPageRenderer';
import type { IPageRenderStallPayload } from '@app/composables/pdf/usePdfPageRenderer';
import { usePdfScale } from '@app/composables/pdf/usePdfScale';
import { usePdfScroll } from '@app/composables/pdf/usePdfScroll';
import { usePdfSkeletonInsets } from '@app/composables/pdf/usePdfSkeletonInsets';
import { usePdfImagePlacement } from '@app/composables/pdf/usePdfImagePlacement';
import { useAnnotationShapes } from '@app/composables/pdf/useAnnotationShapes';
import { useManagedEmbeddedPdfShapes } from '@app/composables/pdf/useManagedEmbeddedPdfShapes';
import { usePdfShapeHistory } from '@app/composables/pdf/usePdfShapeHistory';
import { usePdfSelectedShapeCommands } from '@app/composables/pdf/usePdfSelectedShapeCommands';
import { usePdfSinglePageScroll } from '@app/composables/pdf/usePdfSinglePageScroll';
import { useAnnotationOrchestrator } from '@app/composables/pdf/annotations/useAnnotationOrchestrator';
import { usePdfViewerCore } from '@app/modules/pdf-viewer-runtime/usePdfViewerCore';
import {
    usePdfViewerVirtualization,
    type IZoomVirtualizationFreeze,
} from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerVirtualization';
import { usePdfViewerLoadingState } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerLoadingState';
import { usePdfViewerMouseInteractions } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerMouseInteractions';
import { usePdfViewerReloadTransition } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerReloadTransition';
import { usePdfViewerWheelZoom } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerWheelZoom';
import { usePdfViewerDelayedSkeleton } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerDelayedSkeleton';
import { usePdfShapeContext } from '@app/composables/pdf/usePdfShapeContext';
import { usePdfRegionSnip } from '@app/composables/pdf/usePdfRegionSnip';
import { usePdfCropSelection } from '@app/composables/pdf/usePdfCropSelection';
import { useViewerLoadSettle } from '@app/composables/pdf/useViewerLoadSettle';
import { useViewportPagePin } from '@app/composables/pdf/useViewportPagePin';
import { usePdfViewerScrollSnapshot } from '@app/composables/pdf/usePdfViewerScrollSnapshot';
import {
    getCurrentSpreadRenderedBoundsFromMetrics,
    resolveHorizontalScrollClampForActiveSpread as resolveActiveSpreadHorizontalScrollClamp,
} from '@app/composables/pdf/pdfHorizontalScrollClamp';
import { summarizeViewerMetrics } from '@app/composables/pdf/pdfViewerMetrics';
import { savePdfDocumentWithCommittedEditors } from '@app/composables/pdf/pdfSaveDocument';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
    PDFDocumentProxy,
    TPdfSource,
    TFitMode,
    TZoomMode,
    TPdfViewMode,
} from '@app/types/pdf';
import { isStandaloneSpreadPage } from '@app/utils/pdfViewMode';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    IAnnotationMarkerRect,
    IAnnotationModifiedPayload,
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IPdfPlacedImageFinalizePayload } from '@app/types/pdfImagePlacement';
import type { IAnnotationContextMenuPayload } from '@app/composables/pdf/annotationContextMenu';
import {
    isSelectionInteractionTool,
    isSelectionMarkupTool,
} from '@app/composables/pdf/annotations/annotationRules';
import { logPdfNav } from '@app/utils/pdfNavLog';
import { BrowserLogger } from '@app/utils/browserLogger';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { runGuardedTask } from '@app/utils/asyncGuard';

import '@app/assets/css/vendor/pdfjs-viewer-sanitized.css';

interface IProps {
    src: TPdfSource | null;
    sourcePdfData?: Uint8Array | null | undefined;
    suppressLoadingOverlay?: boolean | undefined;
    bufferPages?: number | undefined;
    isAnySaving?: boolean | undefined;
    zoom?: number | undefined;
    zoomMode?: TZoomMode | undefined;
    dragMode?: boolean | undefined;
    fitMode?: TFitMode | undefined;
    viewMode?: TPdfViewMode | undefined;
    continuousScroll?: boolean | undefined;
    isActive?: boolean | undefined;
    isResizing?: boolean | undefined;
    invertColors?: boolean | undefined;
    showAnnotations?: boolean | undefined;
    annotationTool?: TAnnotationTool | undefined;
    annotationCursorMode?: boolean | undefined;
    annotationKeepActive?: boolean | undefined;
    annotationSettings?: IAnnotationSettings | null | undefined;
    searchPageMatches?: Map<number, IPdfPageMatches> | undefined;
    currentSearchMatch?: IPdfSearchMatch | null | undefined;
    currentSearchMatchNavigationId?: number | undefined;
    currentPage?: number | undefined;
    workingCopyPath?: string | null | undefined;
    authorName?: string | null | undefined;
}

const {
    annotationCursorMode: annotationCursorModeProp = false,
    annotationKeepActive: annotationKeepActiveProp = true,
    annotationSettings: annotationSettingsProp = undefined,
    annotationTool: annotationToolProp = undefined,
    authorName: authorNameProp = undefined,
    bufferPages: bufferPagesProp = undefined,
    continuousScroll: continuousScrollProp = true,
    currentPage: requestedCurrentPageProp = undefined,
    currentSearchMatch: currentSearchMatchProp = undefined,
    currentSearchMatchNavigationId: currentSearchMatchNavigationIdProp = undefined,
    dragMode: dragModeProp = false,
    fitMode: fitModeProp = undefined,
    invertColors: invertColorsProp = false,
    isActive: isActiveProp = true,
    isAnySaving: isAnySavingProp = false,
    isResizing: isResizingProp = false,
    searchPageMatches: searchPageMatchesProp = undefined,
    showAnnotations: showAnnotationsProp = true,
    sourcePdfData: sourcePdfDataProp = undefined,
    src: srcProp,
    suppressLoadingOverlay: suppressLoadingOverlayProp = false,
    viewMode: viewModeProp = undefined,
    workingCopyPath: workingCopyPathProp = undefined,
    zoom: zoomProp = undefined,
    zoomMode: zoomModeProp = undefined,
} = defineProps<IProps>();

const src = computed(() => srcProp);
const sourcePdfData = computed(() => sourcePdfDataProp ?? null);
const suppressLoadingOverlay = computed(() => suppressLoadingOverlayProp === true);
const bufferPages = computed(() => bufferPagesProp ?? 2);
const isAnySaving = computed(() => isAnySavingProp ?? false);
const zoom = computed(() => zoomProp ?? 1);
const dragMode = computed(() => dragModeProp ?? false);
const fitMode = computed<TFitMode>(() => fitModeProp ?? 'width');
const zoomMode = computed<TZoomMode>(() => zoomModeProp ?? (
    fitMode.value === 'height' ? 'fit-height' : 'fit-width'
));
const viewMode = computed<TPdfViewMode>(() => viewModeProp ?? 'single');
const isResizing = computed(() => isResizingProp ?? false);
const invertColors = computed(() => invertColorsProp ?? false);
const showAnnotations = computed(() => showAnnotationsProp ?? true);
const annotationTool = computed<TAnnotationTool>(() => annotationToolProp ?? 'none');
const annotationCursorMode = computed(() => annotationCursorModeProp ?? false);
const annotationKeepActive = computed(() => annotationKeepActiveProp ?? true);
const annotationSettings = computed<IAnnotationSettings | null>(() => annotationSettingsProp ?? null);
const emptySearchPageMatches = new Map<number, IPdfPageMatches>();
const searchPageMatches = computed(() => searchPageMatchesProp ?? emptySearchPageMatches);
const currentSearchMatch = computed(() => currentSearchMatchProp ?? null);
const currentSearchMatchNavigationId = computed(() => currentSearchMatchNavigationIdProp ?? 0);
const requestedCurrentPage = computed(() => requestedCurrentPageProp);
const workingCopyPath = computed(() => workingCopyPathProp ?? null);
const continuousScroll = computed(() => continuousScrollProp ?? true);
const isActive = computed(() => isActiveProp ?? true);
const authorName = computed(() => authorNameProp);
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
    (e: 'annotation-modified', payload?: IAnnotationModifiedPayload): void;
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
    (e: 'initial-visual-pending'): void;
    (e: 'initial-visual-ready', payload: {pageNumber: number;}): void;
}>();

const viewerHost = ref<HTMLElement | null>(null);
const viewerContainer = ref<HTMLElement | null>(null);
const fitWidthHorizontalScrollLocked = ref(false);
const resizeTransitionVisible = ref(false);
const resizeTransitionAnchorPage = ref<number | null>(null);
const annotationUiManager = shallowRef<AnnotationEditorUIManager | null>(null);
const annotationL10n = shallowRef<GenericL10n | null>(null);
const annotationCommentsCache = shallowRef<IAnnotationCommentSummary[]>([]);
const pendingMarkerMoves = new Map<string, IAnnotationMarkerRect>();
const activeCommentStableKey = ref<string | null>(null);
const PDF_VIEWER_PAGE_SKELETON_DELAY_MS = 0;
const HORIZONTAL_SCROLL_CLAMP_EPSILON_PX = 1.5;
const zoomVirtualizationFreeze = ref<IZoomVirtualizationFreeze | null>(null);
const renderedPageStateVersion = ref(0);
const {
    beginViewerLoadSettle,
    settleViewerLoadSettle,
    waitForViewerLoadSettled,
} = useViewerLoadSettle();
let pendingInitialVisualReadyToken: number | null = null;
const regionSnip = usePdfRegionSnip({ viewerContainer });
const cropSelection = usePdfCropSelection({ viewerContainer });

function settleViewerLoadSettledWithManagedShapes(token: number) {
    managedEmbeddedPdfShapes.settleViewerLoadSettledWithManagedShapes(token, settleViewerLoadSettle);
}

function handleRenderedPageStateChanged() {
    renderedPageStateVersion.value += 1;
}

function handlePageCanvasMounted(pageNumber: number) {
    renderedPageStateVersion.value += 1;
    delayedSkeleton.markPageRendered(pageNumber);
    managedEmbeddedPdfShapes.syncAfterPageRendered(pageNumber);
}

function handlePageRendered(pageNumber: number) {
    delayedSkeleton.markPageRendered(pageNumber);
    managedEmbeddedPdfShapes.syncAfterPageRendered(pageNumber);

    if (pendingInitialVisualReadyToken === null) {
        return;
    }

    const token = pendingInitialVisualReadyToken;
    pendingInitialVisualReadyToken = null;
    emit('initial-visual-ready', { pageNumber });
    BrowserLogger.debug('loader', 'PDF viewer initial visual ready', {
        token,
        pageNumber,
    });
}

const pdfDocumentResult = usePdfDocument();
const {
    pdfDocument,
    numPages,
    isLoading,
    basePageWidth,
    basePageHeight,
    pageMetrics,
    pageMetricsVersion,
} = pdfDocumentResult;

function summarizeViewerStateForLog() {
    return summarizeViewerMetrics(viewerContainer.value);
}

const {
    clearPinnedViewportPage,
    getPinnedViewportPage,
    pinCurrentPageDuringRecovery,
} = useViewportPagePin({ summarizeViewerStateForLog });

const {
    currentPage: viewerCurrentPage,
    visibleRange,
    getMostVisiblePage,
    scrollToPage: scrollToPageInternal,
    updateCurrentPage,
    updateVisibleRange,
    setPageLayoutMetrics,
} = usePdfScroll({ getPinnedMostVisiblePage: () => getPinnedViewportPage() });

function handleResizeTransitionSignal(payload: {
    active: boolean;
    source: string;
    token: number;
    anchorPage: number | null;
}) {
    const nextAnchorPage = payload.active ? payload.anchorPage : null;
    if (
        resizeTransitionVisible.value === payload.active
        && resizeTransitionAnchorPage.value === nextAnchorPage
    ) {
        return;
    }
    resizeTransitionVisible.value = payload.active;
    resizeTransitionAnchorPage.value = nextAnchorPage;
    BrowserLogger.warn('pdf-nav', `[resize-transition-ui] active=${payload.active}`, {
        ...payload,
        storedAnchorPage: resizeTransitionAnchorPage.value,
        viewer: summarizeViewerStateForLog(),
        currentPage: viewerCurrentPage.value,
        visibleRange: {
            start: visibleRange.value.start,
            end: visibleRange.value.end,
        },
    });
}

function handleViewerContainerRef(element: HTMLElement | null) {
    viewerContainer.value = element;
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
            overlayVisible: false,
            label: t('common.loading'),
            hostWidth: hostRect ? Math.round(hostRect.width) : null,
            hostHeight: hostRect ? Math.round(hostRect.height) : null,
        });
    },
    { immediate: true },
);
const {
    containerStyle,
    scaledMargin,
    computeFitWidthScale,
    effectiveScale,
    isFitWidthScaleCurrent,
    invalidateScaleCache,
    resetScale,
} = usePdfScale(
    zoom,
    fitMode,
    viewMode,
    numPages,
    pageMetrics,
    pageMetricsVersion,
    basePageWidth,
    basePageHeight,
    viewerCurrentPage,
    continuousScroll,
);

const {
    isVisualReloadTransitionActive,
    beginVisualReloadTransition,
    endVisualReloadTransition,
    emitEffectiveZoom: emitEffectiveZoomThroughReloadTransition,
} = usePdfViewerReloadTransition({
    emitEffectiveZoom: (value) => emit('update:effectiveZoom', value),
    summarizeViewerStateForLog,
});

watch(
    () => effectiveScale.value,
    (value) => {
        emitEffectiveZoomThroughReloadTransition(value);
    },
    { immediate: true },
);
const {
    skeletonContentInsets,
    computeSkeletonInsets,
    resetInsets,
} = usePdfSkeletonInsets(basePageWidth, basePageHeight, effectiveScale);

const shapeComposable = useAnnotationShapes();
let pageRenderStallRecoveryHandler: ((payload: IPageRenderStallPayload) => void) | null = null;

const managedEmbeddedPdfShapes = useManagedEmbeddedPdfShapes({
    viewerContainer,
    workingCopyPath,
    sourcePdfData,
    visibleRange,
    bufferPages,
    shapeComposable,
    suppressCommentAnnotationId: (annotationId) => annotations.commentSync.suppressAnnotationId(annotationId),
    logger: BrowserLogger,
    runGuardedTask,
    nextTick,
    isPageRendered: (pageNumber) => isPageRendered(pageNumber),
    invalidatePages: (pages) => invalidateRenderedPages(pages),
    renderVisiblePages: (range, options) => renderVisiblePages(range, options),
    hideManagedAnnotationEditors: (pageNumber) => hideManagedAnnotationEditors(pageNumber),
    currentPage: viewerCurrentPage,
});
const {
    managedEmbeddedAnnotationIds,
    hiddenEmbeddedAnnotationIds,
    suppressAnnotationId,
    clearVisuallySuppressedAnnotationIds,
    refreshHiddenAnnotationPage,
    refreshDeletedEmbeddedShape,
    adoptPersistedManagedShapesOnNextImport,
    clearPendingManagedShapeImportAdoption,
    preparePersistedManagedShapesForSave,
    restorePreparedManagedShapesAfterFailedSave,
} = managedEmbeddedPdfShapes;

watch(pdfDocument, () => {
    clearVisuallySuppressedAnnotationIds();
});

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

const {
    applyShapeUpdateWithHistory,
    handleShapeCreated,
} = usePdfShapeHistory({
    registerCommand: registerShapeHistoryCommand,
    addShape: shapeComposable.addShape,
    updateShape: shapeComposable.updateShape,
    deleteShape: shapeComposable.deleteShape,
    selectShape: shapeComposable.selectShape,
    markModified: () => emit('annotation-modified'),
});

const selectedShapeCommands = usePdfSelectedShapeCommands({
    selectedShapeId: shapeComposable.selectedShapeId,
    hasShapes: shapeComposable.hasShapes,
    isAnySaving,
    getShapeById: shapeComposable.getShapeById,
    selectShape: shapeComposable.selectShape,
    updateShape: shapeComposable.updateShape,
    deleteShape: shapeComposable.deleteShape,
    addShape: shapeComposable.addShape,
    applyShapeUpdateWithHistory,
    refreshDeletedEmbeddedShape,
    registerHistoryCommand: registerShapeHistoryCommand,
    markModified: () => emit('annotation-modified'),
});

usePdfShapeContext({
    shapeComposable,
    annotationTool,
    annotationSettings,
    onShapeCreated: handleShapeCreated,
    onShapeUpdated: applyShapeUpdateWithHistory,
    onShapeContextMenu: (payload) => {
        emit('shape-context-menu', payload);
    },
});

const {
    setupPagePlaceholders,
    renderVisiblePages,
    reRenderAllVisiblePages,
    cleanupAllPages: cleanupAllRenderedPages,
    invalidatePages: invalidateRenderedPages,
    applySearchHighlights,
    hideManagedAnnotationEditors,
    isPageRendered,
    requestScrollToCurrentResult,
    cancelPendingSearchScroll,
    cancelInFlightRenders,
} = usePdfPageRenderer({
    container: viewerContainer,
    document: pdfDocumentResult,
    currentPage: viewerCurrentPage,
    isActive,
    effectiveScale,
    bufferPages,
    showAnnotations,
    hiddenAnnotationIds: hiddenEmbeddedAnnotationIds,
    managedAnnotationIds: managedEmbeddedAnnotationIds,
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
    currentSearchMatchNavigationId,
    workingCopyPath,
    onRenderStall: relayPageRenderStall,
    onPageCanvasMounted: handlePageCanvasMounted,
    onPageRendered: handlePageRendered,
    onRenderedPageStateChanged: handleRenderedPageStateChanged,
});

function cleanupRenderedPages() {
    cleanupAllRenderedPages();
    renderedPageStateVersion.value += 1;
}

function isPageRenderedForClass(page: number) {
    return renderedPageStateVersion.value >= 0 && hasMountedPageCanvas(page);
}

const singlePageScroll = usePdfSinglePageScroll({
    viewerContainer,
    numPages,
    currentPage: viewerCurrentPage,
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

watch(
    [
        requestedCurrentPage,
        numPages,
        viewerContainer,
    ],
    ([pageNumber]) => {
        if (
            typeof pageNumber !== 'number'
            || !Number.isFinite(pageNumber)
            || numPages.value <= 0
            || !viewerContainer.value
        ) {
            return;
        }

        const targetPage = Math.min(
            Math.max(Math.trunc(pageNumber), 1),
            numPages.value,
        );
        if (targetPage === viewerCurrentPage.value) {
            logPdfRenderTrace('viewer-requested-current-page-skip', {
                requestedPage: pageNumber,
                targetPage,
                viewerCurrentPage: viewerCurrentPage.value,
            });
            return;
        }

        logPdfRenderTrace('viewer-requested-current-page-scroll', {
            requestedPage: pageNumber,
            targetPage,
            viewerCurrentPage: viewerCurrentPage.value,
            visibleRange: {
                start: visibleRange.value.start,
                end: visibleRange.value.end,
            },
        });
        cancelPendingSearchScroll();
        singlePageScroll.scrollToPage(targetPage);
    },
    {
        flush: 'post',
        immediate: true, 
    },
);

const {
    pendingImagePlacement,
    isPendingImagePlacementFinalizing,
    startImagePlacement,
    updatePendingImagePlacementRect,
    requestPendingImagePlacementFinalize,
    clearPendingImagePlacement,
    restorePendingImagePlacement,
} = usePdfImagePlacement({
    viewerContainer,
    currentPage: viewerCurrentPage,
    numPages,
    effectiveScale,
    emitFinalize: (payload) => emit('image-placement-finalize', payload),
});

const isImagePlacementActive = computed(() => pendingImagePlacement.value !== null);
const isViewerPanDragModeActive = computed(() => dragMode.value && !isImagePlacementActive.value);
const isSelectionMarkupToolActive = computed(() => isSelectionMarkupTool(annotationTool.value));

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

watch(annotationTool, (tool) => {
    if (!isSelectionInteractionTool(tool)) {
        shapeComposable.selectShape(null);
    }
});

const annotations = useAnnotationOrchestrator({
    viewerContainer,
    pdfDocument,
    numPages,
    currentPage: viewerCurrentPage,
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

function removeAnnotationFromDom(comment: IAnnotationCommentSummary) {
    if (comment.annotationId) {
        suppressAnnotationId(comment.annotationId);
    }
    commentCrud.removeAnnotationFromDom(comment);
    refreshHiddenAnnotationPage(comment);
}

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
    emit('annotation-modified', { forceDirty: true });
}

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
    isPageBuffered,
} = usePdfViewerVirtualization({
    bufferPages,
    viewMode,
    numPages,
    currentPage: viewerCurrentPage,
    continuousScroll,
    basePageWidth,
    basePageHeight,
    pageMetrics,
    pageMetricsVersion,
    effectiveScale,
    scaledMargin,
    visibleRange,
    searchNavigationTargetPage: singlePageScroll.searchNavigationTargetPage,
    resizeTransitionAnchorPage,
    zoomVirtualizationFreeze,
});

const {
    zoomSnapSuppressed,
    handleViewerWheel,
    handleViewerScroll,
    consumeZoomViewportAnchor,
    isZoomInteractionLocked,
    setZoomRerenderBusy,
} = usePdfViewerWheelZoom({
    viewerContainer,
    src,
    isLoading,
    zoom,
    zoomMode,
    effectiveScale,
    currentPage: viewerCurrentPage,
    visibleRange,
    virtualizedContinuousMode,
    virtualWindowStart,
    virtualWindowEnd,
    topVirtualSpacerStyle,
    bottomVirtualSpacerStyle,
    zoomVirtualizationFreeze,
    singlePageScroll,
    cancelPendingSearchScroll,
    isSnipActive: () => regionSnip.isActive.value || cropSelection.isSelecting.value,
    emit,
});

watch(() => src.value, (next, previous) => {
    if (next !== previous) {
        clearPendingImagePlacement();
        pendingMarkerMoves.clear();
        annotationCommentsCache.value = [];
        activeCommentStableKey.value = null;
        emit('annotation-comments', []);
    }
});

const {
    shouldShowSkeleton,
    handleDragStart,
    handleDragMove,
    undoAnnotation,
    redoAnnotation,
    invalidatePages,
    handlePageRenderStall: handlePageRenderStallFromCore,
    preserveNextSourceReloadVisibleContent,
} = usePdfViewerCore({
    viewerContainer,
    src,
    zoom,
    zoomMode,
    fitMode,
    viewMode,
    isResizing,
    isActive,
    continuousScroll,
    annotationTool,
    annotationCursorMode,
    annotationSettings,
    isAnySaving,
    annotationUiManager,
    annotationCommentsCache,
    activeCommentStableKey,
    pdfDocumentResult,
    annotations,
    currentPage: viewerCurrentPage,
    visibleRange,
    effectiveScale,
    basePageWidth,
    basePageHeight,
    computeFitWidthScale,
    syncHorizontalScrollForZoomMode,
    invalidateScaleCache,
    resetScale,
    computeSkeletonInsets,
    beforeInitialRender: managedEmbeddedPdfShapes.importBeforeInitialRender,
    resetInsets,
    setupPagePlaceholders,
    renderVisiblePages,
    reRenderAllVisiblePages,
    cancelInFlightPageRenders: cancelInFlightRenders,
    cancelPendingSearchScroll,
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
    consumeZoomViewportAnchor,
    isZoomInteractionLocked,
    isZoomGestureSessionLocked: isZoomInteractionLocked,
    setZoomRerenderBusy,
    setResizeTransitionVisible: handleResizeTransitionSignal,
    pinCurrentPageDuringRecovery,
    beginVisualReloadTransition,
    endVisualReloadTransition,
    onDocumentLoadStateChange: (payload) => {
        if (payload.phase === 'started') {
            pendingInitialVisualReadyToken = payload.token;
            emit('initial-visual-pending');
            beginViewerLoadSettle(payload.token);
            return;
        }
        settleViewerLoadSettledWithManagedShapes(payload.token);
    },
    emit,
});
pageRenderStallRecoveryHandler = handlePageRenderStallFromCore;

async function applyFitWidthToCurrentPage() {
    if (!pdfDocument.value || isLoading.value) {
        return false;
    }

    const anchorSnapshot = captureViewerScrollSnapshot();
    const updated = computeFitWidthScale(viewerContainer.value);
    if (!updated) {
        syncHorizontalScrollForZoomMode();
        return false;
    }

    cancelInFlightRenders();
    await reRenderAllVisiblePages(
        () => ({ ...visibleRange.value }),
        {
            preserveExistingPages: true,
            anchorSnapshot,
            disableHorizontalAnchorRestore: true,
            rerenderSource: 'fit-width-explicit',
            renderBufferOverride: 0,
        },
    );
    syncHorizontalScrollForZoomMode();
    return true;
}

function isZoomAtFitWidthBaseline() {
    return Math.abs(zoom.value - 1) < 0.001;
}

function syncFitWidthZoomModeForCurrentPage() {
    if (
        !continuousScroll.value
        || fitMode.value !== 'width'
        || !viewerContainer.value
        || !pdfDocument.value
        || isLoading.value
    ) {
        return;
    }

    const isCurrentPageFitWidth = isZoomAtFitWidthBaseline()
        && isFitWidthScaleCurrent(viewerContainer.value);

    if (isCurrentPageFitWidth && zoomMode.value === 'custom') {
        emit('update:zoomMode', 'fit-width');
        return;
    }

    if (!isCurrentPageFitWidth && zoomMode.value === 'fit-width') {
        emit('update:zoomMode', 'custom');
    }
}

watch(
    () => [
        viewerCurrentPage.value,
        fitMode.value,
        continuousScroll.value,
        zoom.value,
        effectiveScale.value,
        viewMode.value,
        numPages.value,
        pageMetricsVersion.value,
    ] as const,
    () => {
        syncFitWidthZoomModeForCurrentPage();
        syncHorizontalScrollForZoomMode();
    },
);

const {
    handleViewerMouseDown,
    handleViewerMouseMove,
    handleViewerMouseUp,
    handleViewerMouseLeave,
    handleSelectStart,
    handleViewerClick,
    handleViewerDblClick,
    handleViewerContextMenu,
} = usePdfViewerMouseInteractions({
    isSnipActive: () => regionSnip.isActive.value || cropSelection.isSelecting.value,
    isViewerPanDragModeActive,
    cancelPendingSearchScroll,
    handleDragStart,
    handleDragMove,
    stopDrag,
    handleViewerMouseUpAnnotation: () => highlightComposable.handleViewerMouseUp(),
    handleViewerClickAnnotation: (event) => commentCrud.handleAnnotationCommentClick(event),
    handleViewerDblClickAnnotation: (event) => commentCrud.handleAnnotationEditorDblClick(event),
    handleViewerContextMenuAnnotation: (event) => commentCrud.handleAnnotationCommentContextMenu(event),
});

const { isViewerLoadingOverlayVisible } = usePdfViewerLoadingState({
    src,
    isLoading,
    pdfDocument,
    viewerContainer,
    holdOverlayVisible: isVisualReloadTransitionActive,
});
const isInitialSkeletonGeometryPending = computed(() => (
    Boolean(src.value)
    && Boolean(pdfDocument.value)
    && isViewerLoadingOverlayVisible.value
    && skeletonContentInsets.value === null
));
const shouldBlockPageSkeletons = computed(() => (
    (
        isViewerLoadingOverlayVisible.value
        && isVisualReloadTransitionActive.value
        && !suppressLoadingOverlay.value
    )
    || suppressLoadingOverlay.value
    || isInitialSkeletonGeometryPending.value
));

const delayedSkeleton = usePdfViewerDelayedSkeleton({
    delayMs: PDF_VIEWER_PAGE_SKELETON_DELAY_MS,
    trackedPages: pagesToRender,
    blockSkeletons: shouldBlockPageSkeletons,
    shouldShowSkeletonNow: shouldShowSkeleton,
});
const emptyMarkersByPage = new Map<number, never[]>();
const emptyLinksByPage: Record<number, never[]> = {};
const visibleMarkersByPage = computed(() => (
    isViewerLoadingOverlayVisible.value
        ? emptyMarkersByPage
        : new Map([...markersByPage.value].filter(([page]) => isPageRenderedForClass(page)))
));
const visibleLinksByPage = computed(() => (
    isViewerLoadingOverlayVisible.value
        ? emptyLinksByPage
        : Object.fromEntries(
            Object.entries(linksByPage.value).filter(([page]) => isPageRenderedForClass(Number(page))),
        )
));
function shouldShowPageSkeleton(page: number) {
    if (isPageBuffered(page)) {
        delayedSkeleton.hidePage(page);
        return false;
    }
    if (isPageRenderedForClass(page)) {
        delayedSkeleton.markPageRendered(page);
        return false;
    }
    return delayedSkeleton.shouldShowSkeleton(page);
}

function hasMountedPageCanvas(page: number) {
    const container = viewerContainer.value?.querySelector<HTMLElement>(
        `.page_container[data-page="${page}"]`,
    );
    return Boolean(container?.querySelector('.page_canvas canvas'));
}

let pagedBufferRenderToken = 0;

function schedulePagedBufferRender() {
    const token = ++pagedBufferRenderToken;
    logPdfRenderTrace('paged-buffer-render-scheduled', {
        token,
        currentPage: viewerCurrentPage.value,
        visibleRange: {
            start: visibleRange.value.start,
            end: visibleRange.value.end,
        },
        pagesToRender: pagesToRender.value,
    });
    void nextTick(() => {
        const mountedPages = pagesToRender.value;
        const firstMountedPage = mountedPages[0];
        const lastMountedPage = mountedPages[mountedPages.length - 1];
        if (
            token !== pagedBufferRenderToken
            || continuousScroll.value
            || isLoading.value
            || !pdfDocument.value
            || numPages.value <= 0
            || firstMountedPage === undefined
            || lastMountedPage === undefined
        ) {
            logPdfRenderTrace('paged-buffer-render-skipped', {
                token,
                activeToken: pagedBufferRenderToken,
                continuousScroll: continuousScroll.value,
                isLoading: isLoading.value,
                hasDocument: Boolean(pdfDocument.value),
                mountedPages,
                firstMountedPage,
                lastMountedPage,
            });
            return;
        }

        logPdfRenderTrace('paged-buffer-render-run', {
            token,
            currentPage: viewerCurrentPage.value,
            firstMountedPage,
            lastMountedPage,
            visibleRange: {
                start: visibleRange.value.start,
                end: visibleRange.value.end,
            },
            mountedPages,
        });
        runGuardedTask(
            () => renderVisiblePages(
                {
                    start: firstMountedPage,
                    end: lastMountedPage,
                },
                {
                    preserveRenderedPages: true,
                    bufferOverride: 0,
                },
            ),
            {
                scope: 'pdf-viewer',
                message: 'Failed to pre-render paged navigation buffer',
            },
        );
    });
}

watch(
    () => [
        continuousScroll.value,
        isLoading.value,
        Boolean(pdfDocument.value),
        numPages.value,
        visibleRange.value.start,
        visibleRange.value.end,
        pagesToRender.value.join(','),
    ] as const,
    () => {
        if (!continuousScroll.value) {
            schedulePagedBufferRender();
        }
    },
    { flush: 'post' },
);

const isActiveSpreadHorizontalScrollLocked = computed(() => {
    const container = viewerContainer.value;
    if (!container) {
        return false;
    }

    const renderedSpreadBounds = getCurrentSpreadRenderedBoundsFromMetrics({
        container,
        basePageWidth: basePageWidth.value,
        basePageHeight: basePageHeight.value,
        numPages: numPages.value,
        pageMetrics: pageMetrics.value,
        currentPage: viewerCurrentPage.value,
        viewMode: viewMode.value,
        effectiveScale: effectiveScale.value,
        scaledMargin: scaledMargin.value,
    });

    return renderedSpreadBounds
        ? renderedSpreadBounds.width <= container.clientWidth + HORIZONTAL_SCROLL_CLAMP_EPSILON_PX
        : container.scrollWidth <= container.clientWidth + HORIZONTAL_SCROLL_CLAMP_EPSILON_PX;
});

const viewerClass = computed(() => ({
    'pdfViewer--saving': isAnySaving.value,
    'is-dragging': isDragging.value,
    'drag-mode': isViewerPanDragModeActive.value,
    'is-placing-comment': highlightComposable.isPlacingComment.value,
    'is-selection-markup-tool': isSelectionMarkupToolActive.value,
    'pdfViewer--single-page': !continuousScroll.value,
    'pdfViewer--mode-single': viewMode.value === 'single',
    'pdfViewer--mode-facing': viewMode.value === 'facing',
    'pdfViewer--mode-facing-first-single': viewMode.value === 'facing-first-single',
    'pdfViewer--fit-width': zoomMode.value === 'fit-width',
    'pdfViewer--fit-width-page-fits': fitWidthHorizontalScrollLocked.value,
    'pdfViewer--fit-height': fitMode.value === 'height',
    'pdfViewer--active-spread-fits-width': isActiveSpreadHorizontalScrollLocked.value,
    'pdfViewer--resize-transition': resizeTransitionVisible.value,
    'pdfViewer--zoom-snap-suppressed': zoomSnapSuppressed.value,
}));

function resolveActiveSpreadHorizontalScrollLock() {
    const container = viewerContainer.value;
    if (!container) {
        return false;
    }

    const shouldLock = isActiveSpreadHorizontalScrollLocked.value;
    if (shouldLock && container.scrollLeft !== 0) {
        container.scrollLeft = 0;
    }

    return shouldLock;
}

function resolveHorizontalScrollClampForActiveSpread() {
    const container = viewerContainer.value;
    if (
        !container
        || fitMode.value !== 'width'
    ) {
        fitWidthHorizontalScrollLocked.value = false;
        return null;
    }

    const scrollClamp = resolveActiveSpreadHorizontalScrollClamp({
        container,
        fitMode: fitMode.value,
        pageNumber: viewerCurrentPage.value,
        viewMode: viewMode.value,
        numPages: numPages.value,
        basePageWidth: basePageWidth.value,
        basePageHeight: basePageHeight.value,
        pageMetrics: pageMetrics.value,
        effectiveScale: effectiveScale.value,
        scaledMargin: scaledMargin.value,
        epsilon: HORIZONTAL_SCROLL_CLAMP_EPSILON_PX,
    });
    fitWidthHorizontalScrollLocked.value = scrollClamp?.shouldLock ?? false;
    return scrollClamp;
}

function syncHorizontalScrollForZoomMode() {
    const container = viewerContainer.value;
    if (!container) {
        fitWidthHorizontalScrollLocked.value = false;
        return false;
    }

    const scrollClamp = resolveHorizontalScrollClampForActiveSpread();
    if (scrollClamp) {
        const scrollDelta = Math.abs(container.scrollLeft - scrollClamp.scrollLeft);
        if (scrollDelta > HORIZONTAL_SCROLL_CLAMP_EPSILON_PX) {
            container.scrollLeft = scrollClamp.scrollLeft;
        }
        return scrollClamp.shouldLock;
    }

    if (resolveActiveSpreadHorizontalScrollLock()) {
        return true;
    }

    if (
        (zoomMode.value === 'fit-width' || zoomMode.value === 'fit-height')
        && container.scrollWidth <= container.clientWidth
        && container.scrollLeft !== 0
    ) {
        container.scrollLeft = 0;
    }
    return false;
}

function handleViewportScroll(event: Event) {
    syncHorizontalScrollForZoomMode();
    handleViewerScroll(event);
    syncHorizontalScrollForZoomMode();
}

watch(
    () => [
        zoomMode.value,
        fitMode.value,
        viewerCurrentPage.value,
        effectiveScale.value,
        viewMode.value,
        numPages.value,
        pageMetricsVersion.value,
    ] as const,
    () => {
        void nextTick(syncHorizontalScrollForZoomMode);
    },
    { immediate: true },
);

watch(
    () => [
        !!searchNavigationWindow.value,
        virtualWindowStart.value,
        virtualWindowEnd.value,
        viewerCurrentPage.value,
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

watch(viewerCurrentPage, (next, previous) => {
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
            currentPage: viewerCurrentPage.value,
            isLoading: isLoading.value,
            continuousScroll: continuousScroll.value,
            viewer: summarizeViewerStateForLog(),
        });
    },
);

watchEffect(() => {
    if (pageLayout.value) {
        setPageLayoutMetrics(pageLayout.value);
        return;
    }

    setPageLayoutMetrics(null);
});

onBeforeUnmount(() => {
    clearPinnedViewportPage('before-unmount');
    clearPendingImagePlacement();
    setPageLayoutMetrics(null);
    resizeTransitionVisible.value = false;
    resizeTransitionAnchorPage.value = null;
});

function isSpreadSingle(page: number) {
    return isStandaloneSpreadPage(page, viewMode.value, numPages.value);
}

const {
    captureViewerScrollSnapshot,
    restoreViewerScrollSnapshot,
} = usePdfViewerScrollSnapshot({
    viewerContainer,
    currentPage: viewerCurrentPage,
    resolveHorizontalScrollClampForActiveSpread,
    syncHorizontalScrollForZoomMode,
    scrollToPage: singlePageScroll.scrollToPage,
});

async function saveViewerDocument() {
    return savePdfDocumentWithCommittedEditors({
        pdfDocument: pdfDocument.value,
        annotationUiManager: annotationUiManager.value,
    });
}

defineExpose({
    getViewerContainer: () => viewerContainer.value,
    getCurrentPage: () => viewerCurrentPage.value,
    scrollToPage: (pageNumber: number) => {
        cancelPendingSearchScroll();
        singlePageScroll.scrollToPage(pageNumber);
    },
    captureScrollSnapshot: captureViewerScrollSnapshot,
    restoreScrollSnapshot: restoreViewerScrollSnapshot,
    applyFitWidthToCurrentPage,
    ensurePageMetricsInRange: pdfDocumentResult.ensurePageMetricsInRange,
    getPageMetricsSnapshot: () => pageMetrics.value.map(metric => ({ ...metric })),
    waitForViewerLoadSettled,
    preserveNextSourceReloadVisibleContent,
    adoptPersistedManagedShapesOnNextImport,
    clearPendingManagedShapeImportAdoption,
    preparePersistedManagedShapesForSave,
    restorePreparedManagedShapesAfterFailedSave,
    saveDocument: saveViewerDocument,
    markSavedShapeState: shapeComposable.markSavedShapeState,
    highlightSelection: highlightComposable.highlightSelection,
    commentSelection: highlightComposable.commentSelection,
    commentAtPoint: highlightComposable.commentAtPoint,
    startCommentPlacement: highlightComposable.startCommentPlacement,
    cancelCommentPlacement: highlightComposable.cancelCommentPlacement,
    undoAnnotation,
    redoAnnotation,
    registerAnnotationHistoryCommand: registerShapeHistoryCommand,
    focusAnnotationComment: commentCrud.focusAnnotationComment,
    updateAnnotationComment: commentCrud.updateAnnotationComment,
    deleteAnnotationComment: commentCrud.deleteAnnotationComment,
    getMarkupSubtypeOverrides: annotations.editor.getMarkupSubtypeOverrides,
    getMarkupSubtypeHints: annotations.editor.getMarkupSubtypeHints,
    getAllShapes: shapeComposable.getAllShapes,
    getDeletedEmbeddedShapeAnnotationIds: shapeComposable.getDeletedEmbeddedAnnotationIds,
    getDeletedEmbeddedShapeStableKeys: shapeComposable.getDeletedEmbeddedShapeStableKeys,
    loadShapes: shapeComposable.loadShapes,
    clearShapes: shapeComposable.clearShapes,
    clearSelectedShape: selectedShapeCommands.clearSelectedShape,
    deleteSelectedShape: selectedShapeCommands.deleteSelectedShape,
    hasShapes: shapeComposable.hasShapes,
    selectedShapeId: shapeComposable.selectedShapeId,
    updateShape: selectedShapeCommands.updateShape,
    getSelectedShape: selectedShapeCommands.getSelectedShape,
    startImagePlacement,
    clearPendingImagePlacement,
    restorePendingImagePlacement,
    invalidatePages,
    suppressAnnotationId,
    unsuppressAnnotationId: (annotationId: string) => {
        managedEmbeddedPdfShapes.unsuppressAnnotationId(annotationId);
        annotations.commentSync.unsuppressAnnotationId(annotationId);
    },
    suppressAnnotationStableKey: annotations.commentSync.suppressAnnotationStableKey,
    unsuppressAnnotationStableKey: annotations.commentSync.unsuppressAnnotationStableKey,
    removeAnnotationFromDom,
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

.pdfViewer.pdfViewer--mode-facing .pdf-viewer-virtual-spacer,
.pdfViewer.pdfViewer--mode-facing-first-single .pdf-viewer-virtual-spacer {
    grid-column: 1 / -1;
    justify-self: stretch;
}

.pdfViewer .page_container--rendered .pdf-page-skeleton {
    display: none;
}

.pdfViewer .page_container:not(.page_container--rendered) .text-layer,
.pdfViewer .page_container:not(.page_container--rendered) .textLayer,
.pdfViewer .page_container:not(.page_container--rendered) .annotation-layer,
.pdfViewer .page_container:not(.page_container--rendered) .annotationLayer,
.pdfViewer .page_container:not(.page_container--rendered) .annotation-editor-layer,
.pdfViewer .page_container:not(.page_container--rendered) .annotationEditorLayer {
    opacity: 0;
    pointer-events: none;
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

.pdfViewer.pdfViewer--resize-transition .text-layer,
.pdfViewer.pdfViewer--resize-transition .textLayer,
.pdfViewer.pdfViewer--resize-transition .annotation-layer,
.pdfViewer.pdfViewer--resize-transition .annotationLayer,
.pdfViewer.pdfViewer--resize-transition .annotation-editor-layer,
.pdfViewer.pdfViewer--resize-transition .annotationEditorLayer,
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

    &.pdfViewer--active-spread-fits-width {
        overflow-x: hidden;
        overscroll-behavior-x: none;
    }

    &.pdfViewer--fit-width-page-fits {
        overflow-x: hidden;
        overscroll-behavior-x: none;
    }

    /*
     * Single-page mode is driven entirely by JS (see usePdfSinglePageScroll).
     * CSS scroll-snap was previously enabled here but collided with the JS
     * snap targets — `scroll-snap-align: center` resolves to a different
     * scrollTop than the JS `centerTarget` calculation (margin handling
     * differs), causing the engine to override JS-set positions. The most
     * visible symptom was that wheel-up appeared to do nothing because the
     * snap engine pulled the position back. JS owns paging end-to-end now.
     */

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

.pdfViewer .page_container--buffered {
    position: absolute;
    top: 0;
    left: 0;
    margin: 0;
    visibility: hidden;
    pointer-events: none;
    transform: translateX(-200vw);
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

.pdfViewer .annotationEditorLayer .highlightEditor .pdf-markup-subtype-fragments,
.pdfViewer .annotation-editor-layer .highlightEditor .pdf-markup-subtype-fragments {
    position: absolute;
    inset: 0;
    pointer-events: none;
}

.pdfViewer .annotationEditorLayer .highlightEditor .pdf-markup-subtype-fragment,
.pdfViewer .annotation-editor-layer .highlightEditor .pdf-markup-subtype-fragment {
    position: absolute;
    pointer-events: none;
}

.pdfViewer .annotationEditorLayer .highlightEditor .pdf-markup-subtype-fragment--underline,
.pdfViewer .annotation-editor-layer .highlightEditor .pdf-markup-subtype-fragment--underline {
    border-bottom: max(1.5px, calc(var(--total-scale-factor, 1) * 1px)) solid var(--pdf-markup-subtype-color, var(--ui-primary));
}

.pdfViewer .annotationEditorLayer .highlightEditor .pdf-markup-subtype-fragment--strikeout,
.pdfViewer .annotation-editor-layer .highlightEditor .pdf-markup-subtype-fragment--strikeout {
    border-top: max(1.5px, calc(var(--total-scale-factor, 1) * 1px)) solid var(--pdf-markup-subtype-color, var(--ui-error));
}

.pdfViewer .annotationEditorLayer .highlightEditor[class*='pdf-markup-subtype-underline']::after,
.pdfViewer .annotation-editor-layer .highlightEditor[class*='pdf-markup-subtype-underline']::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: 7%;
    border-bottom: max(1.5px, calc(var(--total-scale-factor, 1) * 1px)) solid var(--pdf-markup-subtype-color, var(--ui-primary));
    pointer-events: none;
}

.pdfViewer .annotationEditorLayer .highlightEditor[class*='pdf-markup-subtype-strikeout']::after,
.pdfViewer .annotation-editor-layer .highlightEditor[class*='pdf-markup-subtype-strikeout']::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    border-top: max(1.5px, calc(var(--total-scale-factor, 1) * 1px)) solid var(--pdf-markup-subtype-color, var(--ui-error));
    pointer-events: none;
}

.pdfViewer .annotationEditorLayer .highlightEditor.pdf-markup-subtype-fragmented[class*='pdf-markup-subtype-underline']::after,
.pdfViewer .annotation-editor-layer .highlightEditor.pdf-markup-subtype-fragmented[class*='pdf-markup-subtype-underline']::after,
.pdfViewer .annotationEditorLayer .highlightEditor.pdf-markup-subtype-fragmented[class*='pdf-markup-subtype-strikeout']::after,
.pdfViewer .annotation-editor-layer .highlightEditor.pdf-markup-subtype-fragmented[class*='pdf-markup-subtype-strikeout']::after {
    content: none !important;
    border: 0 !important;
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

/*
 * Single-page CSS scroll-snap was removed — paging is JS-driven via
 * usePdfSinglePageScroll. Keeping a CSS snap point on each .page_container
 * fought the JS centerTarget math and produced asymmetric wheel behavior.
 */

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
                background: var(--resizer-bg-color, var(--ui-primary));
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
