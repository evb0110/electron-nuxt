<template>
    <div class="workspace-document-transition-skeleton" aria-hidden="true">
        <div class="workspace-document-transition-skeleton__page-shell">
            <PdfPageSkeleton
                :padding="skeletonPadding"
                :content-height="skeletonContentHeight"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import { PdfPageSkeleton } from '@app/modules/pdf-viewer/public/component-exports/pdfPageSkeleton';

const skeletonPadding = {
    top: 56,
    right: 56,
    bottom: 56,
    left: 56,
};
const skeletonContentHeight = 760;
</script>

<style scoped>
.workspace-document-transition-skeleton {
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    align-items: flex-start;
    justify-content: center;
    padding: 0;
    overflow: hidden;
    background: var(--app-pdf-viewer-bg, var(--app-window-bg));
}

.workspace-document-transition-skeleton__page-shell {
    position: relative;
    box-sizing: border-box;
    width: calc(100% - 2rem);
    aspect-ratio: 1 / 1.409;
    margin-top: var(--app-workspace-transition-content-offset);
    overflow: hidden;
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-lg);
    background: var(--ui-bg);
    box-shadow: var(--shadow-popup);
}
</style>
