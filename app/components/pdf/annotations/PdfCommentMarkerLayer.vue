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
            @open-note="emit('openNote', $event)"
            @context-menu="(comment, event) => emit('contextMenu', comment, event)"
        />
    </div>
</template>

<script setup lang="ts">
import type {
    IAnnotationCommentSummary,
    IMarkerViewModel,
} from '@app/composables/pdf/annotations/types';
import PdfCommentMarker from '@app/components/pdf/annotations/PdfCommentMarker.vue';

defineProps<{
    pageNumber: number;
    markers: IMarkerViewModel[];
}>();

const emit = defineEmits<{
    openNote: [comment: IAnnotationCommentSummary];
    contextMenu: [comment: IAnnotationCommentSummary, event: MouseEvent];
}>();
</script>

<style scoped>
.pdf-comment-marker-layer-vue {
    position: absolute;
    inset: 0;
    z-index: 4;
    pointer-events: none;
}
</style>
