<template>
    <div
        ref="pageContainer"
        class="page_container"
        :class="{
            'page_container--spread-single': spreadSingle,
            'page_container--buffered': buffered,
            'page_container--rendered': rendered,
        }"
        :data-page="page"
        :data-document-page-number="page"
        :data-page-visual="pageVisualState"
        :style="placeholderStyle ?? undefined"
    >
        <div class="page_canvas">
            <div
                class="page_canvas__render-layer canvasWrapper"
                :class="{'document-page-visual--committed': rendered}"
            ></div>
            <DocumentPageSkeleton
                v-if="showPageSkeleton && !rendered && !renderFailed"
                :padding="pageSkeletonPadding"
                :content-height="pageSkeletonContentHeight"
            />
            <div
                v-else-if="renderFailed"
                class="pdf-page-render-error"
                role="alert"
            >
                {{ renderErrorLabel }}
            </div>
        </div>
        <div class="text-layer textLayer"></div>
        <div class="annotation-layer annotationLayer"></div>
        <div class="annotation-editor-layer annotationEditorLayer"></div>
        <PdfImagePlacementOverlay
            :placement="placedImage"
            :busy="placedImageBusy"
            @update-rect="emit('update-placed-image-rect', $event)"
            @finalize="emit('finalize-placed-image')"
            @cancel="emit('cancel-placed-image')"
        />
        <PdfShapeOverlay
            v-if="shapeContext && showShapeOverlay"
            :shapes="pageShapes"
            :drawing-shape="pageDrawingShape"
            :selected-shape-id="shapeContext.selectedShapeId.value"
            :focused-shape-id="shapeContext.focusedShapeId.value"
            :is-active="shapeContext.isShapeToolActive.value"
            :is-annotation-tool-active="shapeContext.isAnyAnnotationToolActive.value"
            :selection-enabled="shapeContext.isSelectionToolActive.value"
            :tool="shapeContext.activeShapeTool.value"
            @start-drawing="startDrawingShape"
            @continue-drawing="continueDrawingShape"
            @finish-drawing="finishDrawingShape"
            @start-drag-shape="startDraggingShape"
            @continue-drag-shape="continueDraggingShape"
            @finish-drag-shape="finishDraggingShape"
            @start-resize-shape="startResizingShape"
            @continue-resize-shape="continueResizingShape"
            @finish-resize-shape="finishResizingShape"
            @select-shape="selectShape"
            @shape-contextmenu="openShapeContextMenu"
        />
    </div>
</template>

<script setup lang="ts">

import DocumentPageSkeleton from '@app/components/document-viewer/DocumentPageSkeleton.vue';
import PdfImagePlacementOverlay from '@app/modules/pdf-viewer/components/PdfImagePlacementOverlay.vue';
import PdfShapeOverlay from '@app/modules/pdf-viewer/components/PdfShapeOverlay.vue';
import { clearPdfSelectionForLayerTeardown } from '@app/modules/pdf-viewer/engine/pdf-selection-cleanup/clearPdfSelectionForLayerTeardown';
import { shouldShowShapeOverlay } from '@app/modules/pdf-viewer/engine/pdf-shape-overlay-visibility/shouldShowShapeOverlay';
import { usePdfSkeletonContext } from '@app/modules/pdf-viewer/runtime/skeleton/usePdfSkeletonInsets';
import type { IShapeContextProvide } from '@app/modules/pdf-viewer/tools/useAnnotationShapes';
import type {
    IShapePoint,
    TShapeResizeHandle,
} from '@app/types/annotations';
import type {
    IPdfImagePlacementDraft,
    IPdfImagePlacementRectUpdate,
} from '@app/types/pdfImagePlacement';

interface IProps {
    page: number;
    showSkeleton: boolean;
    renderFailed?: boolean;
    renderErrorLabel?: string;
    spreadSingle?: boolean;
    buffered?: boolean;
    rendered?: boolean;
    shapeOverlayVisualReady?: boolean;
    placeholderStyle?: Record<string, string> | null;
    placedImage?: IPdfImagePlacementDraft | null;
    placedImageBusy?: boolean;
}

