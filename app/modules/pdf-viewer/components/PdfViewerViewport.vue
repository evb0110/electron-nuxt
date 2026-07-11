<template>
    <div
        :id="chassisAuthority ? undefined : 'pdf-viewer'"
        :ref="setViewerContainerElement"
        class="pdfViewer app-scrollbar"
        :class="chassisAuthority ? 'contents' : viewerClass"
        :style="chassisAuthority ? undefined : containerStyle"
        @scroll.passive="!chassisAuthority && emit('scroll', $event)"
        @wheel="!chassisAuthority && emit('wheel', $event)"
        @mousedown="!chassisAuthority && emit('mousedown', $event)"
        @mousemove="!chassisAuthority && emit('mousemove', $event)"
        @mouseup="!chassisAuthority && emit('mouseup', $event)"
        @mouseleave="!chassisAuthority && emit('mouseleave')"
        @click="!chassisAuthority && emit('click', $event)"
        @dblclick="!chassisAuthority && emit('dblclick', $event)"
        @contextmenu="!chassisAuthority && emit('contextmenu', $event)"
        @selectstart="!chassisAuthority && emit('selectstart', $event)"
    >
        <template v-for="segment in virtualPageSegments" :key="segment.key">
            <div
                v-if="segment.spacerBeforeStyle"
                class="pdf-viewer-virtual-spacer"
                :style="segment.spacerBeforeStyle"
            />
            <PdfViewerPage
            v-for="page in segment.pages"
            :key="`${segment.key}:${page}`"
            :page="page"
            :show-skeleton="shouldShowSkeleton(page)"
            :spread-single="isSpreadSingle(page)"
            :buffered="isBufferedPage(page)"
            :rendered="isRenderedPage(page)"
            :shape-overlay-visual-ready="isShapeOverlayVisualReadyPage(page)"
            :placeholder-style="getPagePlaceholderStyle(page)"
            :placed-image="pendingImagePlacement?.pageNumber === page ? pendingImagePlacement : null"
            :placed-image-busy="isPendingImagePlacementFinalizing"
            @page-container-mounted="emit('page-container-mounted', $event)"
            @page-container-unmounted="emit('page-container-unmounted', $event)"
            @update-placed-image-rect="emit('update-placed-image-rect', $event)"
            @finalize-placed-image="emit('finalize-placed-image')"
            @cancel-placed-image="emit('cancel-placed-image')"
            />
        </template>
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
import { injectDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import type {
    IPdfImagePlacementDraft,
    IPdfImagePlacementRectUpdate,
} from '@app/types/pdfImagePlacement';
import type { IPdfVirtualPageSegment } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerVirtualization';

interface IProps {
    setViewerContainer: (element: HTMLElement | null) => void;
    viewerClass: Record<string, boolean>;
    containerStyle: StyleValue;
    virtualPageSegments: IPdfVirtualPageSegment[];
    shouldShowSkeleton: (page: number) => boolean;
    isSpreadSingle: (page: number) => boolean;
    isBufferedPage: (page: number) => boolean;
    isRenderedPage: (page: number) => boolean;
    isShapeOverlayVisualReadyPage: (page: number) => boolean;
    getPagePlaceholderStyle: (page: number) => Record<string, string> | null;
    bottomVirtualSpacerStyle?: Record<string, string> | null;
    pendingImagePlacement?: IPdfImagePlacementDraft | null;
    isPendingImagePlacementFinalizing?: boolean;
}

const {
    setViewerContainer,
    viewerClass,
    containerStyle,
    virtualPageSegments,
    shouldShowSkeleton,
    isSpreadSingle,
    isBufferedPage,
    isRenderedPage,
    isShapeOverlayVisualReadyPage,
    getPagePlaceholderStyle,
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
    'page-container-unmounted': [page: number];
    'update-placed-image-rect': [payload: IPdfImagePlacementRectUpdate];
    'finalize-placed-image': [];
    'cancel-placed-image': [];
}>();

const chassisAuthority = injectDocumentViewerChassisAuthority();
let releaseViewportFeature: (() => void) | null = null;

function setViewerContainerElement(element: Element | ComponentPublicInstance | null) {
    setViewerContainer(chassisAuthority?.viewportElement.value
        ?? (element instanceof HTMLElement ? element : null));
}

onMounted(() => {
    if (!chassisAuthority) {
        return;
    }
    setViewerContainer(chassisAuthority.viewportElement.value);
    releaseViewportFeature = chassisAuthority.bindViewportFeature({
        getClass: () => [
            'pdfViewer app-scrollbar',
            viewerClass,
        ],
        getStyle: () => containerStyle,
        events: {
            scroll: event => emit('scroll', event as Event),
            wheel: event => emit('wheel', event as WheelEvent),
            mousedown: event => emit('mousedown', event as MouseEvent),
            mousemove: event => emit('mousemove', event as MouseEvent),
            mouseup: event => emit('mouseup', event as MouseEvent),
            mouseleave: () => emit('mouseleave'),
            click: event => emit('click', event as MouseEvent),
            dblclick: event => emit('dblclick', event as MouseEvent),
            contextmenu: event => emit('contextmenu', event as MouseEvent),
            selectstart: event => emit('selectstart', event as Event),
        },
    });
});

onBeforeUnmount(() => releaseViewportFeature?.());

</script>
