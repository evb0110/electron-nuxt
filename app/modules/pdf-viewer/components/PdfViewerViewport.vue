<template>
    <div
        id="pdf-viewer"
        :ref="setViewerContainerElement"
        class="pdfViewer app-scrollbar"
        :class="viewerClass"
        :style="containerStyle"
        @scroll.passive="emit('scroll', $event)"
        @wheel="emit('wheel', $event)"
        @mousedown="emit('mousedown', $event)"
        @mousemove="emit('mousemove', $event)"
        @mouseup="emit('mouseup', $event)"
        @mouseleave="emit('mouseleave')"
        @click="emit('click', $event)"
        @dblclick="emit('dblclick', $event)"
        @contextmenu="emit('contextmenu', $event)"
        @selectstart="emit('selectstart', $event)"
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
            :spread-single="isSpreadSingle(page)"
            :buffered="isBufferedPage(page)"
            :rendered="isRenderedPage(page)"
            :shape-overlay-visual-ready="isShapeOverlayVisualReadyPage(page)"
            :preview="getPagePreview(page)"
            :navigation-held="isNavigationHeldPage(page)"
            :navigation-hold-style="getNavigationHoldStyle(page)"
            :placeholder-style="getPagePlaceholderStyle(page)"
            :placed-image="pendingImagePlacement?.pageNumber === page ? pendingImagePlacement : null"
            :placed-image-busy="isPendingImagePlacementFinalizing"
            @page-container-mounted="emit('page-container-mounted', $event)"
            @page-preview-drawn="emit('page-preview-drawn', $event)"
            @update-placed-image-rect="emit('update-placed-image-rect', $event)"
            @finalize-placed-image="emit('finalize-placed-image')"
            @cancel-placed-image="emit('cancel-placed-image')"
        />
        <div
            v-if="bottomVirtualSpacerStyle"
            class="pdf-viewer-virtual-spacer"
            :style="bottomVirtualSpacerStyle"
        />
    </div>
</template>

<script setup lang="ts">
import type {
    ComponentPublicInstance,
    StyleValue,
} from 'vue';
import PdfViewerPage from '@app/modules/pdf-viewer/components/PdfViewerPage.vue';
import type { IPdfPagePreviewEntry } from '@app/modules/pdf-viewer/engine/pdf-page-preview/pdfPagePreviewTypes';
import type {
    IPdfImagePlacementDraft,
    IPdfImagePlacementRectUpdate,
} from '@app/types/pdfImagePlacement';

interface IProps {
    setViewerContainer: (element: HTMLElement | null) => void;
    viewerClass: Record<string, boolean>;
    containerStyle: StyleValue;
    pagesToRender: number[];
    shouldShowSkeleton: (page: number) => boolean;
    isSpreadSingle: (page: number) => boolean;
    isBufferedPage: (page: number) => boolean;
    isRenderedPage: (page: number) => boolean;
    isShapeOverlayVisualReadyPage: (page: number) => boolean;
    getPagePreview: (page: number) => IPdfPagePreviewEntry | null;
    isNavigationHeldPage: (page: number) => boolean;
    getNavigationHoldStyle: (page: number) => Record<string, string> | null;
    getPagePlaceholderStyle: (page: number) => Record<string, string> | null;
    topVirtualSpacerStyle?: Record<string, string> | null;
    bottomVirtualSpacerStyle?: Record<string, string> | null;
    pendingImagePlacement?: IPdfImagePlacementDraft | null;
    isPendingImagePlacementFinalizing?: boolean;
}

const {
    setViewerContainer,
    viewerClass,
    containerStyle,
    pagesToRender,
    shouldShowSkeleton,
    isSpreadSingle,
    isBufferedPage,
    isRenderedPage,
    isShapeOverlayVisualReadyPage,
    getPagePreview,
    isNavigationHeldPage,
    getNavigationHoldStyle,
    getPagePlaceholderStyle,
    topVirtualSpacerStyle = null,
    bottomVirtualSpacerStyle = null,
    pendingImagePlacement = null,
    isPendingImagePlacementFinalizing = false,
} = defineProps<IProps>();

const emit = defineEmits<{
    scroll: [event: Event];
    wheel: [event: WheelEvent];
    mousedown: [event: MouseEvent];
    mousemove: [event: MouseEvent];
    mouseup: [event: MouseEvent];
    mouseleave: [];
    click: [event: MouseEvent];
    dblclick: [event: MouseEvent];
    contextmenu: [event: MouseEvent];
    selectstart: [event: Event];
    'page-container-mounted': [page: number];
    'page-preview-drawn': [page: number];
    'update-placed-image-rect': [payload: IPdfImagePlacementRectUpdate];
    'finalize-placed-image': [];
    'cancel-placed-image': [];
}>();

function setViewerContainerElement(element: Element | ComponentPublicInstance | null) {
    setViewerContainer(element instanceof HTMLElement ? element : null);
}
</script>
