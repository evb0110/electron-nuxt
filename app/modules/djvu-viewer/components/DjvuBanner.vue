<template>
    <div
        v-if="visible"
        class="djvu-banner"
    >
        <AppSpinner
            v-if="isLoadingPages"
            size="sm"
            tone="primary"
            class="shrink-0"
        />
        <UIcon
            v-else
            name="i-ph-info"
            class="djvu-banner-icon"
        />
        <span class="djvu-banner-text">
            <template v-if="isLoadingPages">
                {{ t('djvu.loadingPages', {
                    current: loadingCurrent,
                    total: loadingTotal,
                }) }}
            </template>
            <template v-else>
                {{ t('djvu.bannerHint') }}
            </template>
        </span>
        <UButton
            v-if="!isLoadingPages"
            :label="t('djvu.convertToPdf')"
            variant="soft"
            color="primary"
            size="xs"
            @click="convert"
        />
        <UButton
            icon="i-ph-x"
            variant="ghost"
            color="neutral"
            size="xs"
            class="djvu-banner-close"
            @click="dismiss"
        />
    </div>
</template>

<script setup lang="ts">
import AppSpinner from '@app/components/AppSpinner.vue';

const { t } = useTypedI18n();

const {
    visible,
    isLoadingPages = false,
    loadingCurrent = 0,
    loadingTotal = 0,
} = defineProps<{
    visible: boolean;
    isLoadingPages?: boolean;
    loadingCurrent?: number;
    loadingTotal?: number;
}>();

const emit = defineEmits<{
    convert: [];
    dismiss: [];
}>();

function convert() {
    emit('convert');
}

function dismiss() {
    emit('dismiss');
}
</script>

<style scoped>
.djvu-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--ui-bg-elevated);
    border-bottom: 1px solid var(--ui-border);
    font-size: 13px;
}

.djvu-banner-icon {
    width: 16px;
    height: 16px;
    color: var(--ui-primary);
    flex-shrink: 0;
}

.djvu-banner-text {
    flex: 1;
    color: var(--ui-text-muted);
    font-variant-numeric: tabular-nums;
}

.djvu-banner-close {
    flex-shrink: 0;
}
</style>
