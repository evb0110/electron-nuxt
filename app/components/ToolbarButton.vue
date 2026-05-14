<template>
    <AppTooltip :delay-duration="1200">
        <button
            class="toolbar-btn"
            :class="{
                'is-toggle': active != null,
                'is-active': active,
                'is-grouped': grouped,
                'is-loading': loading,
            }"
            :disabled="disabled || loading"
            :aria-label="tooltip"
            :aria-pressed="active"
            @click="handleClick"
        >
            <span v-if="!loading" :class="iconClass">
                <slot>
                    <Icon :name="icon" class="size-full" />
                </slot>
            </span>
            <Icon v-else name="ph:circle-notch" :class="[iconClass, 'animate-spin']" />
        </button>

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

const shortcutLabel = computed(() => shortcut.trim());

function handleClick() {
    emit('click');
}
</script>

<style scoped>
.toolbar-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--toolbar-control-height);
    height: var(--toolbar-control-height);
    padding: 0.32rem;
    border: 1px solid transparent;
    border-radius: 0.4375rem;
    background: transparent;
    color: var(--app-toolbar-control-inactive-fg);
    cursor: pointer;
    transition: background-color 0.1s ease, border-color 0.1s ease, color 0.1s ease, box-shadow 0.1s ease;
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
    z-index: 1;
}

.toolbar-btn:disabled {
    opacity: var(--app-toolbar-control-disabled-opacity);
    color: var(--app-toolbar-control-disabled-fg);
    cursor: not-allowed;
}

.toolbar-btn:disabled:hover {
    background: transparent;
    border-color: transparent;
    color: var(--app-toolbar-control-disabled-fg);
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
