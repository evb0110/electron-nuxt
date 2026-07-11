<template>
    <UPopover
        v-model:open="open"
        mode="click"
        :content="content"
        portal="body"
    >
        <button
            type="button"
            class="assistant-speed-switcher-button"
            :aria-label="ariaLabel"
            :disabled="disabled"
        >
            <UIcon
                name="i-ph-lightning"
                class="assistant-speed-switcher-icon"
            />
            <span class="assistant-speed-switcher-value">{{ speedLabel(selectedMode) }}</span>
            <UIcon
                name="i-ph-caret-up-down"
                class="assistant-speed-switcher-indicator"
            />
        </button>

        <template #content>
            <div class="assistant-speed-switcher-menu">
                <span class="assistant-speed-switcher-section-label">{{ t('assistant.speed') }}</span>
                <div
                    class="assistant-speed-switcher-list"
                    role="radiogroup"
                    :aria-label="t('assistant.speedMode')"
                >
                    <button
                        v-for="mode in modes"
                        :key="mode"
                        type="button"
                        :class="[
                            'assistant-speed-switcher-option',
                            { 'is-active': mode === selectedMode },
                        ]"
                        role="radio"
                        :aria-checked="mode === selectedMode"
                        :aria-disabled="disabled"
                        :disabled="disabled"
                        @click="onSelect(mode)"
                    >
                        <span>{{ speedLabel(mode) }}</span>
                        <UIcon
                            v-if="mode === selectedMode"
                            name="i-ph-check"
                            class="assistant-speed-switcher-check"
                        />
                    </button>
                </div>
            </div>
        </template>
    </UPopover>
</template>

<script setup lang="ts">
import type { TAgentAssistantSpeedMode } from '@contracts/agent';

const {
    modes,
    selectedMode,
    side = 'top',
    disabled = false,
} = defineProps<{
    modes: readonly TAgentAssistantSpeedMode[];
    selectedMode: TAgentAssistantSpeedMode;
    side?: 'top' | 'bottom';
    disabled?: boolean;
}>();

const emit = defineEmits<{'select-mode': [mode: TAgentAssistantSpeedMode];}>();

const { t } = useTypedI18n();
const open = ref(false);
const content = computed(() => ({
    align: 'start' as const,
    side,
    sideOffset: 6,
    collisionPadding: 8,
}));

const SPEED_LABEL_KEYS = {
    fast: 'assistant.speedFast',
    standard: 'assistant.speedStandard',
} as const satisfies Record<TAgentAssistantSpeedMode, string>;

const ariaLabel = computed(() => t('assistant.speedModeAria', { label: speedLabel(selectedMode) }));

watch(() => disabled, (nextDisabled) => {
    if (nextDisabled) {
        open.value = false;
    }
});

function speedLabel(mode: TAgentAssistantSpeedMode) {
    return t(SPEED_LABEL_KEYS[mode]);
}

function onSelect(mode: TAgentAssistantSpeedMode) {
    if (disabled) {
        return;
    }
    emit('select-mode', mode);
    open.value = false;
}
</script>

<style scoped>
.assistant-speed-switcher-button {
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

.assistant-speed-switcher-button:hover:not(:disabled) {
    background: var(--app-toolbar-control-hover-bg);
    border-color: var(--app-toolbar-control-hover-border);
}

.assistant-speed-switcher-button:focus {
    outline: none;
}

.assistant-speed-switcher-button:focus-visible {
    box-shadow: inset 0 0 0 1px var(--app-toolbar-focus-ring);
}

.assistant-speed-switcher-button:disabled {
    opacity: var(--app-toolbar-control-disabled-opacity);
    cursor: default;
}

.assistant-speed-switcher-icon,
.assistant-speed-switcher-indicator {
    flex: 0 0 auto;
    width: 0.9rem;
    height: 0.9rem;
    color: var(--ui-text-muted);
}

.assistant-speed-switcher-value {
    min-width: 0;
    overflow: hidden;
    font-weight: var(--app-font-weight-semibold);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.assistant-speed-switcher-menu {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    width: min(12rem, var(--app-overlay-viewport-width));
    max-width: var(--app-overlay-viewport-width);
    padding: var(--app-space-md);
    background: var(--app-toolbar-group-bg);
    user-select: none;
}

.assistant-speed-switcher-section-label {
    padding: 0 var(--app-space-2xs);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-micro);
    font-weight: var(--app-font-weight-semibold);
    line-height: var(--app-line-height-tight);
    text-transform: uppercase;
}

.assistant-speed-switcher-list {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
}

.assistant-speed-switcher-option {
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

.assistant-speed-switcher-option:hover:not(:disabled) {
    background: var(--app-toolbar-control-hover-bg);
}

.assistant-speed-switcher-option:focus {
    outline: none;
}

.assistant-speed-switcher-option:focus-visible {
    box-shadow: inset 0 0 0 1px var(--app-toolbar-focus-ring);
}

.assistant-speed-switcher-option.is-active {
    background: var(--app-toolbar-control-hover-bg);
    font-weight: var(--app-font-weight-semibold);
}

.assistant-speed-switcher-option:disabled {
    cursor: default;
}

.assistant-speed-switcher-check {
    flex: 0 0 auto;
    width: 0.95rem;
    height: 0.95rem;
    color: var(--ui-primary);
}
</style>
