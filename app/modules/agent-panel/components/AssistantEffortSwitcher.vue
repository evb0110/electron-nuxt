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
            <div class="assistant-effort-switcher-menu app-floating-scroll-region app-scrollbar app-scroll-region--balanced">
                <span class="assistant-effort-switcher-section-label">{{ t('assistant.reasoning') }}</span>
                <div
                    class="assistant-effort-switcher-list"
                    role="radiogroup"
                    :aria-label="t('assistant.reasoningEffort')"
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
                        :aria-disabled="disabled"
                        :disabled="disabled"
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
import type {
    TAgentAssistantEffort,
    TAgentAssistantKnownEffort,
} from '@contracts/agent';
import { getAssistantEffortFallbackLabel } from '@contracts/agentModels';

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

const { t } = useTypedI18n();
const open = ref(false);
const content = computed(() => ({
    align: 'start' as const,
    side,
    sideOffset: 6,
    collisionPadding: 8,
}));

const EFFORT_LABEL_KEYS = {
    low: 'assistant.effortLow',
    medium: 'assistant.effortMedium',
    high: 'assistant.effortHigh',
    xhigh: 'assistant.effortXHigh',
    max: 'assistant.effortMax',
} as const satisfies Record<TAgentAssistantKnownEffort, string>;

const ariaLabel = computed(() => t('assistant.reasoningEffortAria', { label: effortLabel(selectedEffort) }));

watch(() => disabled, (nextDisabled) => {
    if (nextDisabled) {
        open.value = false;
    }
});

function effortLabel(effort: TAgentAssistantEffort) {
    if (isKnownEffort(effort)) {
        return t(EFFORT_LABEL_KEYS[effort]);
    }
    return getAssistantEffortFallbackLabel(effort);
}

function onSelect(effort: TAgentAssistantEffort) {
    if (disabled) {
        return;
    }
    emit('select-effort', effort);
    open.value = false;
}

function isKnownEffort(effort: TAgentAssistantEffort): effort is TAgentAssistantKnownEffort {
    return Object.prototype.hasOwnProperty.call(EFFORT_LABEL_KEYS, effort);
}
</script>

<style scoped>
.assistant-effort-switcher-button {
    display: inline-flex;
    align-items: center;
    gap: var(--app-space-sm);
    max-width: 100%;
    min-width: 0;
    height: var(--app-assistant-control-height);
    padding: 0 var(--app-space-2xl);
    border: 1px solid var(--app-toolbar-group-border);
    border-radius: var(--app-radius-md);
    background: var(--app-toolbar-group-bg);
    color: var(--ui-text);
    font-size: var(--app-text-size-body-sm);
    line-height: var(--app-line-height-tight);
    cursor: pointer;
    user-select: none;
    transition:
        background-color var(--app-transition-fast),
        border-color var(--app-transition-fast),
        box-shadow var(--app-transition-fast);
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
    font-weight: var(--app-font-weight-semibold);
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
    padding: var(--app-space-md);
    background: var(--app-toolbar-group-bg);
    user-select: none;
}

.assistant-effort-switcher-section-label {
    padding: 0 var(--app-space-2xs);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-micro);
    font-weight: var(--app-font-weight-semibold);
    line-height: var(--app-line-height-tight);
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
    gap: var(--app-space-3xl);
    min-height: var(--app-assistant-control-height);
    min-width: 0;
    padding: 0 var(--app-space-3xl);
    border-radius: var(--app-radius-sm);
    color: var(--ui-text);
    font-size: var(--app-text-size-body-sm);
    line-height: 1.15;
    text-align: left;
    cursor: pointer;
    transition: background-color var(--app-transition-fast);
}

.assistant-effort-switcher-option:hover:not(:disabled) {
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
    font-weight: var(--app-font-weight-semibold);
}

.assistant-effort-switcher-option:disabled {
    cursor: default;
}

.assistant-effort-switcher-check {
    flex: 0 0 auto;
    width: 0.95rem;
    height: 0.95rem;
    color: var(--ui-primary);
}
</style>
