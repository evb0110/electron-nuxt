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
                name="i-ph-gauge"
                class="assistant-switcher-trigger-icon"
            />
            <span class="assistant-switcher-trigger-value">{{ effortLabel(selectedEffort) }}</span>
            <UIcon
                name="i-ph-caret-up-down"
                class="assistant-switcher-trigger-caret"
            />
        </button>

        <template #content>
            <div class="assistant-switcher-menu app-floating-scroll-region app-scrollbar">
                <span class="assistant-switcher-heading">{{ t('assistant.reasoning') }}</span>
                <div
                    class="assistant-switcher-list"
                    role="radiogroup"
                    :aria-label="t('assistant.reasoningEffort')"
                >
                    <button
                        v-for="effort in efforts"
                        :key="effort"
                        type="button"
                        :class="[
                            'assistant-switcher-option',
                            { 'is-active': effort === selectedEffort },
                        ]"
                        role="radio"
                        :aria-checked="effort === selectedEffort"
                        :aria-disabled="disabled"
                        :disabled="disabled"
                        @click="onSelect(effort)"
                    >
                        <span class="assistant-switcher-option-label">{{ effortLabel(effort) }}</span>
                        <UIcon
                            v-if="effort === selectedEffort"
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

<style scoped src="./AssistantSwitcherMenu.css"></style>
