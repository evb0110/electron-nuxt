<template>
    <div class="document-page-skeleton" :style="paddingStyle">
        <div class="inner flex flex-col">
            <div class="header flex flex-col gap-2">
                <USkeleton class="title-line" />
                <USkeleton class="subtitle-line" />
            </div>

            <div class="paragraph flex flex-col">
                <USkeleton class="line" />
                <USkeleton class="line" />
                <USkeleton class="line is-short" />
            </div>

            <div class="paragraph flex flex-col">
                <USkeleton class="line" />
                <USkeleton class="line" />
                <USkeleton class="line is-short" />
            </div>

            <div class="formula-block">
                <USkeleton class="formula" />
                <div class="formula-inline-row">
                    <USkeleton class="formula-inline" />
                    <USkeleton class="formula-inline" />
                </div>
            </div>

            <div
                v-for="i in repeatParagraphs"
                :key="`document-page-skeleton-paragraph-${i}`"
                class="paragraph flex flex-col"
            >
                <USkeleton class="line" />
                <USkeleton class="line" />
                <USkeleton class="line is-short" />
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
interface IPadding {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

interface IProps {
    padding: IPadding | null;
    contentHeight: number | null;
}

const emptyPadding: IPadding = {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
};

function resolvePadding(padding: IPadding | null) {
    return padding ?? emptyPadding;
}

const {
    padding,
    contentHeight,
} = defineProps<IProps>();

const resolvedPadding = computed<IPadding>(() => resolvePadding(padding));

const paddingStyle = computed(() => ({padding: `${resolvedPadding.value.top}px ${resolvedPadding.value.right}px ${resolvedPadding.value.bottom}px ${resolvedPadding.value.left}px`}));

const repeatParagraphs = computed(() => {
    const height = contentHeight ?? 0;
    const REM = 16;
    const gapInner = 0.9;
    const headerHeight = 1.2 + 0.5 + 0.95;
    const headerMarginBottom = 0.5;
    const paragraphHeight = 1.05 + 0.65 + 0.95 + 0.65 + 0.85;
    const formulaBlockMarginTop = 0.55;
    const formulaBlockHeight = 1.3 + 0.45 + 0.95;
    const fixedReservedRem = headerHeight
        + headerMarginBottom
        + gapInner
        + paragraphHeight
        + gapInner
        + paragraphHeight
        + gapInner
        + formulaBlockMarginTop
        + formulaBlockHeight;
    const strideRem = gapInner + paragraphHeight;
    const paddingY = (padding?.top ?? 0) + (padding?.bottom ?? 0);
    const availableHeight = Math.max(
        height - paddingY - fixedReservedRem * REM,
        0,
    );
    const count = Math.floor(availableHeight / (strideRem * REM));

    return Math.max(0, count);
});
</script>

<style scoped>
.document-page-skeleton {
    position: absolute;
    inset: 0;
    z-index: var(--app-z-document-page-skeleton);
    display: flex;
    box-sizing: border-box;
    align-items: flex-start;
    justify-content: center;
    overflow: hidden;
    pointer-events: none;
    background: inherit;
    border-radius: inherit;
}

.inner {
    position: relative;
    gap: var(--app-document-page-skeleton-gap);
    width: 100%;
    max-width: 100%;
    height: 100%;
    padding: 0;
    box-sizing: border-box;
    animation: document-page-skeleton-pulse 1s ease-in-out infinite;
}

.inner > * {
    position: relative;
    z-index: var(--app-z-document-pending-image);
}

.header {
    margin-bottom: var(--app-document-page-skeleton-header-margin);
}

.title-line,
.subtitle-line,
.line,
.formula,
.formula-inline {
    border-radius: var(--app-radius-full);
    background: color-mix(in oklab, var(--ui-text-muted) 18%, var(--ui-bg-muted) 82%);
}

.title-line {
    width: 60%;
    height: var(--app-document-page-skeleton-title-height);
    background: color-mix(in oklab, var(--ui-text-muted) 24%, var(--ui-bg-muted) 76%);
}

.subtitle-line {
    width: 42%;
    height: var(--app-document-page-skeleton-subtitle-height);
    opacity: 0.8;
}

.paragraph {
    gap: var(--app-document-page-skeleton-paragraph-gap);
}

.line {
    width: 100%;
    height: var(--app-document-page-skeleton-line-height);
}

.paragraph .line:nth-child(1) {
    height: var(--app-document-page-skeleton-line-tall-height);
}

.paragraph .line:nth-child(2) {
    height: var(--app-document-page-skeleton-line-height);
}

.paragraph .line:nth-child(3) {
    height: var(--app-document-page-skeleton-line-short-height);
}

.is-short {
    width: 78%;
}

.formula-block {
    margin-top: var(--app-document-page-skeleton-formula-margin);
}

.formula {
    width: 100%;
    height: var(--app-document-page-skeleton-formula-height);
}

.formula-inline-row {
    display: flex;
    gap: var(--app-document-page-skeleton-inline-gap);
    margin-top: var(--app-document-page-skeleton-inline-margin);
}

.formula-inline {
    flex: 1;
    height: var(--app-document-page-skeleton-line-height);
}

@keyframes document-page-skeleton-pulse {
    0%,
    100% {
        opacity: 0.72;
    }

    50% {
        opacity: 1;
    }
}

@media (prefers-reduced-motion: reduce) {
    .inner {
        animation: none;
    }
}
</style>
