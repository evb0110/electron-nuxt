<template>
    <div
        class="pdf-initial-surface-placeholder"
        aria-hidden="true"
        data-evb-initial-visual-placeholder="true"
        :style="placeholderStyle"
    >
        <div class="pdf-initial-surface-placeholder__sheet">
            <div class="pdf-initial-surface-placeholder__header">
                <div class="pdf-initial-surface-placeholder__mark" />
                <div class="pdf-initial-surface-placeholder__heading">
                    <div class="pdf-initial-surface-placeholder__line pdf-initial-surface-placeholder__line--title" />
                    <div class="pdf-initial-surface-placeholder__line pdf-initial-surface-placeholder__line--short" />
                </div>
            </div>
            <div class="pdf-initial-surface-placeholder__body">
                <div
                    v-for="line in bodyLines"
                    :key="line"
                    class="pdf-initial-surface-placeholder__line"
                    :class="`pdf-initial-surface-placeholder__line--body-${line}`"
                />
            </div>
            <div class="pdf-initial-surface-placeholder__footer">
                <div class="pdf-initial-surface-placeholder__track">
                    <div class="pdf-initial-surface-placeholder__bar" />
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
const {
    pageHeight = 720,
    pageWidth = 960,
    padding = 16,
} = defineProps<{
    pageWidth?: number | undefined;
    pageHeight?: number | undefined;
    padding?: number | undefined;
}>();

const bodyLines = [
    1,
    2,
    3,
    4,
    5,
    6,
    7,
] as const;

const placeholderStyle = computed(() => ({
    '--pdf-initial-surface-page-height': `${Math.max(1, Math.round(pageHeight))}px`,
    '--pdf-initial-surface-page-width': `${Math.max(1, Math.round(pageWidth))}px`,
    '--pdf-initial-surface-padding': `${Math.max(0, Math.round(padding))}px`,
}));
</script>

<style scoped>
.pdf-initial-surface-placeholder {
    position: absolute;
    inset: 0;
    z-index: 50;
    display: grid;
    place-items: center;
    box-sizing: border-box;
    padding: var(--pdf-initial-surface-padding, 1rem);
    overflow: hidden;
    pointer-events: none;
    background: color-mix(in oklab, var(--app-pdf-viewer-bg, var(--app-window-bg)) 92%, var(--ui-bg-muted) 8%);
}

.pdf-initial-surface-placeholder__sheet {
    box-sizing: border-box;
    display: flex;
    width: min(var(--pdf-initial-surface-page-width, 960px), 100%);
    height: min(var(--pdf-initial-surface-page-height, 720px), 100%);
    min-width: min(20rem, 100%);
    min-height: min(26rem, 100%);
    flex-direction: column;
    gap: clamp(1rem, 4%, 2rem);
    border: 1px solid color-mix(in oklab, var(--ui-border) 82%, var(--ui-text-muted) 18%);
    border-radius: 8px;
    background: color-mix(in oklab, var(--ui-bg) 96%, var(--ui-bg-muted) 4%);
    box-shadow: var(--shadow-popup);
    padding: clamp(1.5rem, 4.5%, 3rem);
}

.pdf-initial-surface-placeholder__header {
    display: grid;
    grid-template-columns: clamp(2.5rem, 7%, 4rem) minmax(0, 1fr);
    gap: clamp(0.875rem, 3%, 1.5rem);
    align-items: center;
}

.pdf-initial-surface-placeholder__mark {
    width: 100%;
    aspect-ratio: 1;
    border: 1px solid color-mix(in oklab, var(--ui-border) 70%, var(--ui-primary) 30%);
    border-radius: 8px;
    background:
        linear-gradient(
            135deg,
            color-mix(in oklab, var(--ui-primary) 38%, var(--ui-bg-elevated) 62%),
            color-mix(in oklab, var(--ui-text-muted) 28%, var(--ui-bg-elevated) 72%)
        );
}

.pdf-initial-surface-placeholder__heading,
.pdf-initial-surface-placeholder__body,
.pdf-initial-surface-placeholder__footer {
    display: flex;
    min-width: 0;
    flex-direction: column;
}

.pdf-initial-surface-placeholder__heading {
    gap: 0.75rem;
}

.pdf-initial-surface-placeholder__body {
    gap: clamp(0.75rem, 2.2%, 1.125rem);
    padding-block-start: clamp(0.75rem, 2%, 1.5rem);
}

.pdf-initial-surface-placeholder__footer {
    margin-block-start: auto;
}

.pdf-initial-surface-placeholder__line,
.pdf-initial-surface-placeholder__track {
    border-radius: var(--app-radius-full);
}

.pdf-initial-surface-placeholder__line {
    height: 0.75rem;
    background: color-mix(in oklab, var(--ui-text-muted) 26%, var(--ui-bg-muted) 74%);
}

.pdf-initial-surface-placeholder__line--title {
    width: min(24rem, 64%);
}

.pdf-initial-surface-placeholder__line--short {
    width: min(16rem, 44%);
    opacity: 0.72;
}

.pdf-initial-surface-placeholder__line--body-1,
.pdf-initial-surface-placeholder__line--body-4,
.pdf-initial-surface-placeholder__line--body-7 {
    width: 88%;
}

.pdf-initial-surface-placeholder__line--body-2,
.pdf-initial-surface-placeholder__line--body-5 {
    width: 100%;
}

.pdf-initial-surface-placeholder__line--body-3 {
    width: 72%;
}

.pdf-initial-surface-placeholder__line--body-6 {
    width: 58%;
}

.pdf-initial-surface-placeholder__track {
    position: relative;
    width: min(18rem, 50%);
    height: 0.375rem;
    overflow: hidden;
    background: color-mix(in oklab, var(--ui-bg-muted) 72%, var(--ui-text-muted) 28%);
}

.pdf-initial-surface-placeholder__bar {
    position: absolute;
    inset-block: 0;
    left: -42%;
    width: 42%;
    border-radius: inherit;
    background: color-mix(in oklab, var(--ui-primary) 72%, var(--ui-text-highlighted) 28%);
    animation: pdf-initial-surface-placeholder-progress 1.1s ease-in-out infinite;
}

@keyframes pdf-initial-surface-placeholder-progress {
    from {
        transform: translateX(0);
    }

    to {
        transform: translateX(340%);
    }
}

@media (prefers-reduced-motion: reduce) {
    .pdf-initial-surface-placeholder__bar {
        left: 0;
        width: 100%;
        animation: none;
    }
}
</style>
