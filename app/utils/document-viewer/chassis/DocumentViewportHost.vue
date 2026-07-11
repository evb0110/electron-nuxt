<template>
    <div
        :id="viewportId"
        :ref="setViewportElement"
        data-document-viewer-chassis-viewport
        @scroll.passive="emit('scroll', $event)"
        @wheel="emit('wheel', $event)"
        @mousedown="emit('mousedown', $event)"
        @mousemove="emit('mousemove', $event)"
        @mouseup="emit('mouseup', $event)"
        @mouseleave="emit('mouseleave')"
        @click="emit('click', $event)"
        @dblclick="emit('dblclick', $event)"
        @contextmenu="emit('contextmenu', $event)"
        @selectstart="emit('selectstart', $event)"
    >
        <slot />
    </div>
</template>

<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';

const {
    setViewport,
    viewportId = undefined,
} = defineProps<{
    setViewport: (element: HTMLElement | null) => void;
    viewportId?: string | undefined;
}>();

const emit = defineEmits<{
    scroll: [event: Event];
    wheel: [event: WheelEvent];
    mousedown: [event: MouseEvent];
    mousemove: [event: MouseEvent];
    mouseup: [event: MouseEvent];
    mouseleave: [];
    click: [event: MouseEvent];
    dblclick: [event: MouseEvent];
    contextmenu: [event: MouseEvent];
    selectstart: [event: Event];
}>();

function setViewportElement(element: Element | ComponentPublicInstance | null) {
    setViewport(element instanceof HTMLElement ? element : null);
}
</script>
