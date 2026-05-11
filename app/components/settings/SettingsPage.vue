<template>
    <AppToolPageShell
        :title="t('settings.title')"
        :eyebrow="t('settings.pageEyebrow')"
        :description="settingsPageDescription"
        icon="i-ph-gear"
        :show-back="showBack"
        :show-eyebrow="showEyebrow"
        @close="emit('close')"
    >
        <div class="settings-page-content">
            <SettingsContent />
        </div>
    </AppToolPageShell>
</template>

<script setup lang="ts">
import AppToolPageShell from '@app/components/AppToolPageShell.vue';
import SettingsContent from '@app/components/settings/SettingsContent.vue';

const emit = defineEmits<{ 'close': [] }>();

const {
    showBack = true,
    showEyebrow = true,
} = defineProps<{
    showBack?: boolean;
    showEyebrow?: boolean;
}>();

const { isDesktopRuntime } = useRuntimeEnvironment();
const { t } = useTypedI18n();
const settingsPageDescription = computed(() => isDesktopRuntime
    ? t('settings.dialogDescription')
    : t('settings.browserDialogDescription'));
</script>

<style scoped>
.settings-page-content {
    width: min(100%, 52rem);
    margin: 0 auto;
}
</style>
