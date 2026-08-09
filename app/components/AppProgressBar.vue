<template>
    <UProgress
        class="app-progress-bar"
        color="primary"
        size="md"
        :max="100"
        :model-value="normalizedValue"
        :ui="progressUi"
    />
</template>

<script setup lang="ts">
import { clamp } from 'es-toolkit/math';

const { value = null } = defineProps<{value?: number | null;}>();

const progressUi = {
    base: 'bg-elevated',
    indicator: 'duration-200',
} as const;

const normalizedValue = computed(() => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }
    return clamp(Math.round(value), 0, 100);
});
</script>
