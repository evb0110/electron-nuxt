<template>
    <template v-for="[pageNum, markers] in markersByPage" :key="`markers-${pageNum}`">
        <Teleport v-if="markerLayerTargets.get(pageNum)" :to="markerLayerTargets.get(pageNum)!">
            <PdfCommentMarkerLayer
                :page-number="pageNum"
                :markers="markers"
                @open-note="handleOpenNote"
                @context-menu="handleContextMenu"
                @move-marker="handleMoveMarker"
            />
        </Teleport>
    </template>
    <template v-for="(links, pageNum) in linksByPage" :key="`links-${pageNum}`">
        <Teleport v-if="linkLayerTargets.get(Number(pageNum))" :to="linkLayerTargets.get(Number(pageNum))!">
            <PdfLinkOverlayLayer :links="links" />
        </Teleport>
    </template>
</template>

<script setup lang="ts">
import PdfCommentMarkerLayer from '@app/components/pdf/annotations/PdfCommentMarkerLayer.vue';
import PdfLinkOverlayLayer from '@app/components/pdf/annotations/PdfLinkOverlayLayer.vue';
import { resolvePageTargets } from '@app/components/pdf/pdfViewerPortalTargets';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    ILinkAnnotation,
    IMarkerViewModel,
} from '@app/composables/pdf/annotations/types';

interface IProps {
    viewerContainer: HTMLElement | null;
    markersByPage: Map<number, IMarkerViewModel[]>;
    linksByPage: Record<number, ILinkAnnotation[]>;
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    'open-note': [comment: IAnnotationCommentSummary];
    'context-menu': [comment: IAnnotationCommentSummary, event: MouseEvent];
    'move-marker': [comment: IAnnotationCommentSummary, markerRect: IAnnotationMarkerRect];
}>();

const markerLayerTargets = computed(() =>
    resolvePageTargets(props.viewerContainer, [...props.markersByPage.keys()]),
);

const linkLayerTargets = computed(() =>
    resolvePageTargets(props.viewerContainer, Object.keys(props.linksByPage).map(Number)),
);

function handleOpenNote(comment: IAnnotationCommentSummary) {
    emit('open-note', comment);
}

function handleContextMenu(comment: IAnnotationCommentSummary, event: MouseEvent) {
    emit('context-menu', comment, event);
}

function handleMoveMarker(comment: IAnnotationCommentSummary, markerRect: IAnnotationMarkerRect) {
    emit('move-marker', comment, markerRect);
}
</script>
