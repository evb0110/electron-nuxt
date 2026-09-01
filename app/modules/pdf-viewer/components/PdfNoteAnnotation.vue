<template>
    <button
        type="button"
        class="pdf-annotation-editor-entity pdf-annotation-editor-note"
        :class="{'is-selected': selected}"
        :style="noteStyle"
        :data-annotation-id="entity.identity.id"
        data-annotation-kind="note"
        aria-label="Open note"
    >
        <UIcon name="i-ph-chat-circle-text" />
    </button>
</template>

<script setup lang="ts">
import type { INoteEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

const props = defineProps<{
    entity: INoteEntity;
    selected: boolean;
}>();

const noteStyle = computed(() => ({
    left: `${props.entity.position.left * 100}%`,
    top: `${props.entity.position.top * 100}%`,
    width: `${Math.max(props.entity.position.width, 0.018) * 100}%`,
    height: `${Math.max(props.entity.position.height, 0.018) * 100}%`,
    color: props.entity.color ?? 'var(--ui-text)',
}));
</script>
