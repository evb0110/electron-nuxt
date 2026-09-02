<template>
    <div
        ref="layerRef"
        class="pdf-annotation-editor-layer"
        :class="{'is-interactive': isInteractive}"
        data-pdf-annotation-editor-surface
        @mousedown.stop
        @pointerdown.stop="handleSurfacePointerDown"
        @pointermove="handlePointerMove"
        @pointerup="handlePointerUp"
        @pointercancel="handlePointerCancel"
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
                :ref="element => setTextBoxRef(entity.identity.id, element)"
                :entity="entity"
                :selected="isSelected(entity.identity.id)"
                :editing="editingId === entity.identity.id"
                :display-rect="displayRectFor(entity)"
                @pointer-down="handleTextBoxPointerDown(entity, $event)"
                @edit="beginTextBoxEdit(entity.identity.id)"
                @commit="commitTextBox(entity.identity.id, $event)"
                @cancel="cancelTextBox(entity.identity.id)"
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
            <div
                v-if="isCreating && pointerGesture.previewRect.value"
                class="pdf-annotation-editor-text-box-preview"
                :style="rectStyle(pointerGesture.previewRect.value)"
                aria-hidden="true"
            />
            <PdfAnnotationSelectionHandles
                :entity="selectedEntity"
                :display-rect="selectedDisplayRect"
                @resize-start="handleResizeStart"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
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
import {
    annotationRectsEqual,
    annotationRectContainsPoint,
    createDefaultTextBoxRect,
    type IAnnotationEditorPoint,
    type TAnnotationResizeHandle,
} from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/annotationEditorGeometry';
import { useAnnotationCreationTools } from '@app/modules/pdf-viewer/annotations/editor/useAnnotationCreationTools';
import { useAnnotationPointerGesture } from '@app/modules/pdf-viewer/annotations/editor/useAnnotationPointerGesture';

const props = defineProps<{pageIndex: number;}>();

const injectedSurface = inject<IAnnotationEditorSurface>(annotationEditorSurfaceKey);
if (!injectedSurface) {
    throw new Error('PdfAnnotationEditorLayer requires an annotation editor surface');
}
const surface: IAnnotationEditorSurface = injectedSurface;
const layerRef = ref<HTMLElement | null>(null);
const editingId = ref<AnnotationId | null>(null);
const draggedAnnotationId = ref<AnnotationId | null>(null);
const isCreating = ref(false);
const newTextBoxIds = new Set<AnnotationId>();
interface IPdfTextBoxAnnotationExpose {commitDraft: () => void;}
const textBoxRefs = new Map<AnnotationId, IPdfTextBoxAnnotationExpose>();
let suppressNextClick = false;
let suppressClickTimer: ReturnType<typeof setTimeout> | null = null;

const pointerGesture = useAnnotationPointerGesture({
    surface,
    pageIndex: props.pageIndex,
});
const creationTools = useAnnotationCreationTools({surface});
const isInteractive = computed(() => (
    surface.activeTool.value === 'text' || pointerGesture.isActive.value
));
const entities = computed(() => surface.getEntitiesForPage(props.pageIndex));
const selectedEntity = computed(() => {
    const selectedId = [...surface.selectedIds.value][0];
    return entities.value.find(entity => entity.identity.id === selectedId) ?? null;
});
const selectedDisplayRect = computed(() => selectedEntity.value?.kind === 'text-box'
    ? displayRectFor(selectedEntity.value)
    : undefined);
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

function setTextBoxRef(
    annotationId: AnnotationId,
    element: Element | ComponentPublicInstance | null,
) {
    if (
        element
        && 'commitDraft' in element
        && typeof element.commitDraft === 'function'
    ) {
        textBoxRefs.set(annotationId, element as IPdfTextBoxAnnotationExpose);
        return;
    }
    textBoxRefs.delete(annotationId);
}

