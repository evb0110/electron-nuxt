<template>
    <g
        class="pdf-annotation-editor-entity pdf-annotation-editor-shape"
        :class="{'is-selected': selected}"
        :data-annotation-id="entity.identity.id"
        :data-pdf-annotation-id="entity.identity.pdfRef"
        data-annotation-kind="shape"
        :style="shapeStyle"
        aria-label="Shape annotation"
    >
        <line
            v-if="entity.tool === 'line' || entity.tool === 'arrow'"
            :x1="line.x1"
            :y1="line.y1"
            :x2="line.x2"
            :y2="line.y2"
        />
        <ellipse
            v-else-if="entity.tool === 'circle'"
            :cx="entity.rect.left + entity.rect.width / 2"
            :cy="entity.rect.top + entity.rect.height / 2"
            :rx="Math.abs(entity.rect.width / 2)"
            :ry="Math.abs(entity.rect.height / 2)"
        />
        <polyline
            v-else-if="entity.tool === 'draw' && points.length > 1"
            :points="points"
        />
        <rect
            v-else
            :x="entity.rect.left"
            :y="entity.rect.top"
            :width="entity.rect.width"
            :height="entity.rect.height"
        />
    </g>
</template>

<script setup lang="ts">
import type { IShapeEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { toPdfScaledCssLength } from '@app/modules/pdf-viewer/engine/pdf-page-scale/pdfPageScale';

const props = defineProps<{
    entity: IShapeEntity;
    selected: boolean;
}>();

const points = computed(() => (
    props.entity.points ?? props.entity.strokes?.[0] ?? []
).map(point => `${point.x},${point.y}`).join(' '));

const line = computed(() => {
    const first = props.entity.points?.[0];
    const last = props.entity.points?.at(-1);
    return {
        x1: first?.x ?? props.entity.rect.left,
        y1: first?.y ?? props.entity.rect.top,
        x2: last?.x ?? props.entity.rect.left + props.entity.rect.width,
        y2: last?.y ?? props.entity.rect.top + props.entity.rect.height,
    };
});

const shapeStyle = computed(() => ({
    '--annotation-stroke': props.entity.strokeColor,
    '--annotation-fill': props.entity.fill ?? 'transparent',
    '--annotation-opacity': String(props.entity.opacity),
    '--annotation-stroke-width': toPdfScaledCssLength(props.entity.strokeWidth),
}));
</script>
