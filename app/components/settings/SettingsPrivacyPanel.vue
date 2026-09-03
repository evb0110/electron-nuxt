<template>
    <fieldset class="settings-section flex flex-col gap-2.5">
        <legend class="settings-section-title">{{ t('settings.privacy') }}</legend>

        <UFormField
            :label="t('settings.clientDiagnostics')"
            :help="t('settings.clientDiagnosticsDescription')"
            :ui="settingsFormFieldUi"
        >
            <USwitch
                :model-value="settings.clientDiagnosticsPreference === 'granted'"
                :label="t('settings.clientDiagnostics')"
                size="sm"
                @update:model-value="emit('update:client-diagnostics-preference', $event ? 'granted' : 'denied')"
            />
        </UFormField>

        <UFormField
            :label="t('settings.serverDiagnosticsOptOut')"
            :help="t('settings.serverDiagnosticsOptOutDescription')"
            :ui="settingsFormFieldUi"
        >
            <USwitch
                :model-value="serverDiagnosticsOptOut"
                :label="t('settings.serverDiagnosticsOptOut')"
                size="sm"
                @update:model-value="updateServerDiagnosticsOptOut"
            />
        </UFormField>

        <NuxtLink class="settings-privacy-link" to="/privacy">
            {{ t('settings.clientDiagnosticsPrivacyNotice') }}
        </NuxtLink>
    </fieldset>
</template>

<script setup lang="ts">
import type { ISettingsData } from '@contracts/shared';
import type { TClientDiagnosticsPreference } from '@contracts/diagnostics/diagnosticsPreference';
import {
    readDiagnosticsServerOptOut,
    writeDiagnosticsServerOptOut,
    type TDiagnosticsServerOptOut,
} from '@app/utils/diagnosticsServerOptOut';

defineProps<{settings: ISettingsData;}>();

const emit = defineEmits<{'update:client-diagnostics-preference': [value: TClientDiagnosticsPreference];}>();

const { t } = useTypedI18n();
const serverDiagnosticsOptOut = ref<TDiagnosticsServerOptOut>(readDiagnosticsServerOptOut());

function updateServerDiagnosticsOptOut(value: boolean) {
    const nextValue = Boolean(value);
    if (writeDiagnosticsServerOptOut(nextValue)) {
        serverDiagnosticsOptOut.value = nextValue;
    }
}

const settingsFormFieldUi = {
    label: 'settings-field-label',
    help: 'settings-field-hint mt-1',
};
</script>

<style lang="scss" scoped>
@use '@app/assets/css/settings-panel-shared';

.settings-privacy-link {
    width: fit-content;
    color: var(--ui-primary);
    font-size: var(--app-text-size-kicker);
    text-decoration: underline;
    text-underline-offset: 0.15em;
}

.settings-privacy-link:focus-visible {
    outline: 2px solid var(--ui-primary);
    outline-offset: 2px;
}
</style>
