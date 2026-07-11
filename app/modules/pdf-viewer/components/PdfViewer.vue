<template>
    <div
        ref="viewerHost"
        class="relative h-full w-full"
        :class="{ 'pdf-viewer-container--dark': props.invertColors === true }"
    >
        <PdfViewerViewport
            :set-viewer-container="handleViewerContainerRef"
            :viewer-class="viewerClass"
            :container-style="containerStyle"
            :virtual-page-segments="virtualPageSegments"
            :should-show-skeleton="shouldShowPageSkeleton"
            :is-spread-single="isSpreadSingle"
            :is-buffered-page="isPageBuffered"
            :is-rendered-page="isPageRenderedForClass"
            :is-shape-overlay-visual-ready-page="isPageVisualReadyForShapeOverlay"
            :get-page-placeholder-style="getPagePlaceholderStyle"
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
            @page-container-mounted="handlePageContainerMounted"
            @page-container-unmounted="handlePageContainerUnmounted"
            @update-placed-image-rect="updatePendingImagePlacementRect"
            @finalize-placed-image="requestPendingImagePlacementFinalize"
            @cancel-placed-image="clearPendingImagePlacement"
        />
        <PdfInitialSurfacePlaceholder v-if="showInitialSurfacePlaceholder" />
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
            @link-destination="handleLinkDestination"
        />
    </div>
</template>

<script setup lang="ts">
import PdfViewerPortalLayers from '@app/modules/pdf-viewer/components/PdfViewerPortalLayers.vue';
import PdfViewerViewport from '@app/modules/pdf-viewer/components/PdfViewerViewport.vue';
import PdfRegionSnipOverlay from '@app/modules/pdf-viewer/components/PdfRegionSnipOverlay.vue';
import PdfCropOverlay from '@app/modules/pdf-viewer/components/PdfCropOverlay.vue';
import { PdfInitialSurfacePlaceholder } from '@app/modules/pdf-viewer/public/component-exports/pdfInitialSurfacePlaceholder';
import type {
    IPdfViewerProps,
    IPdfViewerEmit,
} from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerComponent.types';
import { usePdfViewerFeatureController } from '@app/modules/pdf-viewer/runtime/usePdfViewerFeatureController';

import '@app/assets/css/vendor/pdfjs-viewer-sanitized.css';

const props = defineProps<IPdfViewerProps>();
const emitBase = defineEmits<IPdfViewerEmit>();
const initialSurfacePlaceholderPending = ref(Boolean(props.src));
const showInitialSurfacePlaceholder = computed(() => (
    initialSurfacePlaceholderPending.value
    && props.isActive !== false
));
const emit = ((event: string, ...args: unknown[]) => {
    if (event === 'initial-visual-pending') {
        initialSurfacePlaceholderPending.value = true;
    }
    if (event === 'initial-visual-ready' || event === 'load-error') {
        initialSurfacePlaceholderPending.value = false;
    }
    (emitBase as (event: string, ...args: unknown[]) => void)(event, ...args);
}) as IPdfViewerEmit;
const controller = usePdfViewerFeatureController(props, emit);
const {
    t,
    viewerHost,
    viewerContainer,
    annotationUiManager,
    viewerClass,
    containerStyle,
    virtualPageSegments,
    shouldShowPageSkeleton,
    isSpreadSingle,
    isPageBuffered,
    isPageRenderedForClass,
    isPageVisualReadyForShapeOverlay,
    getPagePlaceholderStyle,
    bottomVirtualSpacerStyle,
    pendingImagePlacement,
    isPendingImagePlacementFinalizing,
    handleViewportScroll,
    handleViewerWheel,
    handleViewerMouseDown,
    handleViewerMouseMove,
    handleViewerMouseUp,
    handleViewerMouseLeave,
    handleViewerClick,
    handleViewerDblClick,
    handleViewerContextMenu,
    handleSelectStart,
    handlePageContainerMounted,
    handlePageContainerUnmounted,
    updatePendingImagePlacementRect,
    requestPendingImagePlacementFinalize,
    clearPendingImagePlacement,
    regionSnip,
    cropSelection,
    visibleMarkersByPage,
    visibleLinksByPage,
    handleMarkerOpenNote,
    handleMarkerContextMenu,
    handleMarkerMove,
    handleLinkDestination,
    handleViewerContainerRef,
    pdfViewerPublicApi,
} = controller;

void annotationUiManager;

watch(() => props.src, (nextSrc) => {
    initialSurfacePlaceholderPending.value = Boolean(nextSrc);
});

defineExpose(pdfViewerPublicApi);
</script>
<style lang="scss" src="@app/assets/css/pdf-viewer.scss"></style>
