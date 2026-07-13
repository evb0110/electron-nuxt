<template>
    <div class="workspace-viewer-host">
        <div
            v-show="documentLayoutVisible"
            class="workspace-viewer-host__document"
            :aria-hidden="!hasDocument ? 'true' : undefined"
        >
            <slot name="document" />
        </div>
        <slot v-if="!hasDocument && !suppressEmptyState" name="empty" />
    </div>
</template>

<script setup lang="ts">
import { shouldKeepWorkspaceDocumentLayoutVisible } from '@app/modules/workspace-shell/host/shouldKeepWorkspaceDocumentLayoutVisible';

const props = defineProps<{
    hasDocument: boolean;
    keepDocumentLayoutMounted?: boolean;
    suppressEmptyState: boolean;
}>();
const documentLayoutVisible = computed(() => shouldKeepWorkspaceDocumentLayoutVisible({
    hasDocument: props.hasDocument,
    keepDocumentLayoutMounted: props.keepDocumentLayoutMounted === true,
}));
</script>

<style scoped>
.workspace-viewer-host {
    position: relative;
    width: 100%;
    height: 100%;
}

.workspace-viewer-host__document {
    width: 100%;
    height: 100%;
}

</style>
