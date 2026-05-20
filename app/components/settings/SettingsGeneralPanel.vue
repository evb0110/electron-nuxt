<template>
    <fieldset class="settings-section flex flex-col gap-2.5">
        <legend class="settings-section-title">{{ t('settings.general') }}</legend>

        <div class="settings-field flex flex-col gap-1">
            <label class="settings-field-label" for="settings-author">
                {{ t('settings.author') }}
            </label>
            <UInput
                id="settings-author"
                :model-value="settings.authorName"
                :placeholder="t('settings.authorPlaceholder')"
                icon="i-ph-user"
                @update:model-value="updateAuthorName"
            />
            <p class="settings-field-hint">{{ t('settings.authorDescription') }}</p>
        </div>

        <div class="settings-field flex flex-col gap-1">
            <label class="settings-field-label">{{ t('settings.theme') }}</label>
            <div class="settings-segmented">
                <button
                    type="button"
                    class="settings-seg-btn"
                    :class="{ 'is-active': settings.theme === 'light' }"
                    @click="emit('update:theme', 'light')"
                >
                    <UIcon name="i-ph-sun" class="settings-seg-icon" />
                    {{ t('settings.themeLight') }}
                </button>
                <button
                    type="button"
                    class="settings-seg-btn"
                    :class="{ 'is-active': settings.theme === 'dark' }"
                    @click="emit('update:theme', 'dark')"
                >
                    <UIcon name="i-ph-moon" class="settings-seg-icon" />
                    {{ t('settings.themeDark') }}
                </button>
            </div>
        </div>

        <div class="settings-field flex flex-col gap-1">
            <label class="settings-field-label">{{ t('settings.language') }}</label>
            <USelectMenu
                :model-value="settings.locale"
                :items="localeItems"
                value-key="value"
                :icon="selectedFlagIcon"
                :search-input="false"
                @update:model-value="emit('update:locale', $event)"
            />
        </div>

        <div class="settings-field flex flex-col gap-1">
            <label class="settings-field-label">{{ t('settings.uiScale') }}</label>
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
            <p class="settings-field-hint">{{ t('settings.uiScaleDescription') }}</p>
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

function updateAuthorName(value: string | number) {
    emit('update:author-name', String(value));
}

</script>

<style lang="scss" scoped>
@use '@app/assets/css/settingsPanelShared';

.settings-segmented {
    display: flex;
    gap: 2px;
    padding: 3px;
    border-radius: calc(var(--ui-radius) * 1.5);
    background: var(--ui-bg-muted);
}

.settings-seg-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
    border: 1px solid transparent;
    border-radius: var(--ui-radius);
    background: transparent;
    color: var(--ui-text-muted);
    height: 2rem;
    padding: 0 0.75rem;
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    transition: background-color $ease-standard, color $ease-standard, border-color $ease-standard;
}

.settings-segmented--five .settings-seg-btn {
    padding: 0 0.4rem;
    font-size: 0.78rem;
}

.settings-seg-btn:hover:not(.is-active) {
    color: var(--ui-text);
}

.settings-seg-btn.is-active {
    background: var(--app-toolbar-control-active-bg);
    border-color: var(--app-toolbar-control-active-border);
    color: var(--ui-text);
    font-weight: 600;
}

.settings-seg-btn.is-active:hover {
    background: var(--app-toolbar-control-active-hover-bg);
    border-color: var(--app-toolbar-control-active-hover-border);
}

.settings-seg-icon {
    width: 0.875rem;
    height: 0.875rem;
    flex-shrink: 0;
}
</style>
