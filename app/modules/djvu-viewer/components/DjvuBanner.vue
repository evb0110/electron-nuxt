<template>
    <div
        v-if="visible"
        class="djvu-banner"
        :class="{'djvu-banner--opening': isOpening}"
        :aria-busy="isBusy ? 'true' : undefined"
    >
        <AppSpinner
            v-if="isBusy"
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
            {{ bannerText }}
        </span>
        <UButton
            v-if="!isBusy"
            :label="t('djvu.convertToPdf')"
            variant="soft"
            color="primary"
            size="xs"
            @click="convert"
        />
        <UButton
            v-if="!isBusy"
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
    isOpening = false,
    isLoadingPages = false,
    loadingCurrent = 0,
    loadingTotal = 0,
} = defineProps<{
    visible: boolean;
    isOpening?: boolean;
    isLoadingPages?: boolean;
    loadingCurrent?: number;
    loadingTotal?: number;
}>();

const emit = defineEmits<{
    convert: [];
    dismiss: [];
}>();

const hasPageProgress = computed(() => loadingTotal > 0);
const isBusy = computed(() => isOpening || isLoadingPages);
const bannerText = computed(() => {
    if (isOpening || (isLoadingPages && !hasPageProgress.value)) {
        return t('djvu.opening');
    }

    if (isLoadingPages) {
        return t('djvu.loadingPages', {
            current: loadingCurrent,
            total: loadingTotal,
        });
    }

    return t('djvu.bannerHint');
});

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
    gap: var(--app-space-3xl);
    padding: var(--app-space-lg) var(--app-space-9xl);
    background: var(--ui-bg-elevated);
    border-bottom: 1px solid var(--ui-border);
    font-size: var(--app-text-size-body-sm);
    line-height: var(--app-line-height-snug);
}

.djvu-banner-icon {
    width: var(--app-icon-size-md);
    height: var(--app-icon-size-md);
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
