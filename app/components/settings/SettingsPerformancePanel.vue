<template>
    <fieldset class="settings-section flex flex-col gap-2.5">
        <legend class="settings-section-title">{{ t('settings.performance') }}</legend>
        <p class="settings-field-hint">{{ t('settings.performanceDescription') }}</p>

        <UFormField
            :label="t('settings.performanceMode')"
            :help="t('settings.performanceModeDescription')"
            :ui="settingsFormFieldUi"
        >
            <USelectMenu
                :model-value="settings.performanceMode"
                :items="performanceModeItems"
                value-key="value"
                icon="i-ph-gauge"
                :search-input="false"
                @update:model-value="emit('update:performance-mode', $event)"
            />
        </UFormField>
    </fieldset>
</template>

<script setup lang="ts">
import type { ISettingsData } from '@contracts/shared';
import type { TPerformanceMode } from '@contracts/hostResourceProfile';

const PERFORMANCE_MODE_OPTION_DEFINITIONS = [
    {
        value: 'auto',
        labelKey: 'settings.performanceModeAuto',
    },
    {
        value: 'low',
        labelKey: 'settings.performanceModeLow',
    },
    {
        value: 'medium',
        labelKey: 'settings.performanceModeMedium',
    },
    {
        value: 'high',
        labelKey: 'settings.performanceModeHigh',
    },
] as const satisfies ReadonlyArray<{
    value: TPerformanceMode;
    labelKey: string;
}>;

defineProps<{settings: ISettingsData;}>();

const emit = defineEmits<{'update:performance-mode': [value: string | { value: string }];}>();

const { t } = useTypedI18n();

const settingsFormFieldUi = {
    label: 'settings-field-label',
    help: 'settings-field-hint mt-1',
};

const performanceModeItems = computed(() => PERFORMANCE_MODE_OPTION_DEFINITIONS.map(option => ({
    value: option.value,
    label: t(option.labelKey),
})));
</script>

<style lang="scss" scoped>
@use '@app/assets/css/settings-panel-shared';
</style>
