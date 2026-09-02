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
            :aria-disabled="disabled"
            :disabled="disabled"
        >
            <AssistantProviderIcon
                :provider="selectedProvider"
                class="assistant-switcher-trigger-icon"
            />
            <span class="assistant-switcher-trigger-value">{{ activeModelDisplayLabel }}</span>
            <UIcon
                :name="isSwitching ? 'i-ph-circle-notch' : 'i-ph-caret-up-down'"
                :class="[
                    'assistant-switcher-trigger-caret',
                    { 'is-spinning': isSwitching },
                ]"
            />
        </button>

        <template #content>
            <div class="assistant-switcher-menu assistant-model-menu app-floating-scroll-region app-scrollbar app-scroll-region--balanced">
                <span class="assistant-switcher-heading">{{ t('assistant.providerHeading') }}</span>
                <div
                    class="assistant-model-providers"
                    role="tablist"
                    :aria-label="t('assistant.provider')"
                >
                    <button
                        v-for="provider in providerItems"
                        :key="provider.value"
                        type="button"
                        :class="[
                            'assistant-model-provider',
                            { 'is-active': isSelectedProvider(provider.value) },
                        ]"
                        role="tab"
                        :aria-selected="isSelectedProvider(provider.value)"
                        :aria-disabled="disabled"
                        :disabled="disabled"
                        @click="onSelectProvider(provider.value)"
                    >
                        <AssistantProviderIcon
                            :provider="provider.value"
                            class="assistant-model-provider-icon"
                        />
                        <span class="assistant-model-provider-label">{{ provider.label }}</span>
                    </button>
                </div>

                <span class="assistant-switcher-heading">{{ t('assistant.modelHeading') }}</span>
                <div
                    class="assistant-switcher-list"
                    role="radiogroup"
                    :aria-label="t('assistant.model')"
                >
                    <button
                        v-for="model in modelItems"
                        :key="model.value"
                        type="button"
                        :class="[
                            'assistant-switcher-option',
                            { 'is-active': isSelectedModel(model.value) },
                        ]"
                        role="radio"
                        :aria-checked="isSelectedModel(model.value)"
                        :aria-disabled="disabled"
                        :disabled="disabled"
                        @click="onSelectModel(model.value)"
                    >
                        <span class="assistant-switcher-option-label">{{ model.displayLabel }}</span>
                        <span
                            v-if="model.isRecommended"
                            class="assistant-model-recommended"
                        >{{ t('assistant.modelRecommended') }}</span>
                        <UIcon
                            v-if="isSelectedModel(model.value)"
                            name="i-ph-check"
                            class="assistant-switcher-check"
                        />
                    </button>
                </div>

                <p class="assistant-switcher-hint">{{ t('assistant.modelPickerHint') }}</p>
            </div>
        </template>
    </UPopover>
</template>

<script setup lang="ts">
import type {
    IAgentAssistantProviderStatus,
    TAgentAssistantProviderId,
} from '@contracts/agent';
import AssistantProviderIcon from '@app/modules/agent-panel/components/AssistantProviderIcon.vue';

const {
    providers,
    selectedProvider,
    selectedModel,
    isSwitching = false,
    side = 'top',
    disabled = false,
} = defineProps<{
    providers: readonly IAgentAssistantProviderStatus[];
    selectedProvider: TAgentAssistantProviderId;
    selectedModel: string;
    isSwitching?: boolean;
    side?: 'top' | 'bottom';
    disabled?: boolean;
}>();

const emit = defineEmits<{
    'select-provider': [provider: TAgentAssistantProviderId];
    'select-model': [model: string];
}>();

const { t } = useTypedI18n();
const open = ref(false);
const content = computed(() => ({
    align: 'start' as const,
    side,
    sideOffset: 6,
    collisionPadding: 8,
}));

