<template>
    <main ref="workspaceMainRef" class="workspace-main">
        <div
            v-if="showSidebar"
            class="sidebar-wrapper"
            :style="sidebarWrapperStyle"
        >
            <slot name="sidebar" />
            <div
                class="sidebar-resizer"
                :class="{ 'is-active': isResizingSidebar }"
                role="separator"
                aria-orientation="vertical"
                :aria-label="resizeAriaLabel"
                @pointerdown.prevent="handleResizeStart"
            />
        </div>
        <div class="workspace-main__viewer">
            <slot />
        </div>
    </main>
</template>

<script setup lang="ts">
import type { CSSProperties } from 'vue';
import { useResizeObserver } from '@vueuse/core';
import { BrowserLogger } from '@app/utils/browserLogger';

const {
    isResizingSidebar,
    showSidebar,
    sidebarWrapperStyle = undefined,
} = defineProps<{
    showSidebar: boolean;
    sidebarWrapperStyle?: CSSProperties | null;
    isResizingSidebar: boolean;
    resizeAriaLabel: string;
}>();

const emit = defineEmits<{
    'resize-start': [event: PointerEvent];
    'container-resize': [width: number];
}>();
const workspaceMainRef = useTemplateRef<HTMLElement>('workspaceMainRef');

useResizeObserver(workspaceMainRef, (entries) => {
    const width = entries[0]?.contentRect.width;
    if (width !== undefined) {
        emit('container-resize', width);
    }
});

function handleResizeStart(event: PointerEvent) {
    emit('resize-start', event);
}

watch(
    () => [
        showSidebar,
        sidebarWrapperStyle?.width,
        isResizingSidebar,
    ] as const,
    ([
        nextShowSidebar,
        nextWidth,
        nextResizing,
    ], previousState) => {
        const [
            prevShowSidebar,
            prevWidth,
            prevResizing,
        ] = previousState ?? [
            nextShowSidebar,
            nextWidth,
            nextResizing,
        ];
        if (
            nextShowSidebar === prevShowSidebar
            && nextWidth === prevWidth
            && nextResizing === prevResizing
        ) {
            return;
        }
        BrowserLogger.diagnostic('pdf-nav', `[sidebar-host] show=${nextShowSidebar} width=${String(nextWidth)} resizing=${nextResizing}`, {
            showSidebar: {
                previous: prevShowSidebar,
                next: nextShowSidebar, 
            },
            sidebarWidth: {
                previous: prevWidth ?? null,
                next: nextWidth ?? null, 
            },
            isResizingSidebar: {
                previous: prevResizing,
                next: nextResizing, 
            },
        });
    },
    { immediate: true },
);
</script>

<style scoped>
.workspace-main {
    flex: 1;
    overflow: hidden;
    display: flex;
    position: relative;
    min-width: 0;
    min-height: 0;
}

.workspace-main__viewer {
    flex: 1;
    overflow: hidden;
    min-width: 0;
    min-height: 0;
}

.sidebar-wrapper {
    display: flex;
    height: 100%;
    min-width: 0;
    max-width: max(0px, calc(100% - var(--app-sidebar-min-viewer-width)));
    background: var(--app-sidebar-bg);
}

.sidebar-resizer {
    width: var(--app-editor-sash-width);
    margin-inline-start: auto;
    cursor: col-resize;
    position: relative;
    flex-shrink: 0;
    user-select: none;
    touch-action: none;
    background: var(--app-editor-sash-bg);
    transition: background-color 0.12s ease;
}

.sidebar-resizer:hover,
.sidebar-resizer.is-active {
    background: var(--app-editor-sash-bg-hover);
}
</style>
