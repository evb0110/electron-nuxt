<template>
    <AppProgressChip
        :visible="progress !== null && isPageOperationInProgress"
        :title="t('emptyState.preparingBatch')"
        :detail="detailText"
        :sub-detail="subDetailText"
        :value="progress?.percent ?? null"
        offset-bottom="high"
    />
</template>

<script setup lang="ts">
import AppProgressChip from '@app/components/AppProgressChip.vue';
import { displayProcessedCount } from '@app/utils/progressFormatting';

const {
    progress,
    etaText,
} = defineProps<{
    progress: {
        processed: number;
        total: number;
        percent: number;
    } | null;
    etaText: string | null;
    isPageOperationInProgress: boolean;
}>();

const { t } = useTypedI18n();

const detailText = computed(() => {
    if (!progress) {
        return '';
    }
    return t('emptyState.preparingBatchProgress', {
        processed: displayProcessedCount(progress.processed, progress.total),
        total: progress.total,
    });
});

const subDetailText = computed(() => etaText
    ? t('emptyState.preparingBatchEta', { eta: etaText })
    : '');
</script>
