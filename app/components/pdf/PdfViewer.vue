<template>
    <div
        ref="viewerHost"
        class="relative h-full w-full"
        :class="{ 'pdf-viewer-container--dark': invertColors }"
    >
        <div v-if="isLocalViewerLoadingOverlayVisible" class="absolute inset-0 z-[1] flex items-center justify-center bg-[var(--ui-bg-muted)]">
            <div class="flex flex-col items-center gap-2">
                <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin text-[var(--ui-text-muted)]" />
                <span class="text-sm text-[var(--ui-text-muted)]">{{ t('common.loading') }}</span>
            </div>
        </div>
        <PdfViewerViewport
            :set-viewer-container="handleViewerContainerRef"
            :viewer-class="viewerClass"
            :container-style="containerStyle"
            :pages-to-render="pagesToRender"
            :should-show-skeleton="shouldShowSkeleton"
            :is-spread-single="isSpreadSingle"
            :get-page-placeholder-style="getPagePlaceholderStyle"
            :top-virtual-spacer-style="topVirtualSpacerStyle"
            :bottom-virtual-spacer-style="bottomVirtualSpacerStyle"
            :pending-image-placement="pendingImagePlacement"
            :is-pending-image-placement-finalizing="isPendingImagePlacementFinalizing"
            @scroll="handleViewerScroll"
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
            :markers-by-page="markersByPage"
            :links-by-page="linksByPage"
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
import {
    collectEmbeddedShapeAnnotationIds,
    importEmbeddedShapeAnnotations,
} from '@app/composables/pdf/pdfEmbeddedShapeAnnotations';
import {
    refreshDeletedEmbeddedShapePage,
    rerenderRenderedManagedEmbeddedShapePages,
    shouldRefreshManagedShapePage,
} from '@app/composables/pdf/pdfEmbeddedShapeRefresh';
import {
    cloneShapePoints,
    cloneShapeStrokes,
} from '@app/composables/pdf/pdfShapeStrokes';
import { resolveEmbeddedShapeImportLoadPolicy } from '@app/composables/pdf/pdfEmbeddedShapeImportPolicy';
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
import { usePdfShapeContext } from '@app/composables/pdf/usePdfShapeContext';
import { usePdfRegionSnip } from '@app/composables/pdf/usePdfRegionSnip';
import { usePdfCropSelection } from '@app/composables/pdf/usePdfCropSelection';
import {
    captureScrollSnapshot,
    restoreScrollFromSnapshot,
} from '@app/composables/pdf/pdfPageRenderPipeline';
import { savePdfDocumentWithCommittedEditors } from '@app/composables/pdf/pdfSaveDocument';
import { normalizePdfJsAnnotationId } from '@app/composables/pdf/pdfSerializationRefs';
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
import type { IPdfPlacedImageFinalizePayload } from '@app/types/pdf-image-placement';
import type { IAnnotationContextMenuPayload } from '@app/composables/pdf/annotationContextMenu';
import {
    isSelectionInteractionTool,
    isSelectionMarkupTool,
} from '@app/composables/pdf/annotations/annotationRules';
import { logPdfNav } from '@app/utils/pdf-nav-log';
import { BrowserLogger } from '@app/utils/browser-logger';
import { readDocumentBytes } from '@app/utils/document-bytes';
import { runGuardedTask } from '@app/utils/async-guard';

import '@app/assets/css/vendor/pdfjs-viewer-sanitized.css';

