<template>
    <div class="workspace-viewerHost">
        <slot v-if="hasDocument" name="document" />
        <div v-else-if="suppressEmptyState" class="workspace-transition-placeholder" />
        <slot v-else name="empty" />
    </div>
</template>

<script setup lang="ts">
defineProps<{
    hasDocument: boolean;
    suppressEmptyState: boolean;
}>();
</script>

<style scoped>
.workspace-viewer-host {
    width: 100%;
    height: 100%;
}

.workspace-transition-placeholder {
    width: 100%;
    height: 100%;
    background: var(--app-window-bg);
}
</style>
