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
import {
    usePdfScroll,
    type IScrollToPageOptions,
} from '@app/composables/pdf/usePdfScroll';
import { usePdfSkeletonInsets } from '@app/composables/pdf/usePdfSkeletonInsets';
import { usePdfImagePlacement } from '@app/composables/pdf/usePdfImagePlacement';
import { useAnnotationShapes } from '@app/composables/pdf/useAnnotationShapes';
import { toShapeAnnotationCommentSummary } from '@app/composables/pdf/annotations/shapeAnnotationComments';
import { useManagedEmbeddedPdfShapes } from '@app/composables/pdf/useManagedEmbeddedPdfShapes';
import { usePdfShapeHistory } from '@app/composables/pdf/usePdfShapeHistory';
import { usePdfAppAnnotationHistory } from '@app/composables/pdf/usePdfAppAnnotationHistory';
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
import { PDF_VIEWER_PAGE_SKELETON_DELAY_MS } from '@app/constants/timeouts';
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
    TMarkupSubtype,
} from '@app/types/annotations';
import type { IPdfPlacedImageFinalizePayload } from '@app/types/pdfImagePlacement';
import type { IAnnotationContextMenuPayload } from '@app/composables/pdf/annotationContextMenu';
import {
    isSelectionInteractionTool,
    isNoteEligibleComment,
    markerRectCenterDistance,
    isSelectionMarkupTool,
} from '@app/composables/pdf/annotations/annotationRules';
import {
    annotationCommentsMatch,
    selectPreferredAnnotationComment,
} from '@app/composables/pdf/annotationCommentMatching';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { toOpaqueHighlightDisplayColor } from '@app/composables/pdf/textMarkupColor';
import { logPdfNav } from '@app/utils/pdfNavLog';
import { BrowserLogger } from '@app/utils/browserLogger';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { runGuardedTask } from '@app/utils/asyncGuard';
import { compareAnnotationCommentSummaries } from '@app/utils/pdfAnnotationComments';
import { applyAnnotationCommentTextMarkupColor } from '@app/composables/pdf/annotations/annotationDomRemoval';
import { getStoredAnnotationEditor } from '@app/services/pdfjs/annotationEditorMutation';
import {
    renderPdfDocumentPagesForBrowserPrint,
    type IBrowserPrintDocument,
} from '@app/utils/pdfPrint';

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

