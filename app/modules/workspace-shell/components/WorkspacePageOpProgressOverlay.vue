<template>
    <div
        v-if="progress && isPageOperationInProgress"
        class="pointer-events-none absolute bottom-28 right-4 z-50 w-60 rounded-md border border-default bg-default/95 px-3 py-2 shadow-lg"
        role="status"
        aria-live="polite"
    >
        <div class="flex items-center gap-2">
            <UIcon name="i-ph-circle-notch" class="size-4 animate-spin text-muted" />
            <div class="min-w-0">
                <p class="m-0 text-xs font-medium text-default">
                    {{ t('emptyState.preparingBatch') }}
                </p>
                <p class="m-0 text-[11px] text-muted">
                    {{ t('emptyState.preparingBatchProgress', {
                        processed: displayProcessedCount(progress.processed, progress.total),
                        total: progress.total,
                    }) }}
                </p>
                <p v-if="etaText" class="m-0 text-[11px] text-dimmed">
                    {{ t('emptyState.preparingBatchEta', { eta: etaText }) }}
                </p>
            </div>
        </div>
        <UProgress :value="progress.percent" class="mt-2" />
    </div>
</template>

<script setup lang="ts">
import { displayProcessedCount } from '@app/utils/progress-formatting';

defineProps<{
    progress: {
        processed: number;
        total: number;
        percent: number;
    } | null;
    etaText: string | null;
    isPageOperationInProgress: boolean;
}>();

const { t } = useTypedI18n();
</script>