function entityIdFromEvent(event: MouseEvent | PointerEvent) {
    const target = event.target;
    if (!(target instanceof Element)) {
        return null;
    }
    const id = target.closest<HTMLElement>('[data-annotation-id]')?.dataset.annotationId;
    return id ? id as AnnotationId : null;
}

function pointFromEvent(event: Pick<PointerEvent, 'clientX' | 'clientY'>): IAnnotationEditorPoint | null {
    const layerRect = layerRef.value?.getBoundingClientRect();
    if (!layerRect || layerRect.width <= 0 || layerRect.height <= 0) {
        return null;
    }
    return {
        x: (event.clientX - layerRect.left) / layerRect.width,
        y: (event.clientY - layerRect.top) / layerRect.height,
    };
}

function capturePointer(event: PointerEvent) {
    if (event.pointerId >= 0) {
        layerRef.value?.setPointerCapture?.(event.pointerId);
    }
}

function releasePointer(event: PointerEvent) {
    if (event.pointerId >= 0 && layerRef.value?.hasPointerCapture?.(event.pointerId)) {
        layerRef.value.releasePointerCapture(event.pointerId);
    }
}

function rectStyle(rect: {
    left: number;
    top: number;
    width: number;
    height: number
}) {
    return {
        left: String(rect.left * 100) + '%',
        top: String(rect.top * 100) + '%',
        width: String(rect.width * 100) + '%',
        height: String(rect.height * 100) + '%',
    };
}

function displayRectFor(entity: ITextBoxEntity) {
    if (draggedAnnotationId.value !== entity.identity.id) {
        return undefined;
    }
    return pointerGesture.previewRect.value ?? undefined;
}

function textBoxIdAtPoint(event: Pick<MouseEvent, 'clientX' | 'clientY'>) {
    const point = pointFromEvent(event);
    if (!point) {
        return null;
    }
    return [...htmlEntities.value.textBoxes].reverse().find(entity => (
        annotationRectContainsPoint(entity.rect, point)
    ))?.identity.id ?? null;
}

function beginTextBoxEdit(annotationId: AnnotationId) {
    surface.select([annotationId]);
    editingId.value = annotationId;
}

function handleTextBoxPointerDown(entity: ITextBoxEntity, event: PointerEvent) {
    if (event.button !== 0 || editingId.value === entity.identity.id) {
        return;
    }
    const point = pointFromEvent(event);
    if (!point) {
        return;
    }
    surface.select([entity.identity.id], {additive: event.shiftKey});
    if (event.shiftKey || (surface.activeTool.value !== 'select' && surface.activeTool.value !== 'none')) {
        return;
    }
    if (pointerGesture.beginMove(entity.identity.id, point, event)) {
        draggedAnnotationId.value = entity.identity.id;
        event.preventDefault();
        capturePointer(event);
    }
}

function handleResizeStart(handle: TAnnotationResizeHandle, event: PointerEvent) {
    const entity = selectedEntity.value;
    if (entity?.kind !== 'text-box' || editingId.value === entity.identity.id) {
        return;
    }
    const point = pointFromEvent(event);
    if (!point) {
        return;
    }
    if (pointerGesture.beginResize(entity.identity.id, handle, point, event)) {
        draggedAnnotationId.value = entity.identity.id;
        surface.select([entity.identity.id]);
        event.preventDefault();
        capturePointer(event);
    }
}

function handleSurfacePointerDown(event: PointerEvent) {
    if (event.button !== 0) {
        return;
    }
    const id = entityIdFromEvent(event);
    if (id) {
        surface.select([id], {additive: event.shiftKey});
        return;
    }
    if (surface.activeTool.value !== 'text') {
        surface.clearSelection();
        return;
    }
    const point = pointFromEvent(event);
    if (!point || !pointerGesture.beginCreate(point, event)) {
        return;
    }
    isCreating.value = true;
    event.preventDefault();
    capturePointer(event);
}

function handlePointerMove(event: PointerEvent) {
    if (!pointerGesture.isActive.value) {
        return;
    }
    const point = pointFromEvent(event);
    if (!point) {
        return;
    }
    pointerGesture.update(point, event);
    event.preventDefault();
}

