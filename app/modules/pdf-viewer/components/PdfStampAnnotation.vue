<template>
    <div
        class="pdf-annotation-editor-entity pdf-annotation-editor-stamp"
        :class="{'is-selected': selected}"
        :style="rectStyle"
        :data-annotation-id="entity.identity.id"
        data-annotation-kind="placed-image"
        aria-label="Image annotation"
    >
        <img
            v-if="imageUrl"
            class="pdf-annotation-editor-stamp__image"
            :src="imageUrl"
            alt=""
            draggable="false"
        />
        <UIcon v-else name="i-ph-image" />
    </div>
</template>

<script setup lang="ts">
import type { IPlacedImageEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { annotationEditorSurfaceKey } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';

const props = defineProps<{
    entity: IPlacedImageEntity;
    selected: boolean;
}>();
const annotationEditorSurface = inject(annotationEditorSurfaceKey, null);
const imageUrl = shallowRef<string | null>(null);
let imageLoadGeneration = 0;

async function resolveImage(entity: IPlacedImageEntity) {
    const generation = ++imageLoadGeneration;
    imageUrl.value = null;
    const resolved = await annotationEditorSurface?.resolveStampImage?.(entity);
    if (generation === imageLoadGeneration) {
        imageUrl.value = resolved ?? null;
    }
}

watch(() => props.entity.image, () => {
    void resolveImage(props.entity);
}, {
    immediate: true,
    deep: true,
});

onBeforeUnmount(() => {
    imageLoadGeneration += 1;
});

const rectStyle = computed(() => ({
    left: `${props.entity.rect.left * 100}%`,
    top: `${props.entity.rect.top * 100}%`,
    width: `${props.entity.rect.width * 100}%`,
    height: `${props.entity.rect.height * 100}%`,
    transform: `rotate(${props.entity.rotation}deg)`,
}));
</script>
