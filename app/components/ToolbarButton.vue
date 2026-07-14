<template>
    <AppTooltip :delay-duration="1200">
        <UButton
            type="button"
            class="toolbar-btn"
            :class="{
                'is-toggle': active != null,
                'is-active': active,
                'is-grouped': grouped,
                'is-loading': loading,
            }"
            :disabled="disabled"
            :icon="hasDefaultSlot ? undefined : icon"
            :loading="loading"
            loading-icon="ph:circle-notch"
            variant="ghost"
            color="neutral"
            square
            :aria-label="tooltip"
            :aria-pressed="active"
            :ui="{ leadingIcon: iconClass }"
            @click="handleClick"
        >
            <span v-if="hasDefaultSlot && !loading" :class="iconClass">
                <slot />
            </span>
        </UButton>

        <template #content>
            <span class="toolbar-tooltip-label">{{ tooltip }}</span>
            <span
                v-if="shortcutLabel"
                class="toolbar-tooltip-shortcut"
                aria-hidden="true"
            >
                {{ shortcutLabel }}
            </span>
        </template>
    </AppTooltip>
</template>

<script setup lang="ts">
const {
    icon,
    tooltip,
    shortcut = '',
    active = undefined,
    disabled = false,
    loading = false,
    grouped = false,
    iconClass = 'size-5',
} = defineProps<{
    icon: string;
    tooltip: string;
    shortcut?: string;
    active?: boolean;
    disabled?: boolean;
    loading?: boolean;
    grouped?: boolean;
    iconClass?: string;
}>();

const emit = defineEmits<{ click: [] }>();

const slots = useSlots();
const shortcutLabel = computed(() => shortcut.trim());
const hasDefaultSlot = computed(() => slots.default != null);

function handleClick() {
    emit('click');
}
</script>

<style scoped>
.toolbar-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--toolbar-control-height, var(--app-toolbar-control-size));
    height: var(--toolbar-control-height, var(--app-toolbar-control-size));
    padding: var(--app-toolbar-button-padding);
    border: 1px solid transparent;
    border-radius: var(--app-toolbar-button-radius);
    background: transparent;
    color: var(--app-toolbar-control-inactive-fg);
    cursor: pointer;
    transition:
        background-color var(--app-transition-fast),
        border-color var(--app-transition-fast),
        color var(--app-transition-fast),
        box-shadow var(--app-transition-fast);
}

.toolbar-btn.is-toggle {
    color: var(--app-toolbar-control-inactive-fg);
}

.toolbar-btn:hover {
    background: var(--app-toolbar-control-hover-bg);
    border-color: var(--app-toolbar-control-hover-border);
    color: var(--app-toolbar-control-hover-fg);
}

.toolbar-btn.is-toggle:hover {
    color: var(--app-toolbar-control-hover-fg);
}

.toolbar-btn.is-active {
    background: var(--app-toolbar-control-active-bg);
    border-color: var(--app-toolbar-control-active-border);
    box-shadow: var(--app-toolbar-control-active-shadow);
    color: var(--app-toolbar-control-hover-fg);
}

.toolbar-btn.is-active:hover {
    background: var(--app-toolbar-control-active-hover-bg);
    border-color: var(--app-toolbar-control-active-hover-border);
}

.toolbar-btn:focus {
    outline: none;
}

.toolbar-btn:focus-visible {
    box-shadow: inset 0 0 0 1px var(--app-toolbar-focus-ring);
    position: relative;
    z-index: var(--app-z-local-raised);
}

.toolbar-btn:disabled {
    opacity: var(--app-toolbar-control-disabled-opacity);
    color: var(--app-toolbar-control-disabled-fg);
}

.toolbar-btn:disabled:hover {
    background: transparent;
    border-color: transparent;
    color: var(--app-toolbar-control-disabled-fg);
}

.toolbar-btn:disabled.is-active:hover {
    background: var(--app-toolbar-control-active-bg);
    border-color: var(--app-toolbar-control-active-border);
    box-shadow: var(--app-toolbar-control-active-shadow);
}

.toolbar-btn:disabled.is-loading {
    opacity: 1;
    color: var(--ui-text-muted);
    cursor: wait;
}

.toolbar-tooltip-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.toolbar-tooltip-shortcut {
    color: var(--ui-text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}
</style>
