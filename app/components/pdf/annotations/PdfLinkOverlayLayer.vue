<template>
    <div class="pdf-link-overlay-layer">
        <a
            v-for="link in links"
            :key="link.id"
            class="pdf-link-overlay"
            role="link"
            tabindex="0"
            :data-href="link.url"
            :style="{
                left: `${link.rect.left * 100}%`,
                top: `${link.rect.top * 100}%`,
                width: `${link.rect.width * 100}%`,
                height: `${link.rect.height * 100}%`,
            }"
            @pointerdown="onPointerDown"
            @click.prevent="handleClick($event, link)"
            @auxclick.prevent
            @contextmenu.prevent
            @keydown.enter.prevent="openLink(link.url)"
            @keydown.space.prevent="openLink(link.url)"
        />
    </div>
</template>

<script setup lang="ts">
import type { ILinkAnnotation } from '@app/types/annotations';
import { BrowserLogger } from '@app/utils/browser-logger';
import { getShellCapability } from '@app/utils/platform-shell';
import { normalizeAllowedExternalUrl } from '@contracts/external-url';

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

function openLink(url: string) {
    const normalizedUrl = normalizeAllowedExternalUrl(url);
    if (!normalizedUrl) {
        BrowserLogger.warn('pdf-link-overlay', `Blocked unsupported external link: ${url}`);
        return;
    }

    void getShellCapability().openExternal(normalizedUrl).catch((error) => {
        BrowserLogger.warn(
            'pdf-link-overlay',
            `Failed to open external link: ${normalizedUrl}`,
            error,
        );
    });
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
    openLink(link.url);
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
