<template>
    <AppProgressOverlay
        :open="isConverting"
        :title="overlayTitle"
        :value="percent"
        :cancel-label="t('common.cancel')"
        @cancel="emit('cancel')"
    />
</template>

<script setup lang="ts">
import AppProgressOverlay from '@app/components/AppProgressOverlay.vue';

const { t } = useTypedI18n();

const { phase } = defineProps<{
    isConverting: boolean;
    phase: 'converting' | 'bookmarks' | null;
    percent: number;
}>();

const emit = defineEmits<{cancel: [];}>();

const overlayTitle = computed(() => {
    if (phase === 'converting') {
        return t('djvu.overlayConverting');
    }
    if (phase === 'bookmarks') {
        return t('djvu.overlayBookmarks');
    }
    return t('djvu.overlayPreparing');
});
</script>