interface IProps {
    src: TPdfSource | null;
    sourcePdfData?: Uint8Array | null;
    suppressLoadingOverlay?: boolean;
    bufferPages?: number;
    isAnySaving?: boolean;
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

interface IViewportPagePin {
    page: number;
    untilMs: number;
    reason: string;
}

interface IViewerLoadSettleState {
    token: number;
    promise: Promise<void>;
    resolve: () => void;
    settled: boolean;
}

const props = defineProps<IProps>();

const src = computed(() => props.src);
const sourcePdfData = computed(() => props.sourcePdfData ?? null);
const suppressLoadingOverlay = computed(() => props.suppressLoadingOverlay === true);
const bufferPages = computed(() => props.bufferPages ?? 2);
const isAnySaving = computed(() => props.isAnySaving ?? false);
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
const resizeTransitionAnchorPage = ref<number | null>(null);
const annotationUiManager = shallowRef<AnnotationEditorUIManager | null>(null);
const annotationL10n = shallowRef<GenericL10n | null>(null);
const annotationCommentsCache = shallowRef<IAnnotationCommentSummary[]>([]);
const pendingMarkerMoves = new Map<string, IAnnotationMarkerRect>();
const activeCommentStableKey = ref<string | null>(null);
const PDF_VIEWER_LOADER_ICON_SIZE_PX = 20;
const zoomVirtualizationFreeze = ref<IZoomVirtualizationFreeze | null>(null);
const viewportPagePin = ref<IViewportPagePin | null>(null);
let viewportPagePinTimer: ReturnType<typeof setTimeout> | null = null;
let viewerLoadSettleState: IViewerLoadSettleState = {
    token: 0,
    promise: Promise.resolve(),
    resolve: () => {},
    settled: true,
};
const regionSnip = usePdfRegionSnip({ viewerContainer });
const cropSelection = usePdfCropSelection({ viewerContainer });

function beginViewerLoadSettle(token: number) {
    if (!viewerLoadSettleState.settled) {
        viewerLoadSettleState.resolve();
    }

    let resolvePromise = () => {};
    const promise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
    });
    viewerLoadSettleState = {
        token,
        promise,
        resolve: resolvePromise,
        settled: false,
    };
}

function settleViewerLoadSettle(token: number) {
    if (viewerLoadSettleState.token !== token || viewerLoadSettleState.settled) {
        return;
    }

    viewerLoadSettleState.settled = true;
    viewerLoadSettleState.resolve();
}

function waitForViewerLoadSettled() {
    return viewerLoadSettleState.promise;
}

