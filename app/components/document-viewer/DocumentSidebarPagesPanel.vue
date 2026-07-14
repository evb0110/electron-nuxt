<template>
    <section class="document-sidebar-pages-panel" data-document-sidebar-pages-panel>
        <slot name="header" />
        <div class="document-sidebar-pages-panel__rail" :class="railClass">
            <slot />
        </div>
        <slot name="footer" />
    </section>
</template>

<script setup lang="ts">
defineProps<{railClass?: string | undefined;}>();
</script>

<style scoped>
.document-sidebar-pages-panel {
    display: flex;
    width: 100%;
    height: 100%;
    min-height: 0;
    flex-direction: column;
}

.document-sidebar-pages-panel__rail {
    flex: 1;
    min-height: var(--app-sidebar-content-min-height);
    overflow: hidden;
}
</style>
