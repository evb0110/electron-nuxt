<template>
    <div
        v-if="active"
        class="crop-overlay is-active"
        @pointerdown="handlePointerDown"
        @pointermove="handlePointerMove"
        @pointerup="handlePointerUp"
        @pointercancel="emit('cancel')"
        @contextmenu="handleContextMenu"
        @wheel="handleWheel"
    >
        <div
            v-if="selectionRect"
            class="crop-selection"
            :style="selectionStyle"
        />
        <div v-if="!selectionRect" class="crop-hint">
            {{ hintLabel }}
        </div>
    </div>
</template>

<script setup lang="ts">
import type { CSSProperties } from 'vue';
import type {
    ILocalRect,
    ISnipPointerPayload,
} from '@app/composables/pdf/usePdfRegionSnip';

interface IProps {
    active: boolean;
    selectionRect: ILocalRect | null;
    hintLabel: string;
}

const props = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'pointer-start', payload: ISnipPointerPayload): void;
    (e: 'pointer-move', payload: ISnipPointerPayload): void;
    (e: 'pointer-end', payload: ISnipPointerPayload): void;
    (e: 'cancel'): void;
}>();

function buildPayload(event: PointerEvent): ISnipPointerPayload | null {
    const target = event.currentTarget as HTMLElement | null;
    if (!target) {
        return null;
    }

    const rect = target.getBoundingClientRect();
    return {
        clientX: event.clientX,
        clientY: event.clientY,
        overlayRect: {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
        },
    };
}

function handlePointerDown(event: PointerEvent) {
    if (!props.active || event.button !== 0) {
        return;
    }

    (event.currentTarget as HTMLElement | null)?.setPointerCapture(event.pointerId);
    const payload = buildPayload(event);
    if (payload) {
        emit('pointer-start', payload);
    }
}

function handlePointerMove(event: PointerEvent) {
    if (!props.active) {
        return;
    }
    const payload = buildPayload(event);
    if (payload) {
        emit('pointer-move', payload);
    }
}

function handlePointerUp(event: PointerEvent) {
    if (!props.active || event.button !== 0) {
        return;
    }
    const payload = buildPayload(event);
    if (payload) {
        emit('pointer-end', payload);
    }
}

function handleContextMenu(event: MouseEvent) {
    if (!props.active) {
        return;
    }
    event.preventDefault();
    emit('cancel');
}

function handleWheel(event: WheelEvent) {
    if (!props.active) {
        return;
    }
    event.preventDefault();
}

function rectStyle(rect: ILocalRect | null): CSSProperties {
    if (!rect) {
        return {};
    }
    return {
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
    };
}

const selectionStyle = computed(() => rectStyle(props.selectionRect));
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
