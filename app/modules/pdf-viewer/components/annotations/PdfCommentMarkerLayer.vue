<template>
    <div
        class="pdf-comment-marker-layer-vue"
        aria-hidden="false"
    >
        <PdfCommentMarker
            v-for="marker in markers"
            :key="marker.annotation.stableKey"
            :annotation="marker.annotation"
            :clustered="marker.clustered"
            :is-active="marker.isActive"
            :preview="marker.preview"
            :label-text="marker.ariaLabel"
            :left-percent="marker.leftPercent"
            :top-percent="marker.topPercent"
            @open-note="openNote"
            @context-menu="openContextMenu"
            @move-marker="moveMarker"
        />
    </div>
</template>

<script setup lang="ts">
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import type { IMarkerViewModel } from '@app/modules/pdf-viewer/engine/annotations/types';
import PdfCommentMarker from '@app/modules/pdf-viewer/components/annotations/PdfCommentMarker.vue';

defineProps<{ markers: IMarkerViewModel[] }>();

const emit = defineEmits<{
    openNote: [comment: IAnnotationCommentSummary];
    contextMenu: [comment: IAnnotationCommentSummary, event: MouseEvent];
    moveMarker: [comment: IAnnotationCommentSummary, markerRect: IAnnotationMarkerRect];
}>();

function openNote(comment: IAnnotationCommentSummary) {
    emit('openNote', comment);
}

function openContextMenu(comment: IAnnotationCommentSummary, event: MouseEvent) {
    emit('contextMenu', comment, event);
}

function moveMarker(comment: IAnnotationCommentSummary, markerRect: IAnnotationMarkerRect) {
    emit('moveMarker', comment, markerRect);
}
</script>

<style scoped>
.pdf-comment-marker-layer-vue {
    position: absolute;
    inset: 0;
    z-index: var(--app-z-pdf-comment-marker-layer);
    pointer-events: none;
}
</style>
