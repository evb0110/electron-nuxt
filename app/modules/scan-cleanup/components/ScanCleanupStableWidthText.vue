<template>
    <span class="scan-cleanup-stable-width-text">
        <span class="scan-cleanup-stable-width-sizer" aria-hidden="true">{{ widest }}</span>
        <span class="scan-cleanup-stable-width-value">{{ text }}</span>
    </span>
</template>

<script setup lang="ts">
defineProps<{
    text: string;
    widest: string;
}>();
</script>

<style scoped>
.scan-cleanup-stable-width-text {
    display: inline-grid;
    justify-items: center;
    font-variant-numeric: tabular-nums;
}

.scan-cleanup-stable-width-sizer,
.scan-cleanup-stable-width-value {
    grid-area: 1 / 1;
    white-space: nowrap;
}

.scan-cleanup-stable-width-sizer {
    visibility: hidden;
}
</style>
