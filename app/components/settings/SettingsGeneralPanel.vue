<template>
    <fieldset class="settings-group flex flex-col gap-2.5">
        <legend class="settings-legend">{{ t('settings.general') }}</legend>

        <div class="settings-field flex flex-col gap-1">
            <label class="settings-label" for="settings-author">
                {{ t('settings.author') }}
            </label>
            <UInput
                id="settings-author"
                :model-value="settings.authorName"
                :placeholder="t('settings.authorPlaceholder')"
                icon="i-lucide-user"
                @update:model-value="emit('update:author-name', $event as string)"
            />
            <p class="settings-hint">{{ t('settings.authorDescription') }}</p>
        </div>

        <div class="settings-field flex flex-col gap-1">
            <label class="settings-label">{{ t('settings.theme') }}</label>
            <div class="settings-segmented">
                <button
                    type="button"
                    class="settings-seg-btn"
                    :class="{ 'is-active': settings.theme === 'light' }"
                    @click="emit('update:theme', 'light')"
                >
                    <UIcon name="i-lucide-sun" class="settings-seg-icon" />
                    {{ t('settings.themeLight') }}
                </button>
                <button
                    type="button"
                    class="settings-seg-btn"
                    :class="{ 'is-active': settings.theme === 'dark' }"
                    @click="emit('update:theme', 'dark')"
                >
                    <UIcon name="i-lucide-moon" class="settings-seg-icon" />
                    {{ t('settings.themeDark') }}
                </button>
            </div>
        </div>

        <div class="settings-field flex flex-col gap-1">
            <label class="settings-label">{{ t('settings.language') }}</label>
            <USelectMenu
                :model-value="settings.locale"
                :items="localeItems"
                value-key="value"
                :icon="selectedFlagIcon"
                :search-input="false"
                @update:model-value="emit('update:locale', $event as string | { value: string })"
            />
        </div>

        <div class="settings-field flex flex-col gap-1">
            <label class="settings-label">{{ t('settings.uiScale') }}</label>
            <div class="settings-segmented settings-segmented--five">
                <button
                    v-for="option in uiScaleOptions"
                    :key="option.value"
                    type="button"
                    class="settings-seg-btn"
                    :class="{ 'is-active': settings.uiScale === option.value }"
                    @click="emit('update:ui-scale', option.value)"
                >
                    {{ option.label }}
                </button>
            </div>
            <p class="settings-hint">{{ t('settings.uiScaleDescription') }}</p>
        </div>
    </fieldset>
</template>

<script setup lang="ts">
import type {
    ISettingsData,
    TAppTheme,
    TUiScalePreference,
} from '@contracts/shared';

interface ILocaleItem {
    value: string;
    label: string;
    icon: string;
}

defineProps<{
    settings: ISettingsData;
    localeItems: ILocaleItem[];
    selectedFlagIcon: string;
}>();

const emit = defineEmits<{
    'update:author-name': [value: string];
    'update:theme': [value: TAppTheme];
    'update:locale': [value: string | { value: string }];
    'update:ui-scale': [value: TUiScalePreference];
}>();

const { t } = useTypedI18n();

const uiScaleOptions = computed<Array<{
    value: TUiScalePreference;
    label: string;
}>>(() => [
    {
        value: 'auto',
        label: t('settings.uiScaleAuto'),
    },
    {
        value: 'compact',
        label: t('settings.uiScaleCompact'),
    },
    {
        value: 'default',
        label: t('settings.uiScaleDefault'),
    },
    {
        value: 'comfortable',
        label: t('settings.uiScaleComfortable'),
    },
    {
        value: 'large',
        label: t('settings.uiScaleLarge'),
    },
]);
</script>

<style lang="scss" scoped>
.settings-group {
    border: none;
    padding: 0;
    margin: 0;
}

.settings-legend {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--ui-text-dimmed);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0;
    margin-bottom: 0.125rem;
}

.settings-label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--ui-text);
}

.settings-hint {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.35;
    color: var(--ui-text-dimmed);
}

.settings-segmented {
    display: flex;
    border: 1px solid var(--ui-border);
    border-radius: calc(var(--ui-radius) * 1.5);
    overflow: hidden;
    background: color-mix(in oklab, var(--ui-bg-muted) 50%, var(--ui-bg) 50%);
}

.settings-seg-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
    border: none;
    background: transparent;
    color: var(--ui-text-muted);
    height: 2.25rem;
    padding: 0 0.75rem;
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    transition: background-color $ease-standard, color $ease-standard, box-shadow $ease-standard;
}

.settings-segmented--five .settings-seg-btn {
    padding: 0 0.4rem;
    font-size: 0.78rem;
}

.settings-seg-btn + .settings-seg-btn {
    border-left: 1px solid var(--ui-border);
}

.settings-seg-btn:hover:not(.is-active) {
    color: var(--ui-text);
    background: color-mix(in oklab, var(--ui-bg) 80%, var(--ui-border) 20%);
}

.settings-seg-btn.is-active {
    background: var(--ui-bg);
    color: var(--ui-text);
    font-weight: 600;
    box-shadow:
        0 1px 2px color-mix(in srgb, var(--ui-bg-inverted) 6%, transparent),
        inset 0 -1px 0 color-mix(in srgb, var(--ui-bg-inverted) 4%, transparent);
}

.settings-seg-icon {
    width: 0.875rem;
    height: 0.875rem;
    flex-shrink: 0;
}
</style>
