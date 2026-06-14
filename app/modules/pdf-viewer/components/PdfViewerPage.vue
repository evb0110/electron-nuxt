<template>
    <div
        ref="pageContainer"
        class="page_container"
        :class="{
            'page_container--spread-single': spreadSingle,
            'page_container--buffered': buffered,
            'page_container--rendered': rendered,
            'page_container--has-preview': showPreview,
            'page_container--preview-drawn': isPreviewDrawn,
            'page_container--navigation-held': navigationHeld,
        }"
        :data-page="page"
        :style="[placeholderStyle ?? undefined, navigationHoldStyle ?? undefined]"
    >
        <div
            v-show="showPreview"
            class="page_preview"
        >
            <canvas
                ref="previewCanvas"
                :data-preview-id="preview?.id ?? undefined"
            ></canvas>
        </div>
        <div class="page_canvas canvasWrapper"></div>
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
        <PdfPageSkeleton
            v-if="showPageSkeleton"
            :padding="scaledSkeletonPadding"
            :content-height="scaledPageHeight"
        />
    </div>
</template>

<script setup lang="ts">

import PdfPageSkeleton from '@app/modules/pdf-viewer/components/PdfPageSkeleton.vue';
import PdfImagePlacementOverlay from '@app/modules/pdf-viewer/components/PdfImagePlacementOverlay.vue';
import PdfShapeOverlay from '@app/modules/pdf-viewer/components/PdfShapeOverlay.vue';
import { clearPdfSelectionForLayerTeardown } from '@app/modules/pdf-viewer/engine/pdf-selection-cleanup/clearPdfSelectionForLayerTeardown';
import { shouldShowShapeOverlay } from '@app/modules/pdf-viewer/engine/pdf-shape-overlay-visibility/shouldShowShapeOverlay';
import { usePdfSkeletonContext } from '@app/modules/pdf-viewer/runtime/skeleton/usePdfSkeletonInsets';
import type { IPdfPagePreviewEntry } from '@app/modules/pdf-viewer/engine/pdf-page-preview/pdfPagePreviewTypes';
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
    spreadSingle?: boolean;
    buffered?: boolean;
    rendered?: boolean;
    preview?: IPdfPagePreviewEntry | null;
    navigationHeld?: boolean;
    navigationHoldStyle?: Record<string, string> | null;
    placeholderStyle?: Record<string, string> | null;
    placedImage?: IPdfImagePlacementDraft | null;
    placedImageBusy?: boolean;
}

const {
    page,
    showSkeleton,
    spreadSingle = false,
    buffered = false,
    rendered = false,
    preview = null,
    navigationHeld = false,
    navigationHoldStyle = null,
    placeholderStyle = null,
    placedImage = null,
    placedImageBusy = false,
} = defineProps<IProps>();
const emit = defineEmits<{
    'page-container-mounted': [page: number];
    'page-preview-drawn': [page: number];
    'update-placed-image-rect': [payload: IPdfImagePlacementRectUpdate];
    'finalize-placed-image': [];
    'cancel-placed-image': [];
}>();
const pageContainer = ref<HTMLElement | null>(null);
const previewCanvas = ref<HTMLCanvasElement | null>(null);
const isPreviewDrawn = ref(false);

const {
    scaledSkeletonPadding,
    scaledPageHeight,
} = usePdfSkeletonContext();

const shapeContext = inject<IShapeContextProvide | null>('shapeContext', null);

const pageShapes = computed(() => shapeContext?.getShapesForPage(page - 1) ?? []);
const showPreview = computed(() => Boolean(preview && !rendered));
const showPageSkeleton = computed(() => showSkeleton && !showPreview.value && !isPreviewDrawn.value);
const isPageVisualReadyForShapeOverlay = computed(() => rendered || isPreviewDrawn.value);

function drawPreview() {
    if (!showPreview.value || !preview || !previewCanvas.value) {
        isPreviewDrawn.value = false;
        return;
    }

    const canvas = previewCanvas.value;
    if (canvas.width !== preview.width) {
        canvas.width = preview.width;
    }
    if (canvas.height !== preview.height) {
        canvas.height = preview.height;
    }

    const context = canvas.getContext('2d');
    if (!context) {
        return;
    }

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(preview.source, 0, 0, canvas.width, canvas.height);
    isPreviewDrawn.value = true;
    emit('page-preview-drawn', page);
}

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
    drawPreview();
});

watch(
    () => [
        preview?.id ?? null,
        rendered,
    ] as const,
    async () => {
        isPreviewDrawn.value = false;
        await nextTick();
        drawPreview();
    },
);

onBeforeUnmount(() => {
    clearPdfSelectionForLayerTeardown({ target: pageContainer.value });
});
</script>
