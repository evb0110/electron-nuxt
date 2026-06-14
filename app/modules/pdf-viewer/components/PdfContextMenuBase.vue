<template>
    <div
        v-if="visible"
        class="pdf-context-menu-base"
        :class="`pdf-context-menu-base--${variant}`"
        :style="resolvedStyle"
        @click.stop
    >
        <slot />
    </div>
</template>

<script setup lang="ts">

type TVariant = 'grid' | 'panel';

interface IProps {
    visible: boolean;
    style?: Record<string, string>;
    variant?: TVariant;
    zIndex?: number;
    minWidth?: string;
}

const {
    style: baseStyle = {},
    variant = 'grid',
    zIndex = 70,
    minWidth = '',
} = defineProps<IProps>();

const resolvedStyle = computed(() => {
    const style: Record<string, string> = {
        ...baseStyle,
        zIndex: String(zIndex),
    };

    if (minWidth) {
        style.minWidth = minWidth;
    }

    return style;
});
</script>

<style scoped>
.pdf-context-menu-base {
    position: fixed;
    box-sizing: border-box;
    width: max-content;
    max-width: var(--app-floating-panel-max-inline-size);
    border: 1px solid var(--app-pdf-context-menu-border);
    background: var(--app-pdf-context-menu-grid-bg);
    box-shadow: var(--app-pdf-context-menu-grid-shadow);
    color: var(--app-pdf-context-menu-item-fg);
}

.pdf-context-menu-base--grid {
    display: grid;
    gap: 1px;
}

.pdf-context-menu-base--panel {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    padding: 0.3rem;
    border-radius: 0.55rem;
    background: var(--app-pdf-context-menu-panel-bg);
    box-shadow: var(--app-pdf-context-menu-panel-shadow);
}

.pdf-context-menu-base :deep(.pdf-context-menu__section-title) {
    margin: 0;
    padding: 0.45rem 0.6rem 0.35rem;
    background: var(--app-pdf-context-menu-title-bg);
    color: var(--app-pdf-context-menu-title-fg);
    font-size: 0.64rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
    white-space: normal;
    overflow: hidden;
    overflow-wrap: anywhere;
}

.pdf-context-menu-base :deep(.pdf-context-menu__divider) {
    height: 1px;
    background: var(--app-pdf-context-menu-divider);
}

.pdf-context-menu-base--panel :deep(.pdf-context-menu__divider) {
    margin: 0.15rem 0.1rem;
}

.pdf-context-menu-base :deep(.pdf-context-menu__action) {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
    text-align: left;
    color: var(--app-pdf-context-menu-item-fg);
    white-space: normal;
    overflow: hidden;
    overflow-wrap: anywhere;
}

.pdf-context-menu-base--grid :deep(.pdf-context-menu__action) {
    border: none;
    background: var(--app-pdf-context-menu-item-bg);
    min-height: 2rem;
    padding: 0 0.6rem;
    cursor: pointer;
    font-size: 0.8125rem;
}

.pdf-context-menu-base--grid :deep(.pdf-context-menu__action:hover:not(:disabled)) {
    background: var(--app-pdf-context-menu-item-hover-bg);
}

.pdf-context-menu-base--grid :deep(.pdf-context-menu__action:disabled) {
    color: var(--app-pdf-context-menu-item-disabled-fg);
    background: var(--app-pdf-context-menu-item-disabled-bg);
    cursor: default;
}

.pdf-context-menu-base--panel :deep(.pdf-context-menu__action) {
    border: 1px solid transparent;
    border-radius: 0.4rem;
    background: transparent;
    color: var(--app-pdf-context-menu-panel-action-fg);
    font-size: 0.77rem;
    min-height: 0;
    padding: 0.35rem 0.45rem;
    cursor: pointer;
}

.pdf-context-menu-base--panel :deep(.pdf-context-menu__action:hover:not(:disabled)) {
    border-color: var(--app-pdf-context-menu-panel-action-border);
    background: var(--app-pdf-context-menu-panel-action-hover-bg);
}

.pdf-context-menu-base--panel :deep(.pdf-context-menu__action:disabled) {
    opacity: 0.5;
}

.pdf-context-menu-base :deep(.pdf-context-menu__action--danger) {
    color: var(--app-pdf-context-menu-danger-fg);
}

.pdf-context-menu-base :deep(.pdf-context-menu__icon) {
    width: 0.875rem;
    height: 0.875rem;
    flex-shrink: 0;
}
</style>
