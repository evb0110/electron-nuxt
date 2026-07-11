<template>
    <div
        class="pdf-initial-surface-placeholder"
        aria-hidden="true"
        data-evb-initial-visual-placeholder="true"
    >
        <div class="pdf-initial-surface-placeholder__page-shell">
            <PdfPageSkeleton
                :padding="skeletonPadding"
                :content-height="skeletonContentHeight"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
import PdfPageSkeleton from '@app/modules/pdf-viewer/components/PdfPageSkeleton.vue';

const skeletonPadding = {
    top: 56,
    right: 56,
    bottom: 56,
    left: 56,
};
const skeletonContentHeight = 760;
</script>

<style scoped>
.pdf-initial-surface-placeholder {
    position: absolute;
    inset: 0;
    z-index: var(--app-pdf-initial-surface-z-index);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    overflow: hidden;
    pointer-events: none;
    background: var(--app-pdf-viewer-bg, var(--app-window-bg));
}

.pdf-initial-surface-placeholder__page-shell {
    position: relative;
    box-sizing: border-box;
    width: calc(100% - 2rem);
    aspect-ratio: 1 / 1.409;
    margin-top: var(--app-initial-surface-offset);
    overflow: hidden;
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-lg);
    background: var(--ui-bg);
    box-shadow: var(--shadow-popup);
}
</style>
