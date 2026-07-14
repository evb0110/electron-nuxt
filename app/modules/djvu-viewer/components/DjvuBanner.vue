<template>
    <div v-if="visible" class="djvu-banner-anchor">
        <div
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
            <div
                class="djvu-banner-actions"
                :class="{'djvu-banner-actions--reserved': isBusy}"
                :aria-hidden="isBusy ? 'true' : undefined"
            >
                <UButton
                    :label="t('djvu.convertToPdf')"
                    variant="soft"
                    color="primary"
                    size="xs"
                    :tabindex="isBusy ? -1 : undefined"
                    @click="convert"
                />
                <UButton
                    icon="i-ph-x"
                    variant="ghost"
                    color="neutral"
                    size="xs"
                    class="djvu-banner-close"
                    :tabindex="isBusy ? -1 : undefined"
                    @click="dismiss"
                />
            </div>
        </div>
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
.djvu-banner-anchor {
    position: relative;
    height: 0;
    z-index: var(--app-z-banner);
}

.djvu-banner {
    position: absolute;
    top: var(--app-space-lg);
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: var(--app-space-xl);
    max-width: min(90%, 40rem);
    padding: var(--app-space-sm) var(--app-space-lg);
    background: color-mix(in srgb, var(--ui-bg-elevated) 88%, transparent);
    backdrop-filter: blur(8px);
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-full);
    box-shadow: var(--shadow-popup);
    font-size: var(--app-text-size-body-sm);
    line-height: var(--app-line-height-snug);
    white-space: nowrap;
}

.djvu-banner-icon {
    width: var(--app-icon-size-md);
    height: var(--app-icon-size-md);
    color: var(--ui-primary);
    flex-shrink: 0;
}

.djvu-banner-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    padding-block: var(--app-space-2xs);
    color: var(--ui-text-muted);
    font-variant-numeric: tabular-nums;
    line-height: var(--app-line-height-body);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.djvu-banner-actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: var(--app-space-sm);
}

.djvu-banner-actions--reserved {
    pointer-events: none;
    visibility: hidden;
}

.djvu-banner-close {
    flex-shrink: 0;
}
</style>
