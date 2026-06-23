<template>
    <UPopover
        v-model:open="open"
        mode="click"
        :content="content"
        portal="body"
    >
        <button
            type="button"
            class="assistant-model-switcher-button"
            :aria-label="ariaLabel"
            :aria-disabled="disabled"
            :disabled="disabled"
        >
            <AssistantProviderIcon
                :provider="selectedProvider"
                class="assistant-model-switcher-provider-icon"
            />
            <span class="assistant-model-switcher-model">{{ activeModelLabel }}</span>
            <UIcon
                :name="isSwitching ? 'i-ph-circle-notch' : 'i-ph-caret-up-down'"
                :class="[
                    'assistant-model-switcher-indicator',
                    { 'is-spinning': isSwitching },
                ]"
            />
        </button>

        <template #content>
            <div class="assistant-model-switcher-menu">
                <div
                    class="assistant-model-switcher-tabs"
                    role="tablist"
                    :aria-label="t('assistant.provider')"
                >
                    <button
                        v-for="provider in providerItems"
                        :key="provider.value"
                        type="button"
                        :class="[
                            'assistant-model-switcher-tab',
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
                            class="assistant-model-switcher-tab-icon"
                        />
                        <span>{{ provider.label }}</span>
                    </button>
                </div>

                <div class="assistant-model-switcher-section">
                    <span class="assistant-model-switcher-section-label">{{ t('assistant.model') }}</span>
                    <div
                        class="assistant-model-switcher-list"
                        role="radiogroup"
                        :aria-label="t('assistant.model')"
                    >
                        <button
                            v-for="model in modelItems"
                            :key="model.value"
                            type="button"
                            :class="[
                                'assistant-model-switcher-option',
                                { 'is-active': isSelectedModel(model.value) },
                            ]"
                            role="radio"
                            :aria-checked="isSelectedModel(model.value)"
                            :aria-disabled="disabled"
                            :disabled="disabled"
                            @click="onSelectModel(model.value)"
                        >
                            <span>{{ model.label }}</span>
                            <UIcon
                                v-if="isSelectedModel(model.value)"
                                name="i-ph-check"
                                class="assistant-model-switcher-check"
                            />
                        </button>
                    </div>
                </div>
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
})));
const activeProviderLabel = computed(() => activeProvider.value?.label ?? selectedProvider);
const activeModelOption = computed(() => (
    modelItems.value.find(model => model.value === selectedModel)
    ?? null
));
const activeModelLabel = computed(() => activeModelOption.value?.label ?? selectedModel);
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

<style scoped>
.assistant-model-switcher-button {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    max-width: 100%;
    min-width: 0;
    height: 1.85rem;
    padding: 0 var(--app-space-3xl);
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

.assistant-model-switcher-button:hover:not(:disabled) {
    background: var(--app-toolbar-control-hover-bg);
    border-color: var(--app-toolbar-control-hover-border);
}

.assistant-model-switcher-button:focus {
    outline: none;
}

.assistant-model-switcher-button:focus-visible {
    box-shadow: inset 0 0 0 1px var(--app-toolbar-focus-ring);
}

.assistant-model-switcher-button:disabled {
    opacity: var(--app-toolbar-control-disabled-opacity);
    cursor: default;
}

.assistant-model-switcher-provider-icon {
    flex: 0 0 auto;
    font-size: 0.95rem;
}

.assistant-model-switcher-indicator {
    flex: 0 0 auto;
    width: 0.9rem;
    height: 0.9rem;
}

.assistant-model-switcher-model {
    min-width: 0;
    overflow: hidden;
    font-weight: var(--app-font-weight-semibold);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.assistant-model-switcher-indicator {
    color: var(--ui-text-muted);
}

.assistant-model-switcher-menu {
    width: min(17rem, var(--app-overlay-viewport-width));
    max-width: var(--app-overlay-viewport-width);
    padding: var(--app-space-md);
    background: var(--app-toolbar-group-bg);
    user-select: none;
}

.assistant-model-switcher-tabs {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--app-space-sm);
    padding: var(--app-space-2xs);
    border: 1px solid var(--app-toolbar-group-border);
    border-radius: var(--app-radius-md);
    background: var(--app-sidebar-bg);
}

.assistant-model-switcher-tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--app-space-md);
    min-width: 0;
    min-height: 1.85rem;
    padding: 0 0.5rem;
    border: 1px solid transparent;
    border-radius: var(--app-radius-xs);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-body-sm);
    line-height: var(--app-line-height-tight);
    cursor: pointer;
    transition:
        background-color var(--app-transition-fast),
        border-color var(--app-transition-fast),
        color var(--app-transition-fast);
}

.assistant-model-switcher-tab:hover:not(:disabled) {
    background: var(--app-toolbar-control-hover-bg);
    color: var(--ui-text);
}

.assistant-model-switcher-tab:focus {
    outline: none;
}

.assistant-model-switcher-tab:focus-visible {
    box-shadow: inset 0 0 0 1px var(--app-toolbar-focus-ring);
}

.assistant-model-switcher-tab.is-active {
    border-color: var(--app-toolbar-control-hover-border);
    background: var(--app-toolbar-control-hover-bg);
    color: var(--ui-text);
    font-weight: var(--app-font-weight-semibold);
}

.assistant-model-switcher-tab:disabled {
    cursor: default;
}

.assistant-model-switcher-tab-icon {
    flex: 0 0 auto;
    font-size: 0.95rem;
}

.assistant-model-switcher-section {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding-top: var(--app-space-2xl);
}

.assistant-model-switcher-section-label {
    padding: 0 var(--app-space-2xs);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-micro);
    font-weight: var(--app-font-weight-semibold);
    line-height: var(--app-line-height-tight);
    text-transform: uppercase;
}

.assistant-model-switcher-list {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
}

.assistant-model-switcher-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--app-space-3xl);
    min-height: 1.85rem;
    min-width: 0;
    padding: 0 var(--app-space-3xl);
    border-radius: 5px;
    color: var(--ui-text);
    font-size: var(--app-text-size-body-sm);
    line-height: 1.15;
    text-align: left;
    cursor: pointer;
    transition: background-color var(--app-transition-fast);
}

.assistant-model-switcher-option:hover:not(:disabled) {
    background: var(--app-toolbar-control-hover-bg);
}

.assistant-model-switcher-option:focus {
    outline: none;
}

.assistant-model-switcher-option:focus-visible {
    box-shadow: inset 0 0 0 1px var(--app-toolbar-focus-ring);
}

.assistant-model-switcher-option.is-active {
    background: var(--app-toolbar-control-hover-bg);
    font-weight: var(--app-font-weight-semibold);
}

.assistant-model-switcher-option:disabled {
    cursor: default;
}

.assistant-model-switcher-option span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.assistant-model-switcher-check {
    flex: 0 0 auto;
    width: 0.95rem;
    height: 0.95rem;
    color: var(--ui-primary);
}

.is-spinning {
    animation: assistant-model-switcher-spin 0.9s linear infinite;
}

@keyframes assistant-model-switcher-spin {
    to {
        transform: rotate(360deg);
    }
}
</style>
