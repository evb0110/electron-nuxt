<template>
    <div
        class="page_container"
        :class="{ 'page_container--spread-single': spreadSingle }"
        :data-page="page"
        :style="placeholderStyle ?? undefined"
    >
        <div class="page_canvas canvasWrapper"></div>
        <div class="text-layer textLayer"></div>
        <div class="annotation-layer annotationLayer"></div>
        <div class="annotation-editor-layer annotationEditorLayer"></div>
        <PdfImagePlacementOverlay
            :placement="placedImage"
            :busy="placedImageBusy"
            @update-rect="updatePlacedImageRect"
            @finalize="finalizePlacedImage"
            @cancel="cancelPlacedImage"
        />
        <PdfShapeOverlay
            v-if="shapeContext"
            :page-index="page - 1"
            :shapes="pageShapes"
            :drawing-shape="pageDrawingShape"
            :selected-shape-id="shapeContext.selectedShapeId.value"
            :is-active="shapeContext.isShapeToolActive.value"
            :is-annotation-tool-active="shapeContext.isAnyAnnotationToolActive.value"
            :selection-enabled="shapeContext.isSelectionToolActive.value"
            :tool="shapeContext.activeShapeTool.value"
            :settings="shapeContext.settings.value"
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
        <PdfPageSkeleton
            v-if="showSkeleton"
            :padding="scaledSkeletonPadding"
            :content-height="scaledPageHeight"
        />
    </div>
</template>

<script setup lang="ts">

import PdfPageSkeleton from '@app/components/pdf/PdfPageSkeleton.vue';
import PdfImagePlacementOverlay from '@app/components/pdf/PdfImagePlacementOverlay.vue';
import PdfShapeOverlay from '@app/components/pdf/PdfShapeOverlay.vue';
import { usePdfSkeletonContext } from '@app/composables/pdf/usePdfSkeletonInsets';
import type { IShapeContextProvide } from '@app/composables/pdf/useAnnotationShapes';
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
    spreadSingle?: boolean;
    placeholderStyle?: Record<string, string> | null;
    placedImage?: IPdfImagePlacementDraft | null;
    placedImageBusy?: boolean;
}

const {
    page,
    showSkeleton,
    spreadSingle = false,
    placeholderStyle = null,
    placedImage = null,
    placedImageBusy = false,
} = defineProps<IProps>();
const emit = defineEmits<{
    'update-placed-image-rect': [payload: IPdfImagePlacementRectUpdate];
    'finalize-placed-image': [];
    'cancel-placed-image': [];
}>();

function updatePlacedImageRect(payload: IPdfImagePlacementRectUpdate) {
    emit('update-placed-image-rect', payload);
}

function finalizePlacedImage() {
    emit('finalize-placed-image');
}

function cancelPlacedImage() {
    emit('cancel-placed-image');
}

const {
    scaledSkeletonPadding,
    scaledPageHeight,
} = usePdfSkeletonContext();

const shapeContext = inject<IShapeContextProvide | null>('shapeContext', null);

const pageShapes = computed(() => shapeContext?.getShapesForPage(page - 1) ?? []);

const pageDrawingShape = computed(() => {
    const drawing = shapeContext?.drawingShape.value;
    if (!drawing || drawing.pageIndex !== page - 1) {
        return null;
    }
    return drawing;
});

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
</script>
