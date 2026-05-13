<template>
    <fieldset class="settings-group flex flex-col gap-2.5">
        <legend class="settings-legend">{{ t('settings.updates') }}</legend>
        <UButton
            :label="isCheckInProgress ? t('updates.checkingAction') : t('settings.checkForUpdates')"
            color="neutral"
            variant="outline"
            :loading="isCheckInProgress"
            :disabled="isCheckInProgress"
            @click="check"
        />
    </fieldset>
</template>

<script setup lang="ts">
defineProps<{isCheckInProgress: boolean;}>();

const emit = defineEmits<{check: [];}>();

const { t } = useTypedI18n();

function check() {
    emit('check');
}
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
</style>