function settleViewerLoadSettledWithManagedShapes(token: number) {
    const loadPolicy = resolveEmbeddedShapeImportLoadPolicy(
        sourcePdfData.value,
        workingCopyPath.value,
    );
    if (loadPolicy.deferUntilAfterInitialRender) {
        BrowserLogger.debug('pdf-shapes', 'Deferring managed shape import until after initial PDF render', {
            token,
            path: workingCopyPath.value,
        });
        runGuardedTask(() => ensureEmbeddedShapesImportedForCurrentSource(), {
            scope: 'pdf-shapes',
            message: 'Failed to import managed shapes after initial PDF render',
        });
        settleViewerLoadSettle(token);
        return;
    }

    runGuardedTask(async () => {
        try {
            await ensureEmbeddedShapesImportedForCurrentSource();
        } catch (error) {
            BrowserLogger.warn('pdf-shapes', 'Managed shape import did not settle before viewer load completion', error);
        } finally {
            settleViewerLoadSettle(token);
        }
    }, {
        scope: 'pdf-shapes',
        message: 'Failed to settle managed shapes after PDF load',
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

const {
    currentPage,
    visibleRange,
    getMostVisiblePage,
    scrollToPage: scrollToPageInternal,
    updateCurrentPage,
    updateVisibleRange,
    setPageLayoutMetrics,
} = usePdfScroll({ getPinnedMostVisiblePage: () => getPinnedViewportPage() });

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

function clearPinnedViewportPage(reason = 'cleared') {
    if (viewportPagePinTimer !== null) {
        clearTimeout(viewportPagePinTimer);
        viewportPagePinTimer = null;
    }

    const existingPin = viewportPagePin.value;
    if (!existingPin) {
        return;
    }

    viewportPagePin.value = null;
    BrowserLogger.warn('pdf-nav', `[viewer-page-pin] cleared page=${existingPin.page} reason=${reason}`, {
        page: existingPin.page,
        pinReason: existingPin.reason,
        clearReason: reason,
        viewer: summarizeViewerStateForLog(),
    });
}

function getPinnedViewportPage() {
    const existingPin = viewportPagePin.value;
    if (!existingPin) {
        return null;
    }

    if (Date.now() > existingPin.untilMs) {
        clearPinnedViewportPage('expired-read');
        return null;
    }

    return existingPin.page;
}

function pinCurrentPageDuringRecovery(
    page: number,
    options?: {
        durationMs?: number;
        reason?: string;
    },
) {
    const normalizedPage = Math.max(1, Math.floor(page));
    const durationMs = Math.max(120, options?.durationMs ?? 900);
    const reason = options?.reason ?? 'reload-recovery';

    if (viewportPagePinTimer !== null) {
        clearTimeout(viewportPagePinTimer);
    }

    viewportPagePin.value = {
        page: normalizedPage,
        untilMs: Date.now() + durationMs,
        reason,
    };
    viewportPagePinTimer = setTimeout(() => {
        clearPinnedViewportPage('expired-timer');
    }, durationMs);

    BrowserLogger.warn('pdf-nav', `[viewer-page-pin] pinned page=${normalizedPage} reason=${reason}`, {
        page: normalizedPage,
        durationMs,
        reason,
        viewer: summarizeViewerStateForLog(),
    });
}

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
        currentPage: currentPage.value,
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
    containerStyle,
    scaledMargin,
    computeFitWidthScale,
    effectiveScale,
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
    currentPage,
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
    computeSkeletonInsets,
    resetInsets,
} = usePdfSkeletonInsets(basePageWidth, basePageHeight, effectiveScale);

const shapeComposable = useAnnotationShapes();
let embeddedShapeImportToken = 0;
let pendingEmbeddedShapeImportData: Uint8Array | null = null;
let pendingEmbeddedShapeImportPath: string | null = null;
let embeddedShapeImportPromise: Promise<void> = Promise.resolve();
let lastEmbeddedShapeImportPath: string | null = null;
let hasEmbeddedShapeImportBaseline = false;
let shouldReplaceManagedShapesOnNextImport = false;
let pageRenderStallRecoveryHandler: ((payload: IPageRenderStallPayload) => void) | null = null;
const pendingDeletedEmbeddedShapeRefreshPages = new Set<number>();
let isDeletedEmbeddedShapeRefreshScheduled = false;

function adoptPersistedManagedShapesOnNextImport() {
    shouldReplaceManagedShapesOnNextImport = true;
}

function clearPendingManagedShapeImportAdoption() {
    shouldReplaceManagedShapesOnNextImport = false;
}

const managedEmbeddedAnnotationIds = computed(() =>
    collectEmbeddedShapeAnnotationIds(shapeComposable.getAllShapes()),
);

const hiddenEmbeddedAnnotationIds = computed(() => {
    const ids = new Set(managedEmbeddedAnnotationIds.value);
    shapeComposable.deletedEmbeddedAnnotationIds.value.forEach((id) => {
        const normalizedId = normalizePdfJsAnnotationId(id);
        if (normalizedId) {
            ids.add(normalizedId);
        }
    });
    return ids;
});

function syncHiddenEmbeddedAnnotationDom() {
    const container = viewerContainer.value;
    if (!container) {
        return;
    }

    const hiddenIds = hiddenEmbeddedAnnotationIds.value;
    container.querySelectorAll<HTMLElement>('[data-annotation-id]').forEach((element) => {
        const annotationId = normalizePdfJsAnnotationId(element.dataset.annotationId);
        if (!annotationId || !hiddenIds.has(annotationId)) {
            return;
        }

        element.remove();
    });
}

function hasRenderedViewerCanvas() {
    return Boolean(
        viewerContainer.value?.querySelector('.page_container--rendered .page_canvas canvas'),
    );
}

function hasRenderedCanvasOnPage(pageNumber: number) {
    return Boolean(
        viewerContainer.value?.querySelector(
            `.page_container[data-page="${pageNumber}"] .page_canvas canvas`,
        ),
    );
}

function importEmbeddedShapesForSource(
    data: Uint8Array | null,
    path: string | null,
) {
    pendingEmbeddedShapeImportData = data;
    pendingEmbeddedShapeImportPath = path;
    const localToken = ++embeddedShapeImportToken;

    embeddedShapeImportPromise = (async () => {
        BrowserLogger.debug('pdf-shapes', 'Importing embedded shapes for source', () => ({
            path,
            hasData: Boolean(data),
            dataBytes: data?.byteLength ?? 0,
            token: localToken,
            lastEmbeddedShapeImportPath,
            hasEmbeddedShapeImportBaseline,
            currentShapeCount: shapeComposable.getAllShapes().length,
        }));
        if ((!data || data.length === 0) && !path) {
            lastEmbeddedShapeImportPath = null;
            hasEmbeddedShapeImportBaseline = false;
            shapeComposable.replaceShapes([]);
            await nextTick();
            syncHiddenEmbeddedAnnotationDom();
            return;
        }

        let importedShapes: IShapeAnnotation[] = [];
        let sourceData = data;
        try {
            if ((!sourceData || sourceData.length === 0) && path) {
                sourceData = await readDocumentBytes(path);
            }

            if (!sourceData || sourceData.length === 0) {
                lastEmbeddedShapeImportPath = null;
                hasEmbeddedShapeImportBaseline = false;
                shapeComposable.replaceShapes([]);
                await nextTick();
                syncHiddenEmbeddedAnnotationDom();
                return;
            }

            importedShapes = await importEmbeddedShapeAnnotations(sourceData);
        } catch (error) {
            BrowserLogger.warn('pdf-shapes', 'Failed to import embedded PDF shapes', error);
            return;
        }

        if (
            embeddedShapeImportToken !== localToken
            || workingCopyPath.value !== path
        ) {
            BrowserLogger.debug('pdf-shapes', 'Skipped stale embedded shape import result', () => ({
                path,
                token: localToken,
                currentToken: embeddedShapeImportToken,
                samePath: workingCopyPath.value === path,
            }));
            return;
        }

        const shouldReconcileWithExistingShapes = (
            !shouldReplaceManagedShapesOnNextImport
            && (
                hasEmbeddedShapeImportBaseline
                && path === lastEmbeddedShapeImportPath
                && shapeComposable.hasShapes.value
            )
        );

        BrowserLogger.debug('pdf-shapes', 'Embedded shape import finished', () => ({
            path,
            token: localToken,
            importedShapeCount: importedShapes.length,
            importMode: shouldReconcileWithExistingShapes ? 'reconcile' : 'replace',
            shouldReconcileWithExistingShapes,
            currentShapeCountBeforeApply: shapeComposable.getAllShapes().length,
        }));

        if (shouldReconcileWithExistingShapes) {
            shapeComposable.reconcilePersistedShapes(importedShapes);
        } else {
            shapeComposable.replaceShapes(importedShapes);
        }

        shouldReplaceManagedShapesOnNextImport = false;
        hasEmbeddedShapeImportBaseline = true;
        lastEmbeddedShapeImportPath = path ?? null;

        await nextTick();
        syncHiddenEmbeddedAnnotationDom();

        // If the viewer has already painted before the managed embedded shapes
        // finished importing, do one corrective rerender. The normal path now
        // waits for this import before the first page render, so this is a
        // fallback rather than the primary behavior.
        if (!hasRenderedViewerCanvas()) {
            return;
        }

        await rerenderRenderedManagedEmbeddedShapePages({
            shapes: shapeComposable.getAllShapes(),
            visibleRange: visibleRange.value,
            renderBuffer: bufferPages.value,
            isPageRendered,
            invalidatePages: invalidateRenderedPages,
            renderVisiblePages,
        });
    })();

    return embeddedShapeImportPromise;
}

function ensureEmbeddedShapesImportedForCurrentSource() {
    const data = sourcePdfData.value;
    const path = workingCopyPath.value;
    if (pendingEmbeddedShapeImportData !== data || pendingEmbeddedShapeImportPath !== path) {
        return importEmbeddedShapesForSource(data, path);
    }
    return embeddedShapeImportPromise;
}

async function clearManagedShapesForDeferredImport() {
    shouldReplaceManagedShapesOnNextImport = false;
    lastEmbeddedShapeImportPath = null;
    hasEmbeddedShapeImportBaseline = false;
    shapeComposable.replaceShapes([]);
    await nextTick();
    syncHiddenEmbeddedAnnotationDom();
}

async function preparePersistedManagedShapesForSave(data: Uint8Array) {
    const snapshot = shapeComposable.captureShapeStateSnapshot();

    try {
        const importedShapes = await importEmbeddedShapeAnnotations(data);
        shapeComposable.primePersistedShapes(importedShapes);
        await nextTick();
        syncHiddenEmbeddedAnnotationDom();

        BrowserLogger.debug('pdf-shapes', 'Prepared managed shapes from saved PDF bytes before persistence', () => ({
            importedShapeCount: importedShapes.length,
            currentShapeCount: shapeComposable.getAllShapes().length,
        }));

        return snapshot;
    } catch (error) {
        BrowserLogger.warn('pdf-shapes', 'Failed to prepare managed shapes from saved PDF bytes', error);
        return null;
    }
}

async function restorePreparedManagedShapesAfterFailedSave(snapshot: unknown) {
    if (!snapshot || typeof snapshot !== 'object') {
        return;
    }

    shapeComposable.restoreShapeStateSnapshot(snapshot as ReturnType<typeof shapeComposable.captureShapeStateSnapshot>);
    await nextTick();
    syncHiddenEmbeddedAnnotationDom();
}

async function flushDeletedEmbeddedShapePageRefresh() {
    if (isDeletedEmbeddedShapeRefreshScheduled) {
        return;
    }

    isDeletedEmbeddedShapeRefreshScheduled = true;

    try {
        await nextTick();

        while (pendingDeletedEmbeddedShapeRefreshPages.size > 0) {
            const pageNumbers = Array.from(pendingDeletedEmbeddedShapeRefreshPages)
                .sort((left, right) => left - right);
            pendingDeletedEmbeddedShapeRefreshPages.clear();

            const pagesToRefresh = pageNumbers.filter(pageNumber => shouldRefreshManagedShapePage({
                pageNumber,
                visibleRange: visibleRange.value,
                renderBuffer: bufferPages.value,
                isPageRendered,
                hasRenderedCanvasDom: hasRenderedCanvasOnPage,
            }));
            if (pagesToRefresh.length === 0) {
                continue;
            }

            invalidateRenderedPages(pagesToRefresh);
            await renderVisiblePages(
                {
                    start: pagesToRefresh[0]!,
                    end: pagesToRefresh[pagesToRefresh.length - 1]!,
                },
                {
                    preserveRenderedPages: true,
                    forceRerender: true,
                    bufferOverride: 0,
                },
            );
        }
    } finally {
        isDeletedEmbeddedShapeRefreshScheduled = false;

        if (pendingDeletedEmbeddedShapeRefreshPages.size > 0) {
            runGuardedTask(() => flushDeletedEmbeddedShapePageRefresh(), {
                scope: 'pdf-shapes',
                message: 'Failed to refresh deleted embedded shape pages',
            });
        }
    }
}

function queueDeletedEmbeddedShapePageRefresh(pageNumber: number) {
    if (!Number.isFinite(pageNumber) || pageNumber < 1) {
        return;
    }

    pendingDeletedEmbeddedShapeRefreshPages.add(Math.floor(pageNumber));
    runGuardedTask(() => flushDeletedEmbeddedShapePageRefresh(), {
        scope: 'pdf-shapes',
        message: 'Failed to refresh deleted embedded shape pages',
    });
}

function refreshDeletedEmbeddedShape(shape: IShapeAnnotation | null) {
    BrowserLogger.debug('pdf-shapes', 'Refreshing deleted embedded shape page', () => ({
        shapeId: shape?.id ?? null,
        source: shape?.source ?? null,
        annotationId: shape?.annotationId ?? null,
        stableKey: shape?.stableKey ?? null,
        pageIndex: shape?.pageIndex ?? null,
        deletedAnnotationIds: shapeComposable.getDeletedEmbeddedAnnotationIds(),
        deletedStableKeys: shapeComposable.getDeletedEmbeddedShapeStableKeys(),
    }));
    refreshDeletedEmbeddedShapePage({
        shape,
        viewerContainer: viewerContainer.value,
        syncHiddenEmbeddedAnnotationDom,
        rerenderEmbeddedShapePage: queueDeletedEmbeddedShapePageRefresh,
    });
}

watch(hiddenEmbeddedAnnotationIds, () => {
    void nextTick().then(() => {
        syncHiddenEmbeddedAnnotationDom();
        hideManagedAnnotationEditors();
    });
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

function cloneShape(shape: IShapeAnnotation): IShapeAnnotation {
    return {
        ...shape,
        points: cloneShapePoints(shape.points),
        strokes: cloneShapeStrokes(shape.strokes),
    };
}

function applyShapeUpdateWithHistory(previousShape: IShapeAnnotation, nextShape: IShapeAnnotation) {
    const hasChanges = JSON.stringify(cloneShape(previousShape)) !== JSON.stringify(cloneShape(nextShape));
    if (!hasChanges) {
        return;
    }

    emit('annotation-modified');

    registerShapeHistoryCommand({
        cmd: () => {
            shapeComposable.updateShape(nextShape.id, nextShape);
            shapeComposable.selectShape(nextShape.id);
            emit('annotation-modified');
        },
        undo: () => {
            shapeComposable.updateShape(previousShape.id, previousShape);
            shapeComposable.selectShape(previousShape.id);
            emit('annotation-modified');
        },
    });
}

function handleShapeCreated(shape: IShapeAnnotation) {
    emit('annotation-modified');

    registerShapeHistoryCommand({
        cmd: () => {
            shapeComposable.addShape(shape);
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
    onShapeUpdated: applyShapeUpdateWithHistory,
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
    hideManagedAnnotationEditors,
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
    workingCopyPath,
    onRenderStall: relayPageRenderStall,
    onPageRendered: (pageNumber) => {
        syncHiddenEmbeddedAnnotationDom();
        hideManagedAnnotationEditors(pageNumber);
    },
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

watch(
    () => [
        sourcePdfData.value,
        workingCopyPath.value,
    ] as const,
    async ([
        data,
        path,
    ]) => {
        const loadPolicy = resolveEmbeddedShapeImportLoadPolicy(data, path);
        if (loadPolicy.deferUntilAfterInitialRender) {
            BrowserLogger.debug('pdf-shapes', 'Queued managed shape import for deferred path-backed source', {
                path,
                lastImportedPath: lastEmbeddedShapeImportPath,
                hasBaseline: hasEmbeddedShapeImportBaseline,
            });
            if (path !== lastEmbeddedShapeImportPath || !hasEmbeddedShapeImportBaseline) {
                await clearManagedShapesForDeferredImport();
            }
            return;
        }

        await importEmbeddedShapesForSource(data, path);
    },
    { immediate: true },
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
    currentPage,
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
    currentPage,
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
    isAnySaving,
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
    invalidateScaleCache,
    resetScale,
    computeSkeletonInsets,
    beforeInitialRender: () => {
        const loadPolicy = resolveEmbeddedShapeImportLoadPolicy(
            sourcePdfData.value,
            workingCopyPath.value,
        );
        if (!loadPolicy.awaitBeforeInitialRender) {
            return Promise.resolve();
        }

        // Path-backed large PDFs can spend seconds re-reading and re-parsing
        // the whole file for embedded managed shapes. Defer that work until
        // after the first page paints so open latency stays dominated by the
        // actual document load instead of a secondary pdf-lib scan.
        return ensureEmbeddedShapesImportedForCurrentSource();
    },
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
            beginViewerLoadSettle(payload.token);
            return;
        }
        settleViewerLoadSettledWithManagedShapes(payload.token);
    },
    emit,
});
pageRenderStallRecoveryHandler = handlePageRenderStallFromCore;

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
const isLocalViewerLoadingOverlayVisible = computed(() => (
    isViewerLoadingOverlayVisible.value && !suppressLoadingOverlay.value
));

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
    'pdfViewer--hidden': isLocalViewerLoadingOverlayVisible.value,
    'pdfViewer--fit-height': fitMode.value === 'height',
    'pdfViewer--resize-transition': resizeTransitionVisible.value,
    'pdfViewer--zoom-snap-suppressed': zoomSnapSuppressed.value,
}));

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

async function saveViewerDocument() {
    return savePdfDocumentWithCommittedEditors({
        pdfDocument: pdfDocument.value,
        annotationUiManager: annotationUiManager.value,
    });
}

function getSelectedShape(): IShapeAnnotation | null {
    const id = shapeComposable.selectedShapeId.value;
    if (!id) {
        return null;
    }
    return shapeComposable.getShapeById(id);
}

function clearSelectedShape() {
    shapeComposable.selectShape(null);
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

    const nextShape: IShapeAnnotation = cloneShape({
        ...previousShape,
        ...updates,
    });

    shapeComposable.updateShape(id, updates);
    applyShapeUpdateWithHistory(cloneShape(previousShape), nextShape);
}

function deleteSelectedShape() {
    if (isAnySaving.value) {
        BrowserLogger.debug('pdf-shapes', 'Ignoring delete while save is in flight');
        return;
    }

    const id = shapeComposable.selectedShapeId.value;
    if (!id) {
        return;
    }

    const deletedShape = shapeComposable.getShapeById(id);
    if (!deletedShape) {
        return;
    }

    BrowserLogger.debug('pdf-shapes', 'Deleting selected shape from viewer', () => ({
        id,
        source: deletedShape.source,
        annotationId: deletedShape.annotationId ?? null,
        stableKey: deletedShape.stableKey ?? null,
        color: deletedShape.color,
        hasShapes: shapeComposable.hasShapes.value,
    }));

    shapeComposable.deleteShape(id);
    refreshDeletedEmbeddedShape(deletedShape);
    emit('annotation-modified');

    registerShapeHistoryCommand({
        cmd: () => {
            shapeComposable.deleteShape(id);
            refreshDeletedEmbeddedShape(deletedShape);
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
    ensurePageMetricsInRange: pdfDocumentResult.ensurePageMetricsInRange,
    getPageMetricsSnapshot: () => pageMetrics.value.map(metric => ({ ...metric })),
    waitForViewerLoadSettled,
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
    focusAnnotationComment: commentCrud.focusAnnotationComment,
    updateAnnotationComment: commentCrud.updateAnnotationComment,
    deleteAnnotationComment: commentCrud.deleteAnnotationComment,
    getMarkupSubtypeOverrides: annotations.editor.getMarkupSubtypeOverrides,
    getAllShapes: shapeComposable.getAllShapes,
    getDeletedEmbeddedShapeAnnotationIds: shapeComposable.getDeletedEmbeddedAnnotationIds,
    getDeletedEmbeddedShapeStableKeys: shapeComposable.getDeletedEmbeddedShapeStableKeys,
    loadShapes: shapeComposable.loadShapes,
    clearShapes: shapeComposable.clearShapes,
    clearSelectedShape,
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
    suppressAnnotationStableKey: annotations.commentSync.suppressAnnotationStableKey,
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

.pdfViewer.pdfViewer--mode-facing .pdf-viewer-virtual-spacer,
.pdfViewer.pdfViewer--mode-facing-first-single .pdf-viewer-virtual-spacer {
    grid-column: 1 / -1;
    justify-self: stretch;
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
