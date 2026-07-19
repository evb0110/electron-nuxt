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
            <AppProgressBar
                :value="value"
                class="app-progress-overlay-bar"
            />
            <div class="app-progress-overlay-percent">
                {{ formattedPercent }}
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
    value: number;
    cancelLabel?: string;
}

const {
    cancelLabel = '',
    value,
} = defineProps<IAppProgressOverlayProps>();

const emit = defineEmits<{cancel: [];}>();

const formattedPercent = computed(() => `${clamp(Math.round(value), 0, 100)}%`);
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
    inline-size: min-content;
    max-inline-size: calc(100% - (2 * var(--app-space-9xl)));
    box-sizing: border-box;
}

.app-progress-overlay-title {
    font-size: var(--app-text-size-body);
    color: var(--ui-text);
    font-weight: 500;
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
