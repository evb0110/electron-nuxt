<template>
    <UPopover
        v-model:open="open"
        mode="click"
        :content="content"
        portal="body"
    >
        <button
            type="button"
            class="assistant-switcher-trigger"
            :aria-label="ariaLabel"
            :disabled="disabled"
        >
            <UIcon
                name="i-ph-lightning"
                class="assistant-switcher-trigger-icon"
            />
            <span class="assistant-switcher-trigger-value">{{ speedLabel(selectedMode) }}</span>
            <UIcon
                name="i-ph-caret-up-down"
                class="assistant-switcher-trigger-caret"
            />
        </button>

        <template #content>
            <div class="assistant-switcher-menu">
                <span class="assistant-switcher-heading">{{ t('assistant.speed') }}</span>
                <div
                    class="assistant-switcher-list"
                    role="radiogroup"
                    :aria-label="t('assistant.speedMode')"
                >
                    <button
                        v-for="mode in modes"
                        :key="mode"
                        type="button"
                        :class="[
                            'assistant-switcher-option',
                            { 'is-active': mode === selectedMode },
                        ]"
                        role="radio"
                        :aria-checked="mode === selectedMode"
                        :aria-disabled="disabled"
                        :disabled="disabled"
                        @click="onSelect(mode)"
                    >
                        <span class="assistant-switcher-option-label">{{ speedLabel(mode) }}</span>
                        <UIcon
                            v-if="mode === selectedMode"
                            name="i-ph-check"
                            class="assistant-switcher-check"
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

<style scoped src="./AssistantSwitcherMenu.css"></style>
