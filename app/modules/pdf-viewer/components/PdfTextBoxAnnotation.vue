<template>
    <div
        class="pdf-annotation-editor-entity pdf-annotation-editor-text-box"
        :class="{'is-selected': selected}"
        :style="rectStyle"
        :data-annotation-id="entity.identity.id"
        data-annotation-kind="text-box"
        :aria-label="entity.text || t('annotations.annotationLabel')"
    >
        {{ entity.text }}
    </div>
</template>

<script setup lang="ts">
import type { ITextBoxEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { toPdfScaledCssLength } from '@app/modules/pdf-viewer/engine/pdf-page-scale/pdfPageScale';

const props = defineProps<{
    entity: ITextBoxEntity;
    selected: boolean;
}>();
const { t } = useTypedI18n();

const rectStyle = computed(() => ({
    left: `${props.entity.rect.left * 100}%`,
    top: `${props.entity.rect.top * 100}%`,
    width: `${props.entity.rect.width * 100}%`,
    height: `${props.entity.rect.height * 100}%`,
    color: props.entity.color ?? 'var(--ui-text)',
    fontSize: toPdfScaledCssLength(props.entity.fontSize),
    transform: `rotate(${props.entity.rotation}deg)`,
}));
</script>