const providerItems = computed(() => providers.map(provider => ({
    value: provider.id,
    label: provider.label,
})));
const activeProvider = computed(() => (
    providers.find(provider => provider.id === selectedProvider)
    ?? providers[0]
    ?? null
));
const modelItems = computed(() => (activeProvider.value?.models ?? []).map(model => ({
    value: model.id,
    label: model.label,
    displayLabel: trimProviderPrefix(model.label, activeProviderLabel.value),
    isRecommended: model.id === activeProvider.value?.defaultModel,
})));
const activeProviderLabel = computed(() => activeProvider.value?.label ?? selectedProvider);
const activeModelOption = computed(() => (
    modelItems.value.find(model => model.value === selectedModel)
    ?? null
));
const activeModelLabel = computed(() => activeModelOption.value?.label ?? selectedModel);
const activeModelDisplayLabel = computed(() => (
    activeModelOption.value?.displayLabel
    ?? trimProviderPrefix(activeModelLabel.value, activeProviderLabel.value)
));
const ariaLabel = computed(() => (
    `${t('assistant.provider')}: ${activeProviderLabel.value}. `
    + `${t('assistant.model')}: ${activeModelLabel.value}`
));

watch(() => disabled, (nextDisabled) => {
    if (nextDisabled) {
        open.value = false;
    }
});

function isSelectedProvider(provider: TAgentAssistantProviderId) {
    return provider === selectedProvider;
}

function isSelectedModel(model: string) {
    return model === selectedModel;
}

function trimProviderPrefix(label: string, providerLabel: string) {
    const normalizedProvider = providerLabel.trim();
    const normalizedLabel = label.trim();
    if (!normalizedProvider || !normalizedLabel.toLowerCase().startsWith(normalizedProvider.toLowerCase())) {
        return normalizedLabel;
    }

    const trimmed = normalizedLabel.slice(normalizedProvider.length).trim();
    return trimmed.length > 0 ? trimmed : normalizedLabel;
}

function onSelectProvider(provider: TAgentAssistantProviderId) {
    if (disabled) {
        return;
    }
    emit('select-provider', provider);
}

function onSelectModel(model: string) {
    if (disabled) {
        return;
    }
    emit('select-model', model);
    open.value = false;
}
</script>

<style scoped src="./AssistantSwitcherMenu.css"></style>

<style scoped>
.assistant-model-menu {
    width: min(16rem, var(--app-overlay-viewport-width));
}

.assistant-model-providers {
    display: grid;
    grid-auto-columns: minmax(0, 1fr);
    grid-auto-flow: column;
    gap: var(--app-space-3xs);
    padding: var(--app-space-3xs);
    border: 1px solid var(--app-toolbar-group-border);
    border-radius: var(--app-radius-2xl);
    background: var(--app-toolbar-group-bg);
}

.assistant-model-provider {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--app-space-md);
    min-width: 0;
    min-height: var(--app-assistant-control-height);
    padding: 0 var(--app-space-md);
    border: 1px solid transparent;
    border-radius: var(--app-radius-md);
    background: transparent;
    color: var(--app-toolbar-control-inactive-fg);
    font-size: var(--app-text-size-body-sm);
    line-height: var(--app-line-height-tight);
    cursor: pointer;
    transition:
        background-color var(--app-transition-fast),
        border-color var(--app-transition-fast),
        color var(--app-transition-fast);
}

.assistant-model-provider:hover:not(:disabled) {
    background: var(--app-toolbar-control-hover-bg);
    color: var(--app-toolbar-control-hover-fg);
}

.assistant-model-provider:focus {
    outline: none;
}

.assistant-model-provider:focus-visible {
    box-shadow: inset 0 0 0 1px var(--app-toolbar-focus-ring);
}

.assistant-model-provider:disabled {
    cursor: default;
}

.assistant-model-provider.is-active {
    border-color: var(--app-toolbar-control-active-border);
    background: var(--app-toolbar-control-active-bg);
    color: var(--ui-text);
    font-weight: var(--app-font-weight-semibold);
}

.assistant-model-provider.is-active:hover:not(:disabled) {
    border-color: var(--app-toolbar-control-active-hover-border);
    background: var(--app-toolbar-control-active-hover-bg);
}

.assistant-model-provider-icon {
    flex: 0 0 auto;
    font-size: var(--app-text-size-control);
}

.assistant-model-provider-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.assistant-model-recommended {
    flex: 0 0 auto;
    padding: var(--app-space-3xs) var(--app-space-sm);
    border-radius: var(--app-radius-full);
    background: var(--app-toolbar-control-hover-bg);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-tiny);
    font-weight: var(--app-font-weight-semibold);
    letter-spacing: 0.04em;
    line-height: var(--app-line-height-tight);
    text-transform: uppercase;
}
</style>
