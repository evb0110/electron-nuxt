<template>
    <div
        v-if="hasValue"
        class="app-progress-bar"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="normalizedValue"
    >
        <div
            class="app-progress-bar-fill"
            :style="{ width: `${normalizedValue}%` }"
        />
    </div>
</template>

<script setup lang="ts">
import { clamp } from 'es-toolkit/math';

const { value } = defineProps<{value: number | null | undefined;}>();

const hasValue = computed(() => typeof value === 'number' && Number.isFinite(value));
const normalizedValue = computed(() => {
    if (!hasValue.value || typeof value !== 'number') {
        return 0;
    }
    return clamp(Math.round(value), 0, 100);
});
</script>

<style scoped>
.app-progress-bar {
    width: 100%;
    height: 0.5rem;
    overflow: hidden;
    border-radius: 999px;
    background: var(--ui-bg-elevated);
}

.app-progress-bar-fill {
    height: 100%;
    border-radius: inherit;
    background: var(--ui-primary);
    transition: width 180ms ease-out;
}
</style>
