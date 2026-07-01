<template>
    <div class="workspace-viewer-host">
        <template v-if="hasDocument">
            <slot name="document" />
            <div
                v-if="showTransitionOverlay"
                class="workspace-viewer-host__transition-overlay"
            >
                <slot name="transition" />
            </div>
        </template>
        <slot v-else-if="suppressEmptyState" name="transition" />
        <slot v-else name="empty" />
    </div>
</template>

<script setup lang="ts">
defineProps<{
    hasDocument: boolean;
    showTransitionOverlay?: boolean | undefined;
    suppressEmptyState: boolean;
}>();
</script>

<style scoped>
.workspace-viewer-host {
    position: relative;
    width: 100%;
    height: 100%;
}

.workspace-viewer-host__transition-overlay {
    position: absolute;
    inset: 0;
    z-index: 10;
    pointer-events: auto;
}
</style>
