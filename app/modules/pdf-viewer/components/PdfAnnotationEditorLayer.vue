<template>
    <div
        class="pdf-annotation-editor-layer"
        data-pdf-annotation-editor-surface
        @click.stop="handleSurfaceClick"
        @dblclick.stop="handleSurfaceDblClick"
    >
        <svg
            class="pdf-annotation-editor-surface__svg"
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
            aria-hidden="true"
        >
            <PdfTextMarkupAnnotation
                v-for="entity in svgEntities.textMarkup"
                :key="entity.identity.id"
                :entity="entity"
                :selected="isSelected(entity.identity.id)"
            />
            <PdfShapeAnnotation
                v-for="entity in svgEntities.shapes"
                :key="entity.identity.id"
                :entity="entity"
                :selected="isSelected(entity.identity.id)"
            />
        </svg>
        <div class="pdf-annotation-editor-surface__html">
            <PdfTextBoxAnnotation
                v-for="entity in htmlEntities.textBoxes"
                :key="entity.identity.id"
                :entity="entity"
                :selected="isSelected(entity.identity.id)"
            />
            <PdfNoteAnnotation
                v-for="entity in htmlEntities.notes"
                :key="entity.identity.id"
                :entity="entity"
                :selected="isSelected(entity.identity.id)"
            />
            <PdfStampAnnotation
                v-for="entity in htmlEntities.stamps"
                :key="entity.identity.id"
                :entity="entity"
                :selected="isSelected(entity.identity.id)"
            />
            <PdfAnnotationSelectionHandles :entity="selectedEntity" />
        </div>
    </div>
</template>

<script setup lang="ts">
import type {
    AnnotationId,
    IPlacedImageEntity,
    INoteEntity,
    IShapeEntity,
    ITextBoxEntity,
    ITextMarkupEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {
    annotationEditorSurfaceKey,
    type IAnnotationEditorSurface,
} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import PdfAnnotationSelectionHandles from '@app/modules/pdf-viewer/components/PdfAnnotationSelectionHandles.vue';
import PdfNoteAnnotation from '@app/modules/pdf-viewer/components/PdfNoteAnnotation.vue';
import PdfShapeAnnotation from '@app/modules/pdf-viewer/components/PdfShapeAnnotation.vue';
import PdfStampAnnotation from '@app/modules/pdf-viewer/components/PdfStampAnnotation.vue';
import PdfTextBoxAnnotation from '@app/modules/pdf-viewer/components/PdfTextBoxAnnotation.vue';
import PdfTextMarkupAnnotation from '@app/modules/pdf-viewer/components/PdfTextMarkupAnnotation.vue';

const props = defineProps<{pageIndex: number;}>();

const injectedSurface = inject<IAnnotationEditorSurface>(annotationEditorSurfaceKey);
if (!injectedSurface) {
    throw new Error('PdfAnnotationEditorLayer requires an annotation editor surface');
}
const surface: IAnnotationEditorSurface = injectedSurface;

const entities = computed(() => surface.getEntitiesForPage(props.pageIndex));
const selectedEntity = computed(() => {
    const selectedId = [...surface.selectedIds.value][0];
    return entities.value.find(entity => entity.identity.id === selectedId) ?? null;
});
const isSelected = (id: AnnotationId) => surface.selectedIds.value.has(id);

const svgEntities = computed(() => ({
    textMarkup: entities.value.filter((entity): entity is ITextMarkupEntity => entity.kind === 'text-markup'),
    shapes: entities.value.filter((entity): entity is IShapeEntity => entity.kind === 'shape'),
}));
const htmlEntities = computed(() => ({
    textBoxes: entities.value.filter((entity): entity is ITextBoxEntity => entity.kind === 'text-box'),
    notes: entities.value.filter((entity): entity is INoteEntity => entity.kind === 'note'),
    stamps: entities.value.filter((entity): entity is IPlacedImageEntity => entity.kind === 'placed-image'),
}));

function entityIdFromEvent(event: MouseEvent) {
    const target = event.target;
    if (!(target instanceof Element)) {
        return null;
    }
    const id = target.closest<HTMLElement>('[data-annotation-id]')?.dataset.annotationId;
    return id ? id as AnnotationId : null;
}

function handleSurfaceClick(event: MouseEvent) {
    const id = entityIdFromEvent(event);
    if (!id) {
        surface.clearSelection();
        return;
    }
    surface.select([id], {additive: event.shiftKey});
}

function handleSurfaceDblClick(event: MouseEvent) {
    const id = entityIdFromEvent(event);
    if (id) {
        surface.openNote(id);
    }
}
</script>
