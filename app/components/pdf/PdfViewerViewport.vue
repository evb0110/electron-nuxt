<template>
    <div
        id="pdf-viewer"
        :ref="setViewerContainerElement"
        class="pdfViewer app-scrollbar"
        :class="viewerClass"
        :style="containerStyle"
        @scroll.passive="handleScroll"
        @wheel="handleWheelEvent"
        @mousedown="handleMouseDown"
        @mousemove="handleMouseMove"
        @mouseup="handleMouseUp"
        @mouseleave="handleMouseLeave"
        @click="handleClick"
        @dblclick="handleDoubleClick"
        @contextmenu="handleContextMenuEvent"
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
            :spread-single="isSpreadSingle(page)"
            :buffered="isBufferedPage(page)"
            :rendered="isRenderedPage(page)"
            :placeholder-style="getPagePlaceholderStyle(page)"
            :placed-image="pendingImagePlacement?.pageNumber === page ? pendingImagePlacement : null"
            :placed-image-busy="isPendingImagePlacementFinalizing"
            @update-placed-image-rect="updatePlacedImageRect"
            @finalize-placed-image="finalizePlacedImage"
            @cancel-placed-image="cancelPlacedImage"
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
import PdfViewerPage from '@app/components/pdf/PdfViewerPage.vue';
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
    'update-placed-image-rect': [payload: IPdfImagePlacementRectUpdate];
    'finalize-placed-image': [];
    'cancel-placed-image': [];
}>();

function handleScroll(event: Event) {
    emit('scroll', event);
}

function handleWheelEvent(event: WheelEvent) {
    emit('wheel', event);
}

function handleMouseDown(event: MouseEvent) {
    emit('mousedown', event);
}

function handleMouseMove(event: MouseEvent) {
    emit('mousemove', event);
}

function handleMouseUp(event: MouseEvent) {
    emit('mouseup', event);
}

function handleMouseLeave() {
    emit('mouseleave');
}

function handleClick(event: MouseEvent) {
    emit('click', event);
}

function handleDoubleClick(event: MouseEvent) {
    emit('dblclick', event);
}

function handleContextMenuEvent(event: MouseEvent) {
    emit('contextmenu', event);
}

function handleSelectStart(event: Event) {
    emit('selectstart', event);
}

function updatePlacedImageRect(payload: IPdfImagePlacementRectUpdate) {
    emit('update-placed-image-rect', payload);
}

function finalizePlacedImage() {
    emit('finalize-placed-image');
}

function cancelPlacedImage() {
    emit('cancel-placed-image');
}

function setViewerContainerElement(element: Element | ComponentPublicInstance | null) {
    setViewerContainer(element instanceof HTMLElement ? element : null);
}
</script>
