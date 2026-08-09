<template>
    <div
        v-if="open"
        class="app-progress-overlay"
        role="status"
        aria-live="polite"
    >
        <div class="app-progress-overlay-card">
            <AppSpinner size="lg" tone="primary" />
            <div class="app-progress-overlay-title">
                {{ title }}
            </div>
            <div
                v-if="detail"
                class="app-progress-overlay-detail"
            >
                {{ detail }}
            </div>
            <AppProgressBar
                :value="value"
                class="app-progress-overlay-bar"
            />
            <div
                v-if="formattedPercent"
                class="app-progress-overlay-percent"
            >
                {{ formattedPercent }}
            </div>
            <div
                v-if="subDetail"
                class="app-progress-overlay-sub-detail"
            >
                {{ subDetail }}
            </div>
            <UButton
                v-if="cancelLabel"
                :label="cancelLabel"
                variant="outline"
                color="neutral"
                size="sm"
                @click="emit('cancel')"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import { clamp } from 'es-toolkit/math';
import AppProgressBar from '@app/components/AppProgressBar.vue';
import AppSpinner from '@app/components/AppSpinner.vue';

interface IAppProgressOverlayProps {
    open: boolean;
    title: string;
    value: number | null;
    detail?: string;
    subDetail?: string;
    cancelLabel?: string;
}

const {
    cancelLabel = '',
    detail = '',
    subDetail = '',
    value,
} = defineProps<IAppProgressOverlayProps>();

const emit = defineEmits<{cancel: [];}>();

const formattedPercent = computed(() => typeof value === 'number' && Number.isFinite(value)
    ? `${clamp(Math.round(value), 0, 100)}%`
    : '');
</script>

<style scoped>
.app-progress-overlay {
    position: absolute;
    inset: 0;
    z-index: var(--app-progress-overlay-z-index);
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    background: color-mix(in oklab, var(--ui-bg-elevated) 42%, transparent);
}

.app-progress-overlay-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--app-progress-card-gap);
    padding: var(--app-progress-card-padding);
    border-radius: var(--app-progress-card-radius);
    background: var(--ui-bg);
    border: 1px solid var(--ui-border);
    box-shadow: var(--ui-shadow-lg);
    inline-size: min(
        var(--app-content-width-xs),
        calc(100% - (2 * var(--app-space-9xl)))
    );
    max-inline-size: calc(100% - (2 * var(--app-space-9xl)));
    box-sizing: border-box;
}

.app-progress-overlay-title {
    font-size: var(--app-text-size-body);
    color: var(--ui-text);
    font-weight: 500;
    text-align: center;
}

.app-progress-overlay-detail,
.app-progress-overlay-sub-detail {
    max-inline-size: var(--app-progress-bar-width);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
    text-align: center;
}

.app-progress-overlay-sub-detail {
    color: var(--ui-text-dimmed);
}

.app-progress-overlay-bar {
    width: min(var(--app-progress-bar-width), 100%);
    max-inline-size: 100%;
}

.app-progress-overlay-percent {
    font-size: var(--app-text-size-kicker);
    color: var(--ui-text-muted);
    font-variant-numeric: tabular-nums;
}
</style>