function markClickSuppressed() {
    suppressNextClick = true;
    if (suppressClickTimer !== null) {
        clearTimeout(suppressClickTimer);
    }
    suppressClickTimer = setTimeout(() => {
        suppressNextClick = false;
        suppressClickTimer = null;
    });
}

function handlePointerUp(event: PointerEvent) {
    if (!pointerGesture.isActive.value) {
        return;
    }
    const point = pointFromEvent(event);
    const completion = point ? pointerGesture.finish(point, event) : null;
    releasePointer(event);
    isCreating.value = false;
    draggedAnnotationId.value = null;
    if (!completion) {
        pointerGesture.cancel();
        return;
    }
    markClickSuppressed();
    if (completion.mode === 'create') {
        const rect = completion.hasMoved
            ? completion.rect
            : createDefaultTextBoxRect(completion.start);
        const created = creationTools.create('text', completion.pageIndex, rect);
        if (created) {
            newTextBoxIds.add(created.identity.id);
            editingId.value = created.identity.id;
        }
        return;
    }
    if (!completion.hasMoved || !completion.gesture || completion.gesture.entity.kind !== 'text-box') {
        return;
    }
    if (!annotationRectsEqual(completion.gesture.entity.rect, completion.rect)) {
        surface.commitGesture(completion.gesture, {rect: completion.rect});
    }
}

function handlePointerCancel(event: PointerEvent) {
    if (!pointerGesture.isActive.value) {
        return;
    }
    releasePointer(event);
    pointerGesture.cancel();
    isCreating.value = false;
    draggedAnnotationId.value = null;
}

function handleSurfaceClick(event: MouseEvent) {
    if (suppressNextClick) {
        suppressNextClick = false;
        return;
    }
    const id = entityIdFromEvent(event) ?? textBoxIdAtPoint(event);
    if (!id) {
        surface.clearSelection();
        return;
    }
    surface.select([id], {additive: event.shiftKey});
}

function handleSurfaceDblClick(event: MouseEvent) {
    const id = entityIdFromEvent(event) ?? textBoxIdAtPoint(event);
    if (id) {
        const entity = entities.value.find(candidate => candidate.identity.id === id);
        if (entity?.kind === 'text-box') {
            beginTextBoxEdit(id);
        } else {
            surface.openNote(id);
        }
    }
}

function currentTextBox(annotationId: AnnotationId) {
    return entities.value.find((entity): entity is ITextBoxEntity => (
        entity.kind === 'text-box' && entity.identity.id === annotationId
    )) ?? null;
}

function commitTextBox(annotationId: AnnotationId, text: string) {
    if (editingId.value !== annotationId) {
        return;
    }
    const entity = currentTextBox(annotationId);
    if (!entity) {
        editingId.value = null;
        return;
    }
    if (newTextBoxIds.has(annotationId) && text.trim().length === 0) {
        surface.discardUnsavedAnnotation(annotationId);
    } else if (entity.text !== text) {
        surface.commitGesture(annotationId, {text});
    }
    newTextBoxIds.delete(annotationId);
    editingId.value = null;
}

function cancelTextBox(annotationId: AnnotationId) {
    if (editingId.value !== annotationId) {
        return;
    }
    const entity = currentTextBox(annotationId);
    if (entity && newTextBoxIds.has(annotationId)) {
        surface.discardUnsavedAnnotation(annotationId);
    }
    newTextBoxIds.delete(annotationId);
    editingId.value = null;
}

onBeforeUnmount(() => {
    if (suppressClickTimer !== null) {
        clearTimeout(suppressClickTimer);
    }
    if (editingId.value !== null) {
        textBoxRefs.get(editingId.value)?.commitDraft();
    }
    newTextBoxIds.forEach(annotationId => surface.discardUnsavedAnnotation(annotationId));
    newTextBoxIds.clear();
    textBoxRefs.clear();
    editingId.value = null;
    pointerGesture.cancel();
});
</script>
