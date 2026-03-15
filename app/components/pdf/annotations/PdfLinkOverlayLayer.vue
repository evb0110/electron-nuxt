<template>
    <div class="pdf-link-overlay-layer">
        <a
            v-for="link in links"
            :key="link.id"
            :href="link.url"
            class="pdf-link-overlay"
            :style="{
                left: `${link.rect.left * 100}%`,
                top: `${link.rect.top * 100}%`,
                width: `${link.rect.width * 100}%`,
                height: `${link.rect.height * 100}%`,
            }"
            target="_blank"
            rel="noopener noreferrer"
            @pointerdown="onPointerDown"
            @click.prevent="handleClick($event, link)"
        />
    </div>
</template>

<script setup lang="ts">
import type { ILinkAnnotation } from '@app/composables/pdf/annotations/types';
import { BrowserLogger } from '@app/utils/browser-logger';
import {
    hasElectronAPI,
    getElectronAPI,
} from '@app/utils/platform';

defineProps<{links: ILinkAnnotation[];}>();

const DRAG_THRESHOLD_PX = 5;
let pointerDownPos: {
    x: number;
    y: number 
} | null = null;

function onPointerDown(event: PointerEvent) {
    pointerDownPos = {
        x: event.clientX,
        y: event.clientY, 
    };
}

function handleClick(event: MouseEvent, link: ILinkAnnotation) {
    if (pointerDownPos) {
        const dx = event.clientX - pointerDownPos.x;
        const dy = event.clientY - pointerDownPos.y;
        if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
            pointerDownPos = null;
            return;
        }
    }
    pointerDownPos = null;
    if (hasElectronAPI()) {
        void getElectronAPI().shell.openExternal(link.url).catch((error) => {
            BrowserLogger.warn(
                'pdf-link-overlay',
                `Failed to open external link: ${link.url}`,
                error,
            );
        });
    } else {
        const openedWindow = window.open(link.url, '_blank', 'noopener,noreferrer');
        if (!openedWindow) {
            BrowserLogger.warn(
                'pdf-link-overlay',
                `Failed to open external link in browser: ${link.url}`,
            );
        }
    }
}
</script>

<style scoped>
.pdf-link-overlay-layer {
    position: absolute;
    inset: 0;
    z-index: 2;
    pointer-events: none;
}

.pdf-link-overlay {
    pointer-events: auto;
    display: block;
    position: absolute;
    background: var(--app-pdf-link-bg);
    transition: background 150ms ease;
    cursor: pointer;
}

.pdf-link-overlay:hover {
    background: var(--app-pdf-link-hover-bg);
}
</style>