const {
    page,
    showSkeleton,
    renderFailed = false,
    renderErrorLabel = '',
    spreadSingle = false,
    buffered = false,
    rendered = false,
    shapeOverlayVisualReady = false,
    placeholderStyle = null,
    placedImage = null,
    placedImageBusy = false,
} = defineProps<IProps>();
const emit = defineEmits<{
    'page-container-mounted': [page: number];
    'page-container-unmounted': [page: number];
    'update-placed-image-rect': [payload: IPdfImagePlacementRectUpdate];
    'finalize-placed-image': [];
    'cancel-placed-image': [];
}>();
const pageContainer = ref<HTMLElement | null>(null);

const {
    scaledSkeletonPadding,
    scaledPageHeight,
} = usePdfSkeletonContext();
const fallbackSkeletonPadding = Object.freeze({
    top: 56,
    right: 56,
    bottom: 56,
    left: 56,
});
const pageSkeletonPadding = computed(() => scaledSkeletonPadding.value ?? fallbackSkeletonPadding);
const pageSkeletonContentHeight = computed(() => scaledPageHeight.value ?? 760);

const shapeContext = inject<IShapeContextProvide | null>('shapeContext', null);

const pageShapes = computed(() => shapeContext?.getShapesForPage(page - 1) ?? []);
const showPageSkeleton = computed(() => showSkeleton);
const pageVisualState = computed(() => rendered ? 'ready' : 'none');
const isPageVisualReadyForShapeOverlay = computed(() => shapeOverlayVisualReady);

const pageDrawingShape = computed(() => {
    const drawing = shapeContext?.drawingShape.value;
    if (!drawing || drawing.pageIndex !== page - 1) {
        return null;
    }
    return drawing;
});
const showShapeOverlay = computed(() => Boolean(
    shapeContext
    && shouldShowShapeOverlay({
        hasDrawingShape: Boolean(pageDrawingShape.value),
        hasPageShapes: pageShapes.value.length > 0,
        isPageVisualReady: isPageVisualReadyForShapeOverlay.value,
        isShapeToolActive: shapeContext.isShapeToolActive.value,
    }),
));

function startDrawingShape(coords: IShapePoint) {
    shapeContext?.handleStartDrawing(page - 1, coords);
}

function continueDrawingShape(coords: IShapePoint) {
    shapeContext?.handleContinueDrawing(coords);
}

function finishDrawingShape() {
    shapeContext?.handleFinishDrawing();
}

function startDraggingShape(payload: IShapePoint & { shapeId: string }) {
    shapeContext?.handleStartDraggingShape(payload.shapeId, payload);
}

function continueDraggingShape(coords: IShapePoint) {
    shapeContext?.handleContinueDraggingShape(coords);
}

function finishDraggingShape() {
    shapeContext?.handleFinishDraggingShape();
}

function startResizingShape(payload: IShapePoint & {
    shapeId: string;
    handle: TShapeResizeHandle;
}) {
    shapeContext?.handleStartResizingShape(payload.shapeId, payload.handle, payload);
}

function continueResizingShape(coords: IShapePoint) {
    shapeContext?.handleContinueResizingShape(coords);
}

function finishResizingShape() {
    shapeContext?.handleFinishResizingShape();
}

function selectShape(id: string | null) {
    shapeContext?.handleSelectShape(id);
}

function openShapeContextMenu(payload: {
    shapeId: string;
    clientX: number;
    clientY: number;
}) {
    shapeContext?.handleShapeContextMenu(payload);
}

onMounted(() => {
    emit('page-container-mounted', page);
});

onBeforeUnmount(() => {
    clearPdfSelectionForLayerTeardown({ target: pageContainer.value });
    emit('page-container-unmounted', page);
});
</script>
