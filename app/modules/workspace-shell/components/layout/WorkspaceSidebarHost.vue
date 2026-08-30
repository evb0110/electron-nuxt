<template>
    <main ref="workspaceMainRef" class="workspace-main">
        <div
            class="sidebar-wrapper"
            :class="{
                'is-closed': !showSidebar,
                'is-resizing': isResizingSidebar,
            }"
            :style="sidebarPresentationStyle"
            :aria-hidden="showSidebar ? undefined : 'true'"
            :inert="showSidebar ? undefined : true"
        >
            <div class="sidebar-wrapper__content" :style="sidebarContentStyle">
                <slot name="sidebar" />
            </div>
            <div
                v-show="showSidebar"
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
    sidebarContentWidth,
    sidebarWrapperStyle = undefined,
} = defineProps<{
    showSidebar: boolean;
    sidebarContentWidth: number;
    sidebarWrapperStyle?: CSSProperties | null;
    isResizingSidebar: boolean;
    resizeAriaLabel: string;
}>();

const emit = defineEmits<{
    'resize-start': [event: PointerEvent];
    'container-resize': [width: number];
}>();
const workspaceMainRef = useTemplateRef<HTMLElement>('workspaceMainRef');
const sidebarPresentationStyle = computed<CSSProperties>(() => ({
    ...(sidebarWrapperStyle ?? {}),
    width: showSidebar ? sidebarWrapperStyle?.width : '0px',
}));
/**
 * The wrapper animates its own width open and closed. The panel inside jumps
 * straight to its open width so the tab bar, the thumbnail rail and everything
 * else lay out once instead of reflowing and re-rasterizing on every frame of
 * the slide. Collapsing back to zero is delayed by the stylesheet until the
 * closing slide has finished, which keeps hidden panels from measuring as
 * visible.
 */
const sidebarContentStyle = computed<CSSProperties>(() => (
    {width: showSidebar ? `${String(sidebarContentWidth)}px` : '0px'}
));

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
    max-width: 100%;
    flex-shrink: 0;
    overflow: hidden;
    background: var(--app-sidebar-bg);
    transition: width var(--app-transition-reorder);
}

.sidebar-wrapper__content {
    display: flex;
    height: 100%;
    flex: 0 0 auto;
    overflow: hidden;
    transition: width 0s;
}

.sidebar-wrapper.is-closed .sidebar-wrapper__content {
    transition: width 0s var(--app-transition-reorder-duration);
}

.sidebar-wrapper.is-resizing .sidebar-wrapper__content {
    transition: none;
}

.sidebar-wrapper.is-closed {
    pointer-events: none;
}

.sidebar-wrapper.is-resizing {
    transition: none;
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

@media (prefers-reduced-motion: reduce) {
    .sidebar-wrapper,
    .sidebar-wrapper.is-closed .sidebar-wrapper__content {
        transition: none;
    }
}
</style>
