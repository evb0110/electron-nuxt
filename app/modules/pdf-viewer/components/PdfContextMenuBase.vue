<template>
    <div
        v-if="visible"
        ref="menuElement"
        class="pdf-context-menu-base app-floating-scroll-region app-scrollbar app-scroll-region--balanced"
        :class="`pdf-context-menu-base--${variant}`"
        :style="resolvedStyle"
        role="menu"
        aria-orientation="vertical"
        :aria-label="accessibleLabel || t('toolbar.appMenu')"
        tabindex="-1"
        @click.stop
        @keydown="handleMenuKeydown"
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
    zIndex?: number | string;
    minWidth?: string;
    accessibleLabel?: string;
}

const {
    style: baseStyle = {},
    variant = 'grid',
    zIndex = 'var(--app-pdf-context-menu-z-index)',
    minWidth = '',
    accessibleLabel = '',
    visible,
} = defineProps<IProps>();

const resolvedStyle = computed(() => {
    const style: Record<string, string> = {
        ...baseStyle,
        zIndex: String(zIndex),
    };

    if (minWidth) {
        style.minInlineSize = `min(${minWidth}, var(--app-floating-panel-viewport-width))`;
    }

    return style;
});

const { t } = useTypedI18n();
const menuElement = ref<HTMLElement | null>(null);
let previouslyFocusedElement: HTMLElement | null = null;

function getMenuItems() {
    return Array.from(
        menuElement.value?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], [role="menuitem"], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
    ).filter(element => !element.hasAttribute('disabled') && !element.hasAttribute('aria-hidden'));
}

function focusMenuEntry() {
    (getMenuItems()[0] ?? menuElement.value)?.focus({preventScroll: true});
}

function handleMenuKeydown(event: KeyboardEvent) {
    if (![
        'ArrowDown',
        'ArrowUp',
        'Home',
        'End',
    ].includes(event.key)) {
        return;
    }

    const items = getMenuItems();
    if (items.length === 0) {
        event.preventDefault();
        menuElement.value?.focus({preventScroll: true});
        return;
    }

    event.preventDefault();
    const activeIndex = items.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
            ? items.length - 1
            : (activeIndex < 0 ? 0 : activeIndex + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[nextIndex]?.focus({preventScroll: true});
}

function containMenuFocus(event: FocusEvent) {
    const target = event.target;
    if (visible && target instanceof Node && !menuElement.value?.contains(target)) {
        focusMenuEntry();
    }
}

function restoreFocus() {
    const element = previouslyFocusedElement;
    previouslyFocusedElement = null;
    if (element?.isConnected) {
        void nextTick(() => element.focus({preventScroll: true}));
    }
}

watch(() => visible, (isVisible) => {
    if (!isVisible) {
        if (typeof document !== 'undefined') {
            document.removeEventListener('focusin', containMenuFocus);
        }
        restoreFocus();
        return;
    }

    if (typeof document !== 'undefined') {
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement && activeElement !== menuElement.value) {
            previouslyFocusedElement = activeElement;
        }
        document.addEventListener('focusin', containMenuFocus);
    }
    void nextTick(focusMenuEntry);
}, {
    flush: 'post',
    immediate: true,
});

onBeforeUnmount(() => {
    if (typeof document !== 'undefined') {
        document.removeEventListener('focusin', containMenuFocus);
    }
    restoreFocus();
});
</script>

<style scoped>
.pdf-context-menu-base {
    position: fixed;
    box-sizing: border-box;
    width: max-content;
    max-width: var(--app-floating-panel-max-inline-size);
    min-inline-size: min(var(--app-context-menu-preferred-width), var(--app-floating-panel-viewport-width));
    border: 1px solid var(--app-pdf-context-menu-border);
    border-radius: var(--app-context-menu-radius);
    background: var(--app-pdf-context-menu-item-bg);
    box-shadow: var(--app-pdf-context-menu-grid-shadow);
    color: var(--app-pdf-context-menu-item-fg);
}

.pdf-context-menu-base--grid {
    display: grid;
}

.pdf-context-menu-base--panel {
    display: flex;
    flex-direction: column;
    gap: var(--app-space-xs);
    padding: 0.3rem;
    border-radius: 0.55rem;
    background: var(--app-pdf-context-menu-panel-bg);
    box-shadow: var(--app-pdf-context-menu-panel-shadow);
}

.pdf-context-menu-base :deep(.pdf-context-menu__section-title) {
    margin: 0;
    padding: var(--app-space-4xl) var(--app-space-5xl) var(--app-space-md);
    color: var(--app-pdf-context-menu-title-fg);
    font-size: var(--app-text-size-menu-shortcut);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-weight: var(--app-font-weight-semibold);
    display: flex;
    align-items: center;
    gap: var(--app-space-md);
    min-width: 0;
    white-space: normal;
    overflow: hidden;
    overflow-wrap: anywhere;
}

.pdf-context-menu-base :deep(.pdf-context-menu__divider) {
    height: var(--app-hairline-height);
    background: var(--app-pdf-context-menu-divider);
}

.pdf-context-menu-base--panel :deep(.pdf-context-menu__divider) {
    margin: var(--app-space-2xs) 0.1rem;
}

.pdf-context-menu-base :deep(.pdf-context-menu__action) {
    display: flex;
    align-items: center;
    gap: var(--app-space-2xl);
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
    min-height: var(--app-control-height-sm);
    padding: 0 var(--app-space-5xl);
    cursor: pointer;
    font-size: var(--app-text-size-body-sm);
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
    border-radius: var(--app-radius-lg);
    background: transparent;
    color: var(--app-pdf-context-menu-panel-action-fg);
    font-size: var(--app-text-size-meta);
    min-height: 0;
    padding: var(--app-space-md) var(--app-space-2xl);
    cursor: pointer;
}

.pdf-context-menu-base--panel :deep(.pdf-context-menu__action:hover:not(:disabled)) {
    border-color: var(--app-pdf-context-menu-panel-action-border);
    background: var(--app-pdf-context-menu-panel-action-hover-bg);
}

.pdf-context-menu-base--panel :deep(.pdf-context-menu__action:disabled) {
    opacity: var(--app-opacity-disabled);
}

.pdf-context-menu-base :deep(.pdf-context-menu__action--danger) {
    color: var(--app-pdf-context-menu-danger-fg);
}

.pdf-context-menu-base :deep(.pdf-context-menu__icon) {
    width: var(--app-icon-size-xs);
    height: var(--app-icon-size-xs);
    flex-shrink: 0;
}
</style>