interface IPendingMarkerMove {
    markerRect: IAnnotationMarkerRect;
    previousMarkerRect: IAnnotationMarkerRect | null;
    movedAt: number;
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
const emptyAnnotationEditorState: IAnnotationEditorState = {
    isEditing: false,
    isEmpty: true,
    hasSomethingToUndo: false,
    hasSomethingToRedo: false,
    hasSelectedEditor: false,
};
const pdfjsAnnotationEditorState = ref<IAnnotationEditorState>({ ...emptyAnnotationEditorState });
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

interface IAnnotationMutationOptions {
    scheduleCommentSync?: boolean;
}

function emitAnnotationModified(payload?: IAnnotationModifiedPayload) {
    emit('annotation-modified', payload);
}

function emitForcedAnnotationMutation(options: IAnnotationMutationOptions = {}) {
    emitAnnotationModified({ forceDirty: true });
    if (options.scheduleCommentSync) {
        annotations.commentSync.scheduleAnnotationCommentsSync();
    }
}

const viewerHost = ref<HTMLElement | null>(null);
const viewerContainer = ref<HTMLElement | null>(null);
const fitWidthHorizontalScrollLocked = ref(false);
const resizeTransitionVisible = ref(false);
const resizeTransitionAnchorPage = ref<number | null>(null);
const annotationUiManager = shallowRef<AnnotationEditorUIManager | null>(null);
const annotationL10n = shallowRef<GenericL10n | null>(null);
const annotationCommentsCache = shallowRef<IAnnotationCommentSummary[]>([]);
const appAnnotationHistory = usePdfAppAnnotationHistory({
    pdfjsAnnotationState: pdfjsAnnotationEditorState,
    emitAnnotationState: (state) => emit('annotation-state', state),
    markModified: emitAnnotationModified,
});
const pendingMarkerMoves = new Map<string, IPendingMarkerMove>();
const locallyDeletedAnnotationComments: IAnnotationCommentSummary[] = [];
const activeCommentStableKey = ref<string | null>(null);
const ANNOTATION_RELOAD_CACHE_GRACE_MS = 5_000;
const HORIZONTAL_SCROLL_CLAMP_EPSILON_PX = 1.5;
const zoomVirtualizationFreeze = ref<IZoomVirtualizationFreeze | null>(null);
const renderedPageStateVersion = ref(0);
const {
    beginViewerLoadSettle,
    settleViewerLoadSettle,
    waitForViewerLoadSettled,
} = useViewerLoadSettle();
let pendingInitialVisualReadyToken: number | null = null;
let annotationReloadCacheGraceUntil = 0;
const regionSnip = usePdfRegionSnip({ viewerContainer });
const cropSelection = usePdfCropSelection({ viewerContainer });

function settleViewerLoadSettledWithManagedShapes(token: number) {
    managedEmbeddedPdfShapes.settleViewerLoadSettledWithManagedShapes(token, settleViewerLoadSettle);
}

function handleRenderedPageStateChanged() {
    renderedPageStateVersion.value += 1;
}

function markInitialVisualReady(pageNumber: number, source: 'canvas' | 'page-render') {
    if (pendingInitialVisualReadyToken === null) {
        return;
    }

    const token = pendingInitialVisualReadyToken;
    pendingInitialVisualReadyToken = null;
    emit('initial-visual-ready', { pageNumber });
    BrowserLogger.debug('loader', 'PDF viewer initial visual ready', {
        token,
        pageNumber,
        source,
    });
}

function handlePageCanvasMounted(pageNumber: number) {
    renderedPageStateVersion.value += 1;
    delayedSkeleton.markPageRendered(pageNumber);
    managedEmbeddedPdfShapes.syncAfterPageRendered(pageNumber);
    markInitialVisualReady(pageNumber, 'canvas');
}

function handlePageRendered(pageNumber: number) {
    delayedSkeleton.markPageRendered(pageNumber);
    singlePageScroll.clearContinuousNavigationTargetForPage(pageNumber);
    managedEmbeddedPdfShapes.syncAfterPageRendered(pageNumber);
    markInitialVisualReady(pageNumber, 'page-render');
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
    appAnnotationHistory.registerCommand(command);
}

const {
    applyShapeUpdateWithHistory,
    handleShapeCreated,
} = usePdfShapeHistory({
    registerCommand: registerShapeHistoryCommand,
    addShape: shapeComposable.addShape,
    updateShape: shapeComposable.updateShape,
    deleteShape: shapeComposable.deleteShapeByReference,
    selectShape: shapeComposable.selectShape,
    markModified: emitAnnotationModified,
});

const selectedShapeCommands = usePdfSelectedShapeCommands({
    selectedShapeId: shapeComposable.selectedShapeId,
    hasShapes: shapeComposable.hasShapes,
    isAnySaving,
    getShapeById: shapeComposable.getShapeById,
    selectShape: shapeComposable.selectShape,
    updateShape: shapeComposable.updateShape,
    deleteShape: shapeComposable.deleteShape,
    deleteShapeByReference: shapeComposable.deleteShapeByReference,
    addShape: shapeComposable.addShape,
    applyShapeUpdateWithHistory,
    refreshDeletedEmbeddedShape,
    registerHistoryCommand: registerShapeHistoryCommand,
    markModified: emitAnnotationModified,
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
    renderAnnotationEditorLayerForPage,
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
        options?: IScrollToPageOptions,
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

const navigationAnchorPage = computed(() =>
    singlePageScroll.searchNavigationTargetPage.value
    ?? singlePageScroll.continuousNavigationTargetPage.value,
);

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
const isTextSelectionModeActive = computed(() =>
    annotationCursorMode.value
    && (annotationTool.value === 'none' || isSelectionInteractionTool(annotationTool.value)),
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

watch(annotationTool, (tool) => {
    if (!isSelectionInteractionTool(tool)) {
        shapeComposable.selectShape(null);
        shapeComposable.focusShape(null);
    }
});

function getShapeAnnotationCommentSummaries() {
    return shapeComposable.getAllShapes().map((shape, index) => toShapeAnnotationCommentSummary(shape, index));
}

function emitAnnotationCommentsForSidebar(
    comments: IAnnotationCommentSummary[],
    options: { includeShapes?: boolean } = {},
) {
    const { includeShapes = true } = options;
    const visibleComments = includeShapes
        ? [
            ...comments,
            ...getShapeAnnotationCommentSummaries(),
        ]
        : comments;
    emit('annotation-comments', visibleComments.slice().sort(compareAnnotationCommentSummaries));
}

function findShapeForAnnotationComment(comment: IAnnotationCommentSummary) {
    if (comment.source !== 'shape') {
        return null;
    }
    return shapeComposable.getAllShapes().find((shape) => {
        const summary = toShapeAnnotationCommentSummary(shape);
        return (
            summary.stableKey === comment.stableKey
            || summary.id === comment.id
            || (summary.annotationId && summary.annotationId === comment.annotationId)
        );
    }) ?? null;
}

watch(
    () => shapeComposable.shapes.value,
    () => {
        if (!src.value && !pdfDocument.value) {
            return;
        }
        emitAnnotationCommentsForSidebar(annotationCommentsCache.value);
        if (appAnnotationHistory.canUndo.value || appAnnotationHistory.canRedo.value) {
            appAnnotationHistory.emitCombinedState();
        }
    },
);

function upsertAnnotationComment(comment: IAnnotationCommentSummary) {
    clearLocalDeletionForNewTransientComment(comment);
    const next = normalizeAnnotationComments([
        ...annotationCommentsCache.value,
        comment,
    ]);
    annotationCommentsCache.value = next;
    emitAnnotationCommentsForSidebar(next);
}

function isAnnotationReloadCacheGraceActive() {
    return isAnySaving.value || Date.now() <= annotationReloadCacheGraceUntil;
}

function commentsShareTransientPlacement(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    return left.pageIndex === right.pageIndex
        && isNoteEligibleComment(left)
        && isNoteEligibleComment(right)
        && markerRectCenterDistance(left.markerRect, right.markerRect) < 0.01;
}

function isTransientEditorOnlyComment(comment: IAnnotationCommentSummary) {
    return comment.source === 'editor' && !comment.annotationId;
}

function withTransientNoteCreationTimestamp(comment: IAnnotationCommentSummary) {
    if (
        !isTransientEditorOnlyComment(comment)
        || !isNoteEligibleComment(comment)
        || comment.createdAt
    ) {
        return comment;
    }
    return {
        ...comment,
        createdAt: Date.now(),
    };
}

function getPendingMarkerMove(comment: IAnnotationCommentSummary) {
    return pendingMarkerMoves.get(comment.stableKey) ?? null;
}

function normalizeAnnotationNoteText(comment: IAnnotationCommentSummary) {
    return comment.text.trim().replace(/[\u200B\uFEFF]/gu, '');
}

function getAnnotationDisplayText(comment: IAnnotationCommentSummary) {
    return comment.displayText?.trim()
        || comment.text.trim()
        || comment.previewText?.trim()
        || '';
}

function isTextMarkupComment(comment: IAnnotationCommentSummary) {
    return isTextMarkupSubtype(comment.subtype);
}

function toTextMarkupSubtype(comment: IAnnotationCommentSummary): TMarkupSubtype | null {
    const subtype = (comment.subtype ?? '').trim().toLowerCase();
    if (subtype === 'highlight') {
        return 'Highlight';
    }
    if (subtype === 'underline') {
        return 'Underline';
    }
    if (subtype === 'strikeout' || subtype === 'strikethrough') {
        return 'StrikeOut';
    }
    if (subtype === 'squiggly') {
        return 'Squiggly';
    }
    return null;
}

function updateCachedAnnotationCommentColor(comment: IAnnotationCommentSummary, color: string) {
    const next = annotationCommentsCache.value.map((candidate) => {
        const sameStableKey = candidate.stableKey === comment.stableKey;
        const sameAnnotationId = Boolean(
            comment.annotationId
            && candidate.annotationId
            && candidate.annotationId === comment.annotationId,
        );
        if (!sameStableKey && !sameAnnotationId) {
            return candidate;
        }
        return {
            ...candidate,
            color,
            colorEdited: true,
            modifiedAt: Date.now(),
        };
    });
    annotationCommentsCache.value = next;
    emitAnnotationCommentsForSidebar(next);
}

function applyEmbeddedMarkupDomColor(comment: IAnnotationCommentSummary, color: string) {
    const container = viewerContainer.value;
    if (!container) {
        return false;
    }
    const displayColor = toTextMarkupSubtype(comment) === 'Highlight'
        ? toOpaqueHighlightDisplayColor(
            color,
            annotationSettings.value?.highlightOpacity ?? DEFAULT_ANNOTATION_SETTINGS.highlightOpacity,
        )
        : color;
    return applyAnnotationCommentTextMarkupColor(container, comment, displayColor);
}

function findTextMarkupEditorForComment(comment: IAnnotationCommentSummary) {
    return annotations.crud.findEditorForComment(comment)
        ?? (comment.annotationId
            ? annotations.crud.findEditorByAnnotationElementId(comment.pageIndex, comment.annotationId)
            : null)
        ?? (comment.annotationId
            ? getStoredAnnotationEditor(pdfDocument.value, comment.annotationId)
            : null);
}

function markerRectAxisOverlap(
    leftStart: number,
    leftSize: number,
    rightStart: number,
    rightSize: number,
) {
    return Math.max(0, Math.min(leftStart + leftSize, rightStart + rightSize) - Math.max(leftStart, rightStart));
}

function commentsShareTextMarkupLinePlacement(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    const leftRect = left.markerRect;
    const rightRect = right.markerRect;
    if (!leftRect || !rightRect) {
        return false;
    }

    const verticalOverlap = markerRectAxisOverlap(
        leftRect.top,
        leftRect.height,
        rightRect.top,
        rightRect.height,
    );
    const minHeight = Math.min(leftRect.height, rightRect.height);
    if (minHeight <= 0 || verticalOverlap / minHeight < 0.45) {
        return false;
    }

    return markerRectAxisOverlap(
        leftRect.left,
        leftRect.width,
        rightRect.left,
        rightRect.width,
    ) > 0;
}

function commentsShareTextMarkupReloadPlacement(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    return left.pageIndex === right.pageIndex
        && isTextMarkupComment(left)
        && isTextMarkupComment(right)
        && (left.subtype ?? '').toLowerCase() === (right.subtype ?? '').toLowerCase()
        && (
            markerRectCenterDistance(left.markerRect, right.markerRect) < 0.02
            || commentsShareTextMarkupLinePlacement(left, right)
        );
}

function findPreviousReloadDisplayTextComment(
    comment: IAnnotationCommentSummary,
    previousComments: IAnnotationCommentSummary[],
) {
    if (!isAnnotationReloadCacheGraceActive() || !isTextMarkupComment(comment)) {
        return null;
    }

    const candidates = previousComments.filter(previous =>
        isTextMarkupComment(previous)
        && getAnnotationDisplayText(previous).length > 0
        && (
            annotationCommentsMatch(previous, comment)
            || commentsShareTextMarkupReloadPlacement(previous, comment)
        ),
    );
    if (candidates.length === 0) {
        return null;
    }
    if (candidates.length === 1) {
        return candidates[0]!;
    }
    return [...candidates].sort((left, right) =>
        markerRectCenterDistance(left.markerRect, comment.markerRect)
        - markerRectCenterDistance(right.markerRect, comment.markerRect),
    )[0] ?? null;
}

function withReloadStableDisplayText(
    comment: IAnnotationCommentSummary,
    previous: IAnnotationCommentSummary | null | undefined,
) {
    const displayText = previous ? getAnnotationDisplayText(previous) : '';
    if (!displayText) {
        return comment;
    }
    return {
        ...comment,
        displayText,
    };
}

function withReloadStableCreatedAt(
    comment: IAnnotationCommentSummary,
    previous: IAnnotationCommentSummary | null | undefined,
) {
    if (comment.createdAt || !previous?.createdAt) {
        return comment;
    }
    return {
        ...comment,
        createdAt: previous.createdAt,
    };
}

function withReloadStableSummaryFields(
    comment: IAnnotationCommentSummary,
    previous: IAnnotationCommentSummary | null | undefined,
) {
    return withReloadStableCreatedAt(
        withReloadStableDisplayText(comment, previous),
        previous,
    );
}

function commentsShareNonEmptyNoteText(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    const leftText = normalizeAnnotationNoteText(left);
    const rightText = normalizeAnnotationNoteText(right);
    return leftText.length > 0 && leftText === rightText;
}

function markerMoveTouchesComment(
    move: IPendingMarkerMove | null,
    comment: IAnnotationCommentSummary,
) {
    if (!move) {
        return false;
    }
    return markerRectCenterDistance(move.markerRect, comment.markerRect) < 0.015
        || markerRectCenterDistance(move.previousMarkerRect, comment.markerRect) < 0.015;
}

function commentsShareTransientTransitionIdentity(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    if (
        left.pageIndex !== right.pageIndex
        || !isNoteEligibleComment(left)
        || !isNoteEligibleComment(right)
        || isTransientEditorOnlyComment(left) === isTransientEditorOnlyComment(right)
    ) {
        return false;
    }

    if (commentsShareNonEmptyNoteText(left, right)) {
        return true;
    }

    const leftMove = getPendingMarkerMove(left);
    const rightMove = getPendingMarkerMove(right);
    return markerMoveTouchesComment(leftMove, right)
        || markerMoveTouchesComment(rightMove, left);
}

function commentsShareActiveTransientTransitionIdentity(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    return commentsShareTransientTransitionIdentity(left, right)
        && (
            isAnnotationReloadCacheGraceActive()
            || Boolean(getPendingMarkerMove(left))
            || Boolean(getPendingMarkerMove(right))
        );
}

function findPreviousTransientTransitionComment(
    comment: IAnnotationCommentSummary,
    previousComments: IAnnotationCommentSummary[],
) {
    if (!isAnnotationReloadCacheGraceActive() || !isNoteEligibleComment(comment)) {
        return null;
    }

    const candidates = previousComments.filter(previous =>
        isTransientEditorOnlyComment(previous)
        && commentsShareTransientTransitionIdentity(previous, comment),
    );
    if (candidates.length === 0) {
        return null;
    }
    if (candidates.length === 1) {
        return candidates[0]!;
    }

    const ordered = [...candidates].sort((left, right) => {
        const leftMove = getPendingMarkerMove(left);
        const rightMove = getPendingMarkerMove(right);
        const leftDistance = markerRectCenterDistance(
            leftMove?.markerRect ?? left.markerRect,
            comment.markerRect,
        );
        const rightDistance = markerRectCenterDistance(
            rightMove?.markerRect ?? right.markerRect,
            comment.markerRect,
        );
        return leftDistance - rightDistance;
    });

    const best = ordered[0] ?? null;
    const secondBest = ordered[1] ?? null;
    if (!best || !secondBest) {
        return best;
    }

    const bestDistance = markerRectCenterDistance(
        getPendingMarkerMove(best)?.markerRect ?? best.markerRect,
        comment.markerRect,
    );
    const secondBestDistance = markerRectCenterDistance(
        getPendingMarkerMove(secondBest)?.markerRect ?? secondBest.markerRect,
        comment.markerRect,
    );
    return secondBestDistance - bestDistance > 0.02 ? best : null;
}

function clearLocalDeletionForNewTransientComment(comment: IAnnotationCommentSummary) {
    if (!isTransientEditorOnlyComment(comment)) {
        return;
    }
    for (let index = locallyDeletedAnnotationComments.length - 1; index >= 0; index -= 1) {
        const deleted = locallyDeletedAnnotationComments[index];
        if (!deleted || !commentsShareTransientPlacement(deleted, comment)) {
            continue;
        }
        locallyDeletedAnnotationComments.splice(index, 1);
    }
}

function localDeletionMatchesComment(
    deleted: IAnnotationCommentSummary,
    comment: IAnnotationCommentSummary,
) {
    if (isTransientEditorOnlyComment(deleted) || isTransientEditorOnlyComment(comment)) {
        return commentsShareTransientPlacement(deleted, comment)
            || commentsShareActiveTransientTransitionIdentity(deleted, comment);
    }
    return annotationCommentsMatch(deleted, comment) || commentsShareTransientPlacement(deleted, comment);
}

function clearLocalDeletionForAnnotationComment(comment: IAnnotationCommentSummary) {
    for (let index = locallyDeletedAnnotationComments.length - 1; index >= 0; index -= 1) {
        const deleted = locallyDeletedAnnotationComments[index];
        if (deleted && localDeletionMatchesComment(deleted, comment)) {
            locallyDeletedAnnotationComments.splice(index, 1);
        }
    }
}

function commentsRepresentSameVisibleNote(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    if (annotationCommentsMatch(left, right)) {
        return true;
    }
    if (!(isTransientEditorOnlyComment(left) || isTransientEditorOnlyComment(right))) {
        return false;
    }
    return commentsShareTransientPlacement(left, right)
        || commentsShareActiveTransientTransitionIdentity(left, right);
}

function selectPreferredVisibleComment(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    if (
        (
            commentsShareTransientPlacement(left, right)
            || commentsShareActiveTransientTransitionIdentity(left, right)
        )
        && isTransientEditorOnlyComment(left) !== isTransientEditorOnlyComment(right)
    ) {
        return isTransientEditorOnlyComment(left) ? right : left;
    }
    return selectPreferredAnnotationComment(left, right);
}

function isLocallyDeletedAnnotationComment(comment: IAnnotationCommentSummary) {
    return locallyDeletedAnnotationComments.some(deleted => localDeletionMatchesComment(deleted, comment));
}

function shouldSuppressEmptyPdfNoteDuringTransientEdit(
    comment: IAnnotationCommentSummary,
    comments: IAnnotationCommentSummary[],
) {
    if (
        comment.source !== 'pdf'
        || normalizeAnnotationNoteText(comment).length > 0
        || !isNoteEligibleComment(comment)
    ) {
        return false;
    }

    return comments.some(candidate =>
        candidate.pageIndex === comment.pageIndex
        && isTransientEditorOnlyComment(candidate)
        && isNoteEligibleComment(candidate),
    );
}

function normalizeAnnotationComments(
    comments: IAnnotationCommentSummary[],
    options: { dropTransientEditorOnly?: boolean } = {},
) {
    const normalized: IAnnotationCommentSummary[] = [];
    for (const comment of comments) {
        if (
            isLocallyDeletedAnnotationComment(comment)
            || (options.dropTransientEditorOnly === true && isTransientEditorOnlyComment(comment))
            || shouldSuppressEmptyPdfNoteDuringTransientEdit(comment, comments)
        ) {
            continue;
        }

        const existingIndex = normalized.findIndex(candidate => commentsRepresentSameVisibleNote(candidate, comment));
        if (existingIndex === -1) {
            normalized.push(comment);
            continue;
        }

        normalized[existingIndex] = selectPreferredVisibleComment(normalized[existingIndex]!, comment);
    }
    return normalized;
}

function markAnnotationCommentLocallyDeleted(comment: IAnnotationCommentSummary) {
    locallyDeletedAnnotationComments.push(comment);
    pendingMarkerMoves.delete(comment.stableKey);
    for (const candidate of annotationCommentsCache.value) {
        if (isLocallyDeletedAnnotationComment(candidate)) {
            pendingMarkerMoves.delete(candidate.stableKey);
        }
    }
    if (!isTransientEditorOnlyComment(comment)) {
        annotations.commentSync.suppressAnnotationStableKey(comment.stableKey);
    }
    if (comment.annotationId) {
        annotations.commentSync.suppressAnnotationId(comment.annotationId);
    }
    const next = annotationCommentsCache.value.filter(candidate => !isLocallyDeletedAnnotationComment(candidate));
    annotationCommentsCache.value = next;
    emitAnnotationCommentsForSidebar(next);
}

function restoreAnnotationCommentLocally(comment: IAnnotationCommentSummary) {
    clearLocalDeletionForAnnotationComment(comment);
    annotations.commentSync.unsuppressAnnotationStableKey(comment.stableKey);
    if (comment.annotationId) {
        annotations.commentSync.unsuppressAnnotationId(comment.annotationId);
    }
    pendingMarkerMoves.delete(comment.stableKey);
    upsertAnnotationComment(comment);
}

function mergeAnnotationCommentsThroughReload(
    incomingComments: IAnnotationCommentSummary[],
    previousComments: IAnnotationCommentSummary[],
) {
    const merged = incomingComments.map((comment) => {
        const previousStableComment = previousComments.find(previous =>
            commentsRepresentSameVisibleNote(comment, previous)
            || commentsShareTransientTransitionIdentity(comment, previous),
        );
        const previousDisplayTextComment = findPreviousReloadDisplayTextComment(
            comment,
            previousComments,
        );
        const displayStableComment = withReloadStableSummaryFields(
            comment,
            previousDisplayTextComment ?? previousStableComment,
        );
        const pendingMarkerMove = pendingMarkerMoves.get(comment.stableKey);
        if (pendingMarkerMove) {
            return {
                ...displayStableComment,
                markerRect: pendingMarkerMove.markerRect,
            };
        }

        if (!isAnnotationReloadCacheGraceActive() || !isNoteEligibleComment(comment)) {
            return displayStableComment;
        }

        const transientPrevious = findPreviousTransientTransitionComment(comment, previousComments);
        if (transientPrevious?.markerRect) {
            return {
                ...withReloadStableSummaryFields(displayStableComment, transientPrevious),
                markerRect: getPendingMarkerMove(transientPrevious)?.markerRect ?? transientPrevious.markerRect,
            };
        }

        const previous = previousComments.find(candidate => annotationCommentsMatch(candidate, comment));
        if (!previous?.markerRect) {
            return displayStableComment;
        }

        return {
            ...withReloadStableSummaryFields(displayStableComment, previous),
            markerRect: previous.markerRect,
        };
    });

    for (const previous of previousComments) {
        const hasMergedReplacement = merged.some(comment =>
            commentsRepresentSameVisibleNote(comment, previous)
            || commentsShareTransientTransitionIdentity(comment, previous),
        );
        const canCarryPreviousAfterGrace = isTransientEditorOnlyComment(previous) && !hasMergedReplacement;
        if (
            !isNoteEligibleComment(previous)
            || (!isAnnotationReloadCacheGraceActive() && !canCarryPreviousAfterGrace)
            || isLocallyDeletedAnnotationComment(previous)
            || hasMergedReplacement
        ) {
            continue;
        }
        merged.push(previous);
    }

    return normalizeAnnotationComments(merged);
}

function isGracePreservedEditorOnlyComment(comment: IAnnotationCommentSummary) {
    return isTransientEditorOnlyComment(comment)
        && isAnnotationReloadCacheGraceActive()
        && annotationCommentsCache.value.some(candidate => annotationCommentsMatch(candidate, comment));
}

async function focusShapeAnnotationComment(comment: IAnnotationCommentSummary) {
    const shape = findShapeForAnnotationComment(comment);
    if (!shape) {
        return;
    }

    activeCommentStableKey.value = comment.stableKey;
    shapeComposable.focusShape(shape.id);

    const pageNumber = Math.min(
        Math.max(comment.pageNumber, 1),
        Math.max(1, numPages.value),
    );
    singlePageScroll.scrollToPage(pageNumber, { markerRect: comment.markerRect });

    await nextTick();
    updateVisibleRange(viewerContainer.value, numPages.value);
    try {
        await renderVisiblePages(
            {
                start: pageNumber,
                end: pageNumber,
            },
            {
                preserveRenderedPages: true,
                bufferOverride: 0,
            },
        );
    } catch (error) {
        BrowserLogger.warn('annotations', `Failed to render page ${pageNumber} while focusing shape annotation`, error);
    }
}

async function focusAnnotationComment(comment: IAnnotationCommentSummary) {
    if (comment.source === 'shape') {
        await focusShapeAnnotationComment(comment);
        return;
    }

    shapeComposable.focusShape(null);
    await commentCrud.focusAnnotationComment(comment);
}

async function deleteAnnotationComment(comment: IAnnotationCommentSummary) {
    if (comment.source === 'shape') {
        const shape = findShapeForAnnotationComment(comment);
        if (!shape) {
            return false;
        }
        if (!selectedShapeCommands.deleteShapeById(shape.id)) {
            return false;
        }
        emitAnnotationCommentsForSidebar(annotationCommentsCache.value);
        return true;
    }

    if (isGracePreservedEditorOnlyComment(comment)) {
        markAnnotationCommentLocallyDeleted(comment);
        emitForcedAnnotationMutation();
        return true;
    }

    const deleted = await commentCrud.deleteAnnotationComment(comment);
    if (deleted) {
        markAnnotationCommentLocallyDeleted(comment);
    }
    return deleted;
}

function applyAnnotationCommentsFromSync(comments: IAnnotationCommentSummary[]) {
    const previousComments = annotationCommentsCache.value;
    const merged = mergeAnnotationCommentsThroughReload(comments, previousComments);
    emitAnnotationCommentsForSidebar(merged);
    return merged;
}

let undoPdfjsAnnotationHandler: (() => void) | null = null;
let redoPdfjsAnnotationHandler: (() => void) | null = null;

const annotations = useAnnotationOrchestrator({
    viewerContainer,
    pdfDocument,
    numPages,
    currentPage: viewerCurrentPage,
    effectiveScale,
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
    scrollToPage: (pageNumber, options) => singlePageScroll.scrollToPage(pageNumber, options),
    renderVisiblePages,
    renderAnnotationEditorLayerForPage,
    updateVisibleRange,
    emitAnnotationModified,
    emitAnnotationState: (state) => {
        pdfjsAnnotationEditorState.value = state;
        appAnnotationHistory.emitCombinedState();
    },
    recordPdfjsHistoryCommand: params => appAnnotationHistory.registerPdfjsCommand(params),
    recordPdfjsHistoryClean: type => appAnnotationHistory.cleanPdfjsCommands(type),
    recordPdfjsHistoryUndo: () => appAnnotationHistory.notifyPdfjsUndo(),
    recordPdfjsHistoryRedo: () => appAnnotationHistory.notifyPdfjsRedo(),
    discardPdfjsHistory: () => appAnnotationHistory.discardPdfjsCommands(),
    isPdfjsHistoryRouted: () => appAnnotationHistory.isRoutingPdfjsHistory(),
    routeAnnotationHistoryUndo: () => appAnnotationHistory.undo({ undoPdfjs: () => undoPdfjsAnnotationHandler?.() }),
    routeAnnotationHistoryRedo: () => appAnnotationHistory.redo({ redoPdfjs: () => redoPdfjsAnnotationHandler?.() }),
    emitAnnotationComments: applyAnnotationCommentsFromSync,
    emitAnnotationOpenNote: (comment) => {
        const noteComment = withTransientNoteCreationTimestamp(comment);
        upsertAnnotationComment(noteComment);
        emit('annotation-open-note', noteComment);
    },
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
    const movedAt = Date.now();
    const previous = annotationCommentsCache.value[index]!;
    pendingMarkerMoves.set(comment.stableKey, {
        markerRect,
        previousMarkerRect: previous.markerRect ?? null,
        movedAt,
    });
    const updated = {
        ...previous,
        markerRect,
        createdAt: previous.createdAt ?? movedAt,
        modifiedAt: movedAt,
    };
    const editor = commentCrud.findEditorForComment(updated) ?? commentCrud.findEditorForComment(comment);
    if (editor) {
        editor.__evbPendingAnchorRect = markerRect;
        annotations.commentSync.pendingCommentEditorKeys.add(
            annotations.identity.getEditorPendingKey(editor, updated.pageIndex),
        );
    }
    const next = [...annotationCommentsCache.value];
    next[index] = updated;
    annotationCommentsCache.value = next;
    emitAnnotationCommentsForSidebar(next);
    emitForcedAnnotationMutation();
}

function cloneAnnotationCommentSnapshot(comment: IAnnotationCommentSummary): IAnnotationCommentSummary {
    return {
        ...comment,
        markerRect: comment.markerRect ? { ...comment.markerRect } : comment.markerRect,
    };
}

function getAnnotationCommentsSnapshot() {
    return normalizeAnnotationComments(annotationCommentsCache.value)
        .map(cloneAnnotationCommentSnapshot);
}

const {
    pageLayout,
    getPagePlaceholderStyle,
    virtualizedContinuousMode,
    navigationAnchorWindow,
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
    navigationAnchorPage,
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
        if (!isAnySaving.value) {
            appAnnotationHistory.clear();
        }
        clearPendingImagePlacement();
        activeCommentStableKey.value = null;
        pendingMarkerMoves.clear();
        locallyDeletedAnnotationComments.length = 0;
        if (!next) {
            annotationReloadCacheGraceUntil = 0;
            annotationCommentsCache.value = [];
            emitAnnotationCommentsForSidebar([], { includeShapes: false });
            return;
        }
        annotationReloadCacheGraceUntil = Date.now() + ANNOTATION_RELOAD_CACHE_GRACE_MS;
        window.setTimeout(() => {
            if (!isAnnotationReloadCacheGraceActive()) {
                pendingMarkerMoves.clear();
                const next = normalizeAnnotationComments(annotationCommentsCache.value);
                if (next.length !== annotationCommentsCache.value.length) {
                    annotationCommentsCache.value = next;
                    emitAnnotationCommentsForSidebar(next);
                }
                void annotations.commentSync.syncAnnotationComments();
            }
        }, ANNOTATION_RELOAD_CACHE_GRACE_MS + 100);
    }
});

const {
    shouldShowSkeleton,
    handleDragStart,
    handleDragMove,
    undoAnnotation: undoPdfjsAnnotation,
    redoAnnotation: redoPdfjsAnnotation,
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
undoPdfjsAnnotationHandler = undoPdfjsAnnotation;
redoPdfjsAnnotationHandler = redoPdfjsAnnotation;

function undoAnnotation() {
    if (appAnnotationHistory.canUndo.value) {
        appAnnotationHistory.undo({ undoPdfjs: undoPdfjsAnnotation });
        return;
    }
    undoPdfjsAnnotation();
}

function redoAnnotation() {
    if (appAnnotationHistory.canRedo.value) {
        appAnnotationHistory.redo({ redoPdfjs: redoPdfjsAnnotation });
        return;
    }
    redoPdfjsAnnotation();
}
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
const emptyLinksByPage: Record<number, never[]> = {};
const visibleMarkersByPage = computed(() => (
    new Map([...markersByPage.value].filter(([page]) => isPageRenderedForClass(page)))
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
    const showSkeleton = delayedSkeleton.shouldShowSkeleton(page);
    const isVisiblePage = page >= visibleRange.value.start && page <= visibleRange.value.end;
    if (showSkeleton && isVisiblePage) {
        logPdfNav('[PDF-NAV] page skeleton visible', {
            page,
            currentPage: viewerCurrentPage.value,
            visibleRange: `${visibleRange.value.start}-${visibleRange.value.end}`,
            pagesToRender: pagesToRender.value,
            rendered: isPageRenderedForClass(page),
            buffered: isPageBuffered(page),
            nearVisible: shouldShowSkeleton(page),
            delayMs: PDF_VIEWER_PAGE_SKELETON_DELAY_MS,
            zoom: zoom.value,
            zoomMode: zoomMode.value,
            fitMode: fitMode.value,
            effectiveScale: effectiveScale.value,
        });
    }
    return showSkeleton;
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
    'is-text-selection-mode': isTextSelectionModeActive.value,
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
        !!navigationAnchorWindow.value,
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
        searchAnchorPage,
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
            + ` searchAnchor=${searchAnchorPage ?? 'none'}`
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

async function renderLoadedPdfPagesForBrowserPrint(
    targetDocument: IBrowserPrintDocument,
    pageNumbers: number[],
    options?: { signal?: AbortSignal },
) {
    if (!pdfDocument.value) {
        throw new Error('Missing loaded PDF document');
    }

    await renderPdfDocumentPagesForBrowserPrint(
        targetDocument,
        pdfDocument.value,
        pageNumbers,
        options,
    );
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
    clearAnnotationHistory: () => appAnnotationHistory.clear(),
    renderLoadedPdfPagesForBrowserPrint,
    markSavedShapeState: shapeComposable.markSavedShapeState,
    highlightSelection: highlightComposable.highlightSelection,
    commentSelection: highlightComposable.commentSelection,
    commentAtPoint: highlightComposable.commentAtPoint,
    startCommentPlacement: highlightComposable.startCommentPlacement,
    cancelCommentPlacement: highlightComposable.cancelCommentPlacement,
    undoAnnotation,
    redoAnnotation,
    registerAnnotationHistoryCommand: registerShapeHistoryCommand,
    focusAnnotationComment,
    updateAnnotationComment: commentCrud.updateAnnotationComment,
    deleteAnnotationComment,
    getAnnotationCommentsSnapshot,
    getMarkupSubtypeOverrides: annotations.editor.getMarkupSubtypeOverrides,
    getMarkupSubtypeHints: annotations.editor.getMarkupSubtypeHints,
    getSelectedTextMarkupAnnotationProperties: annotations.editor.markupSubtype.getSelectedTextMarkupAnnotationProperties,
    updateSelectedTextMarkupAnnotationColor: (color: string) => {
        const didUpdate = annotations.editor.markupSubtype.updateSelectedTextMarkupAnnotationColor(color);
        if (didUpdate) {
            emitForcedAnnotationMutation({ scheduleCommentSync: true });
        }
        return didUpdate;
    },
    updateTextMarkupAnnotationColor: (comment: IAnnotationCommentSummary, color: string) => {
        const subtype = toTextMarkupSubtype(comment);
        const editor = findTextMarkupEditorForComment(comment);
        if (!subtype) {
            return false;
        }
        if (!editor) {
            applyEmbeddedMarkupDomColor(comment, color);
            updateCachedAnnotationCommentColor(comment, color);
            emitForcedAnnotationMutation();
            return true;
        }
        const didUpdate = annotations.editor.markupSubtype.updateTextMarkupAnnotationColor(
            editor,
            comment.pageIndex,
            subtype,
            color,
        );
        if (didUpdate) {
            applyEmbeddedMarkupDomColor(comment, color);
            updateCachedAnnotationCommentColor(comment, color);
            emitForcedAnnotationMutation({ scheduleCommentSync: true });
        }
        return didUpdate;
    },
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
        const comment = annotationCommentsCache.value.find(candidate => candidate.stableKey === stableKey);
        if (comment) {
            markAnnotationCommentLocallyDeleted(comment);
        }
        pendingMarkerMoves.delete(stableKey);
        annotationCommentsCache.value = annotationCommentsCache.value.filter(c => c.stableKey !== stableKey);
    },
    restoreAnnotationToInternalCache: restoreAnnotationCommentLocally,
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
.pdfViewer.is-selection-markup-tool .annotationEditorLayer,
.pdfViewer.is-text-selection-mode .annotation-editor-layer,
.pdfViewer.is-text-selection-mode .annotationEditorLayer {
    pointer-events: none !important;
}

.pdfViewer.is-selection-markup-tool .text-layer,
.pdfViewer.is-selection-markup-tool .textLayer,
.pdfViewer.is-text-selection-mode .text-layer,
.pdfViewer.is-text-selection-mode .textLayer {
    cursor: text !important;
}

.pdfViewer.is-selection-markup-tool .annotation-layer .editorAnnotation,
.pdfViewer.is-selection-markup-tool .annotation-layer .highlightAnnotation,
.pdfViewer.is-selection-markup-tool .annotation-layer .underlineAnnotation,
.pdfViewer.is-selection-markup-tool .annotation-layer .strikeoutAnnotation,
.pdfViewer.is-selection-markup-tool .annotation-layer .squigglyAnnotation,
.pdfViewer.is-selection-markup-tool .annotationLayer .editorAnnotation,
.pdfViewer.is-selection-markup-tool .annotationLayer .highlightAnnotation,
.pdfViewer.is-selection-markup-tool .annotationLayer .underlineAnnotation,
.pdfViewer.is-selection-markup-tool .annotationLayer .strikeoutAnnotation,
.pdfViewer.is-selection-markup-tool .annotationLayer .squigglyAnnotation,
.pdfViewer.is-text-selection-mode .annotation-layer .editorAnnotation,
.pdfViewer.is-text-selection-mode .annotation-layer .highlightAnnotation,
.pdfViewer.is-text-selection-mode .annotation-layer .underlineAnnotation,
.pdfViewer.is-text-selection-mode .annotation-layer .strikeoutAnnotation,
.pdfViewer.is-text-selection-mode .annotation-layer .squigglyAnnotation,
.pdfViewer.is-text-selection-mode .annotationLayer .editorAnnotation,
.pdfViewer.is-text-selection-mode .annotationLayer .highlightAnnotation,
.pdfViewer.is-text-selection-mode .annotationLayer .underlineAnnotation,
.pdfViewer.is-text-selection-mode .annotationLayer .strikeoutAnnotation,
.pdfViewer.is-text-selection-mode .annotationLayer .squigglyAnnotation {
    pointer-events: none !important;
    cursor: text !important;
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

/* ── Markup Subtype Visual Overrides (underline / strikethrough / squiggly) ──── */

.pdfViewer .annotationEditorLayer .highlightEditor.pdf-markup-subtype-visual-ready .internal,
.pdfViewer .annotation-editor-layer .highlightEditor.pdf-markup-subtype-visual-ready .internal {
    opacity: 0 !important;
}

.pdfViewer svg.highlight.pdf-markup-subtype-draw-underline,
.pdfViewer svg.highlight.pdf-markup-subtype-draw-strikeout,
.pdfViewer svg.highlight.pdf-markup-subtype-draw-squiggly {
    fill: transparent !important;
    fill-opacity: 0 !important;
    mix-blend-mode: normal !important;
}

.pdfViewer svg.pdf-markup-subtype-draw-visual {
    mix-blend-mode: normal;
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
