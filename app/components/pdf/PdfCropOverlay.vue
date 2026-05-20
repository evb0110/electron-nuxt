<template>
    <div
        v-if="props.active"
        class="crop-overlay is-active"
        @pointerdown="handlePointerDown"
        @pointermove="handlePointerMove"
        @pointerup="handlePointerUp"
        @pointercancel="cancelSelection"
        @contextmenu="handleContextMenu"
        @wheel="handleWheel"
    >
        <div
            v-if="props.selectionRect"
            class="crop-selection"
            :style="selectionStyle"
        />
        <div v-if="!props.selectionRect" class="crop-hint">
            {{ props.hintLabel }}
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    type IRegionSelectionOverlayBaseProps,
    type IRegionSelectionOverlayEmits,
    regionRectStyle,
    useEmittedPdfRegionSelectionOverlay,
} from '@app/composables/pdf/usePdfRegionSelectionOverlay';

const props = defineProps<IRegionSelectionOverlayBaseProps>();
const emit = defineEmits<IRegionSelectionOverlayEmits>();

const {
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleContextMenu,
    handleWheel,
} = useEmittedPdfRegionSelectionOverlay(props, emit);

const selectionStyle = computed(() => regionRectStyle(props.selectionRect));

function cancelSelection() {
    emit('cancel');
}
</script>

<style scoped>
.crop-overlay {
    position: absolute;
    inset: 0;
    z-index: 50;
    overflow: hidden;
    pointer-events: none;
    user-select: none;
}

.crop-overlay.is-active {
    pointer-events: auto;
    cursor: crosshair;
}

.crop-selection {
    position: absolute;
    box-sizing: border-box;
    border-radius: var(--app-crop-selection-radius);
    border: var(--app-crop-selection-border-width) solid var(--app-crop-selection-border);
    box-shadow: 0 0 0 9999px var(--app-crop-cutout-fill);
}

.crop-hint {
    position: absolute;
    top: var(--app-crop-hint-offset-top);
    left: 50%;
    transform: translateX(-50%);
    padding: var(--app-crop-hint-padding);
    border-radius: var(--app-crop-hint-radius);
    border: 1px solid var(--app-crop-hint-border);
    background: var(--app-crop-hint-bg);
    color: var(--app-crop-hint-fg);
    font-size: var(--app-crop-hint-font-size);
    line-height: 1;
    pointer-events: none;
    animation: crop-hint-enter 180ms ease-out;
}

@keyframes crop-hint-enter {
    from {
        opacity: 0;
        transform: translateX(-50%) translateY(-4px);
    }

    to {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
    }
}
</style>
