<template>
    <UProgress
        v-if="hasValue"
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

const { value } = defineProps<{value: number | null | undefined;}>();

const progressUi = {
    base: 'bg-elevated',
    indicator: 'duration-[180ms]',
} as const;

const hasValue = computed(() => typeof value === 'number' && Number.isFinite(value));
const normalizedValue = computed(() => {
    if (!hasValue.value || typeof value !== 'number') {
        return 0;
    }
    return clamp(Math.round(value), 0, 100);
});
</script>
