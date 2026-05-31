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
            <UProgress
                :value="value"
                class="app-progress-overlay-bar"
            />
            <div class="app-progress-overlay-percent">
                {{ formattedPercent }}
            </div>
            <UButton
                v-if="cancelLabel"
                :label="cancelLabel"
                variant="ghost"
                color="neutral"
                size="sm"
                @click="emit('cancel')"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import { clamp } from 'es-toolkit/math';
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
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--ui-bg-elevated);
}

.app-progress-overlay-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    padding: 2rem 3rem;
    border-radius: 0.75rem;
    background: var(--ui-bg);
    border: 1px solid var(--ui-border);
    box-shadow: var(--ui-shadow-lg);
}

.app-progress-overlay-title {
    font-size: 0.875rem;
    color: var(--ui-text);
    font-weight: 500;
}

.app-progress-overlay-bar {
    width: 15rem;
}

.app-progress-overlay-percent {
    font-size: 0.75rem;
    color: var(--ui-text-muted);
    font-variant-numeric: tabular-nums;
}
</style>
