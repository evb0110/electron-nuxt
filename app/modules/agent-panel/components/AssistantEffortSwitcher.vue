<template>
    <UPopover
        v-model:open="open"
        mode="click"
        :content="content"
        portal="body"
    >
        <button
            type="button"
            class="assistant-effort-switcher-button"
            :aria-label="ariaLabel"
            :disabled="disabled"
        >
            <UIcon
                name="i-ph-gauge"
                class="assistant-effort-switcher-icon"
            />
            <span class="assistant-effort-switcher-value">{{ effortLabel(selectedEffort) }}</span>
            <UIcon
                name="i-ph-caret-up-down"
                class="assistant-effort-switcher-indicator"
            />
        </button>

        <template #content>
            <div class="assistant-effort-switcher-menu">
                <span class="assistant-effort-switcher-section-label">Reasoning</span>
                <div
                    class="assistant-effort-switcher-list"
                    role="radiogroup"
                    aria-label="Reasoning effort"
                >
                    <button
                        v-for="effort in efforts"
                        :key="effort"
                        type="button"
                        :class="[
                            'assistant-effort-switcher-option',
                            { 'is-active': effort === selectedEffort },
                        ]"
                        role="radio"
                        :aria-checked="effort === selectedEffort"
                        @click="onSelect(effort)"
                    >
                        <span>{{ effortLabel(effort) }}</span>
                        <UIcon
                            v-if="effort === selectedEffort"
                            name="i-ph-check"
                            class="assistant-effort-switcher-check"
                        />
                    </button>
                </div>
            </div>
        </template>
    </UPopover>
</template>

<script setup lang="ts">
import type { TAgentAssistantEffort } from '@contracts/agent';

const {
    efforts,
    selectedEffort,
    side = 'top',
    disabled = false,
} = defineProps<{
    efforts: readonly TAgentAssistantEffort[];
    selectedEffort: TAgentAssistantEffort;
    side?: 'top' | 'bottom';
    disabled?: boolean;
}>();

const emit = defineEmits<{'select-effort': [effort: TAgentAssistantEffort];}>();

const open = ref(false);
const content = computed(() => ({
    align: 'start' as const,
    side,
    sideOffset: 6,
    collisionPadding: 8,
}));

const EFFORT_LABELS = {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra High',
    max: 'Max',
} as const satisfies Record<TAgentAssistantEffort, string>;

const ariaLabel = computed(() => `Reasoning effort: ${effortLabel(selectedEffort)}`);

function effortLabel(effort: TAgentAssistantEffort) {
    return EFFORT_LABELS[effort];
}

function onSelect(effort: TAgentAssistantEffort) {
    emit('select-effort', effort);
    open.value = false;
}
</script>

<style scoped>
.assistant-effort-switcher-button {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    max-width: 100%;
    min-width: 0;
    height: 1.85rem;
    padding: 0 0.45rem;
    border: 1px solid var(--app-toolbar-group-border);
    border-radius: 6px;
    background: var(--app-toolbar-group-bg);
    color: var(--ui-text);
    font-size: 0.8125rem;
    line-height: 1;
    cursor: pointer;
    user-select: none;
    transition:
        background-color 0.1s ease,
        border-color 0.1s ease,
        box-shadow 0.1s ease;
}

.assistant-effort-switcher-button:hover:not(:disabled) {
    background: var(--app-toolbar-control-hover-bg);
    border-color: var(--app-toolbar-control-hover-border);
}

.assistant-effort-switcher-button:focus {
    outline: none;
}

.assistant-effort-switcher-button:focus-visible {
    box-shadow: inset 0 0 0 1px var(--app-toolbar-focus-ring);
}

.assistant-effort-switcher-button:disabled {
    opacity: var(--app-toolbar-control-disabled-opacity);
    cursor: default;
}

.assistant-effort-switcher-icon {
    flex: 0 0 auto;
    width: 0.9rem;
    height: 0.9rem;
    color: var(--ui-text-muted);
}

.assistant-effort-switcher-value {
    min-width: 0;
    overflow: hidden;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.assistant-effort-switcher-indicator {
    flex: 0 0 auto;
    width: 0.9rem;
    height: 0.9rem;
    color: var(--ui-text-muted);
}

.assistant-effort-switcher-menu {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    width: min(12rem, var(--app-overlay-viewport-width));
    max-width: var(--app-overlay-viewport-width);
    padding: 0.35rem;
    background: var(--app-toolbar-group-bg);
    user-select: none;
}

.assistant-effort-switcher-section-label {
    padding: 0 0.15rem;
    color: var(--ui-text-muted);
    font-size: 0.6875rem;
    font-weight: 600;
    line-height: 1;
    text-transform: uppercase;
}

.assistant-effort-switcher-list {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
}

.assistant-effort-switcher-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    min-height: 1.85rem;
    min-width: 0;
    padding: 0 0.5rem;
    border-radius: 5px;
    color: var(--ui-text);
    font-size: 0.8125rem;
    line-height: 1.15;
    text-align: left;
    cursor: pointer;
    transition: background-color 0.1s ease;
}

.assistant-effort-switcher-option:hover {
    background: var(--app-toolbar-control-hover-bg);
}

.assistant-effort-switcher-option:focus {
    outline: none;
}

.assistant-effort-switcher-option:focus-visible {
    box-shadow: inset 0 0 0 1px var(--app-toolbar-focus-ring);
}

.assistant-effort-switcher-option.is-active {
    background: var(--app-toolbar-control-hover-bg);
    font-weight: 600;
}

.assistant-effort-switcher-check {
    flex: 0 0 auto;
    width: 0.95rem;
    height: 0.95rem;
    color: var(--ui-primary);
}
</style>
