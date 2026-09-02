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
            <div
                class="assistant-switcher-menu assistant-model-menu app-floating-scroll-region app-scrollbar app-scroll-region--balanced"
                :aria-label="t('assistant.model')"
            >
                <div
                    v-for="group in groups"
                    :key="group.provider"
                    class="assistant-model-group"
                    role="group"
                    :aria-label="group.label"
                >
                    <span class="assistant-model-group-label">
                        <AssistantProviderIcon
                            :provider="group.provider"
                            class="assistant-model-group-icon"
                        />
                        {{ group.label }}
                    </span>
                    <button
                        v-for="model in group.models"
                        :key="model.value"
                        type="button"
                        :class="[
                            'assistant-switcher-option',
                            { 'is-active': model.isSelected },
                        ]"
                        :aria-pressed="model.isSelected"
                        :aria-disabled="disabled"
                        :disabled="disabled"
                        @click="onSelectModel(group.provider, model.value)"
                    >
                        <span class="assistant-switcher-option-label">{{ model.displayLabel }}</span>
                        <span class="assistant-switcher-check-slot">
                            <UIcon
                                v-if="model.isSelected"
                                name="i-ph-check"
                                class="assistant-switcher-check"
                            />
                        </span>
                    </button>
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

const activeProvider = computed(() => (
    providers.find(provider => provider.id === selectedProvider)
    ?? providers[0]
    ?? null
));
const activeProviderLabel = computed(() => activeProvider.value?.label ?? selectedProvider);
const groups = computed(() => providers.map(provider => ({
    provider: provider.id,
    label: provider.label,
    models: provider.models.map(model => ({
        value: model.id,
        label: model.label,
        displayLabel: trimProviderPrefix(model.label, provider.label),
        isSelected: provider.id === selectedProvider && model.id === selectedModel,
    })),
})));
const activeModelOption = computed(() => (
    activeProvider.value?.models.find(model => model.id === selectedModel)
    ?? null
));
const activeModelLabel = computed(() => activeModelOption.value?.label ?? selectedModel);
const activeModelDisplayLabel = computed(() => (
    trimProviderPrefix(activeModelLabel.value, activeProviderLabel.value)
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

function trimProviderPrefix(label: string, providerLabel: string) {
    const normalizedProvider = providerLabel.trim();
    const normalizedLabel = label.trim();
    if (!normalizedProvider || !normalizedLabel.toLowerCase().startsWith(normalizedProvider.toLowerCase())) {
        return normalizedLabel;
    }

    const trimmed = normalizedLabel.slice(normalizedProvider.length).trim();
    return trimmed.length > 0 ? trimmed : normalizedLabel;
}

function onSelectModel(provider: TAgentAssistantProviderId, model: string) {
    if (disabled) {
        return;
    }
    if (provider !== selectedProvider) {
        emit('select-provider', provider);
    }
    emit('select-model', model);
    open.value = false;
}
</script>

<style scoped src="./AssistantSwitcherMenu.css"></style>

<style scoped>
.assistant-model-menu {
    --assistant-model-row-indent: calc(var(--app-space-3xl) + var(--app-icon-size-xs) + var(--app-space-sm));

    min-width: var(--app-assistant-model-menu-min-width);
}

.assistant-model-group {
    display: flex;
    flex-direction: column;
}

.assistant-model-group + .assistant-model-group {
    margin-top: var(--app-space-sm);
    padding-top: var(--app-space-sm);
    border-top: var(--app-hairline-height) solid var(--app-toolbar-separator);
}

.assistant-model-group-label {
    display: flex;
    align-items: center;
    gap: var(--app-space-sm);
    padding: var(--app-space-sm) var(--app-space-3xl);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-caption);
    font-weight: var(--app-font-weight-medium);
    line-height: var(--app-line-height-control);
}

.assistant-model-group-icon {
    flex: 0 0 auto;
    width: var(--app-icon-size-xs);
    height: var(--app-icon-size-xs);
}

/* Model rows sit under the provider name, not under its icon: the indent is
   the only thing that says which provider a model belongs to. */
.assistant-model-menu .assistant-switcher-option {
    padding-left: var(--assistant-model-row-indent);
}
</style>
