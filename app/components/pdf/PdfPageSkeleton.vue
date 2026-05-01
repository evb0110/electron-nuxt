<template>
    <div class="pdf-page-skeleton" :style="paddingStyle">
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
                :key="`pdf-page-skeleton-paragraph-${i}`"
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

    const fixedReservedRem =
        headerHeight +
        headerMarginBottom +
        gapInner +
        paragraphHeight +
        gapInner +
        paragraphHeight +
        gapInner +
        formulaBlockMarginTop +
        formulaBlockHeight;

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
.pdf-page-skeleton {
    position: absolute;
    inset: 0;
    border-radius: 2px;
    box-shadow: var(--shadow-sm);
    background: var(--ui-bg);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    overflow: hidden;
    pointer-events: none;
    animation: pdf-page-skeleton-pulse 0.9s ease-in-out infinite;
    box-sizing: border-box;
}

.inner {
    position: relative;
    gap: 0.9rem;
    width: 100%;
    max-width: 100%;
    height: 100%;
    padding: 0;
    box-sizing: border-box;
}

.inner > * {
    position: relative;
    z-index: 1;
}

.header {
    margin-bottom: 0.5rem;
}

.title-line,
.subtitle-line,
.line,
.formula,
.formula-inline {
    border-radius: 999px;
}

.title-line {
    width: 60%;
    height: 1.2rem;
}

.subtitle-line {
    width: 42%;
    height: 0.95rem;
    opacity: 0.8;
}

.paragraph {
    gap: 0.65rem;
}

.line {
    width: 100%;
    height: 0.95rem;
}

.paragraph .line:nth-child(1) {
    height: 1.05rem;
}

.paragraph .line:nth-child(2) {
    height: 0.95rem;
}

.paragraph .line:nth-child(3) {
    height: 0.85rem;
}

.is-short {
    width: 78%;
}

.formula-block {
    margin-top: 0.55rem;
}

.formula {
    width: 100%;
    height: 1.3rem;
}

.formula-inline-row {
    display: flex;
    gap: 0.55rem;
    margin-top: 0.45rem;
}

.formula-inline {
    flex: 1;
    height: 0.95rem;
}

@keyframes pdf-page-skeleton-pulse {
    0%,
    100% {
        opacity: 0.45;
    }

    50% {
        opacity: 1;
    }
}
</style>
