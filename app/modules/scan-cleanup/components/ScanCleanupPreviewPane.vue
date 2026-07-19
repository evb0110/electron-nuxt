<template>
    <section
        class="preview-pane"
        :aria-label="t('scanCleanup.preview.title')"
        tabindex="0"
        @keydown.left.prevent="navigateFromKeyboard('previous')"
        @keydown.right.prevent="navigateFromKeyboard('next')"
    >
        <header class="preview-header">
            <div class="page-navigation">
                <UButton
                    type="button"
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    square
                    icon="i-ph-caret-left"
                    :aria-label="t('scanCleanup.preview.previous')"
                    :disabled="pageNumber <= 1"
                    @click="$emit('previous')"
                />
                <span class="page-label">{{ t('scanCleanup.preview.page', {page: pageNumber, total: totalPages}) }}</span>
                <UButton
                    type="button"
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    square
                    icon="i-ph-caret-right"
                    :aria-label="t('scanCleanup.preview.next')"
                    :disabled="pageNumber >= totalPages"
                    @click="$emit('next')"
                />
            </div>
            <div class="preview-controls">
                <div class="preview-segmented" role="radiogroup" :aria-label="t('scanCleanup.preview.comparison')">
                    <UButton
                        v-for="mode in viewModes"
                        :key="mode.value"
                        type="button"
                        color="neutral"
                        size="sm"
                        :variant="effectiveViewMode === mode.value ? 'soft' : 'ghost'"
                        :aria-checked="effectiveViewMode === mode.value"
                        role="radio"
                        :label="mode.label"
                        @click="$emit('update:viewMode', mode.value)"
                    />
                </div>
                <div class="preview-segmented" role="radiogroup" :aria-label="t('scanCleanup.preview.zoom')">
                    <UButton
                        type="button"
                        color="neutral"
                        size="sm"
                        :variant="effectiveZoomMode === 'fit' ? 'soft' : 'ghost'"
                        :aria-checked="effectiveZoomMode === 'fit'"
                        role="radio"
                        :label="t('scanCleanup.preview.fit')"
                        @click="$emit('update:zoomMode', 'fit')"
                    />
                    <UButton
                        type="button"
                        color="neutral"
                        size="sm"
                        :variant="effectiveZoomMode === 'actual' ? 'soft' : 'ghost'"
                        :aria-checked="effectiveZoomMode === 'actual'"
                        role="radio"
                        label="100%"
                        @click="$emit('update:zoomMode', 'actual')"
                    />
                </div>
            </div>
        </header>

        <div
            class="preview-surface"
            :class="[
                {'is-actual': effectiveZoomMode === 'actual'},
                effectiveZoomMode === 'actual' && 'app-scrollbar app-scroll-region--balanced',
            ]"
            aria-live="polite"
        >
            <template v-if="result">
                <div v-if="result.outputs.length === 0 && effectiveViewMode === 'cleaned'" class="preview-message">
                    <span>{{ result.pageMetadata.excluded
                        ? t('scanCleanup.preview.excluded')
                        : t('scanCleanup.preview.blankSkipped') }}</span>
                </div>
                <div v-else ref="cutterStage" class="cutter-stage">
                    <div v-if="effectiveViewMode === 'original'" class="raw-preview" :class="{'is-actual': effectiveZoomMode === 'actual'}">
                        <img
                            :src="rawUrl"
                            :alt="t('scanCleanup.preview.originalAlt', {page: pageNumber})"
                            :style="effectiveZoomMode === 'actual' ? {width: `${result.rawWidth}px`, maxWidth: 'none', maxHeight: 'none'} : undefined"
                        >
                    </div>
                    <div v-else class="cleaned-outputs" :class="{'is-spread': result.outputs.length > 1, 'is-actual': effectiveZoomMode === 'actual'}">
                        <div
                            v-for="(output, index) in renderedOutputs"
                            :key="`${result.pageNumber}-${output.metadata.half}-${index}`"
                            class="output-column"
                        >
                            <span v-if="result.outputs.length > 1" class="half-label">
                                {{ output.metadata.half === 'left'
                                    ? t('scanCleanup.preview.leftPage')
                                    : t('scanCleanup.preview.rightPage') }}
                            </span>
                            <div
                                class="uniform-canvas"
                                :class="{'has-uniform-canvas': matchPageSize, 'is-actual': effectiveZoomMode === 'actual'}"
                                :style="{
                                    aspectRatio: `${output.placement.canvasWidth} / ${output.placement.canvasHeight}`,
                                    ...(effectiveZoomMode === 'actual' ? {width: `${output.placement.canvasWidth}px`} : {}),
                                }"
                            >
                                <img
                                    class="cleaned-image"
                                    :src="output.url"
                                    :alt="t('scanCleanup.preview.cleanedAlt', {page: pageNumber})"
                                    :style="output.imageStyle"
                                >
                                <span class="margin-overlay" :style="output.imageStyle" aria-hidden="true" />
                                <span
                                    v-if="output.contentStyle"
                                    class="content-overlay"
                                    :style="output.contentStyle"
                                    aria-hidden="true"
                                />
                            </div>
                        </div>
                    </div>
                    <button
                        v-if="showCutter"
                        class="cutter-control"
                        type="button"
                        :style="cutterStyle"
                        :aria-label="t('scanCleanup.preview.cutter')"
                        aria-describedby="scan-cleanup-cutter-hint"
                        @pointerdown="startCutterDrag"
                        @pointermove="dragCutter"
                        @pointerup="finishCutterDrag"
                        @pointercancel="finishCutterDrag"
                        @dblclick.prevent="$emit('update:manualSplitX', null)"
                        @keydown.left.prevent="nudgeCutter(-1, $event.shiftKey)"
                        @keydown.right.prevent="nudgeCutter(1, $event.shiftKey)"
                    >
                        <span aria-hidden="true" />
                    </button>
                    <span id="scan-cleanup-cutter-hint" class="sr-only">
                        {{ t('scanCleanup.preview.cutterHint') }}
                    </span>
                </div>
                <div v-if="loading || error" class="refresh-indicator" :class="{'is-error': error}">
                    <UIcon :name="error ? 'i-ph-warning-circle' : 'i-ph-circle-notch'" class="size-4" :class="{'is-spinning': !error}" />
                    <span class="sr-only">{{ error || t('scanCleanup.preview.refreshing') }}</span>
                </div>
            </template>
            <div v-else-if="loading" class="preview-loading" role="status">
                <USkeleton class="preview-skeleton" />
                <span>{{ t('scanCleanup.preview.loading') }}</span>
            </div>
            <div v-else-if="error" class="preview-message is-error" role="status">
                <UIcon name="i-ph-warning-circle" class="size-6" />
                <span>{{ t('scanCleanup.preview.unavailable') }}</span>
                <span class="preview-error-detail">{{ error }}</span>
            </div>
            <div v-else class="preview-message" role="status">
                <UIcon name="i-ph-image" class="size-6" />
                <span>{{ t('scanCleanup.preview.waiting') }}</span>
            </div>
        </div>

        <div v-if="effectiveViewMode === 'cleaned'" class="overlay-legend" :aria-label="t('scanCleanup.preview.legend')">
            <span><i class="legend-swatch is-content" />{{ t('scanCleanup.preview.contentBox') }}</span>
            <span><i class="legend-swatch is-margin" />{{ t('scanCleanup.preview.marginBox') }}</span>
            <span v-if="matchPageSize"><i class="legend-swatch is-canvas" />{{ t('scanCleanup.preview.canvas') }}</span>
        </div>
    </section>
</template>

<script setup lang="ts">
import type {
    IScanCleanupPreviewResult,
    TScanCleanupPageAlignment,
} from '@contracts/electronApiScanCleanup';
import {
    resolvePreviewCanvasSize,
    resolvePreviewPlacement,
    scanCleanupAnalysisWidth,
    scanCleanupCutterRatio,
    scanCleanupCutterXFromRatio,
    toPreviewStyleRect,
    transformPreviewContentBox,
} from '@app/modules/scan-cleanup/utils/scanCleanupPreviewGeometry';

const props = defineProps<{
    result: IScanCleanupPreviewResult | null;
    loading: boolean;
    error: string;
    viewMode?: 'original' | 'cleaned';
    zoomMode?: 'fit' | 'actual';
    /** @deprecated Compatibility for the superseded popup. */
    showBefore?: boolean;
    matchPageSize: boolean;
    alignment: TScanCleanupPageAlignment;
    pageNumber: number;
    totalPages: number;
    manualSplitX: number | null;
    readingOrder: 'ltr' | 'rtl';
}>();

const emit = defineEmits<{
    previous: [];
    next: [];
    'update:viewMode': [value: 'original' | 'cleaned'];
    'update:zoomMode': [value: 'fit' | 'actual'];
    'update:manualSplitX': [value: number | null];
}>();

const {t} = useTypedI18n();
const rawUrl = ref('');
const cleanedUrls = ref<string[]>([]);
const cutterStage = ref<HTMLElement | null>(null);
const draggingCutter = ref(false);
const effectiveViewMode = computed(() => props.viewMode ?? (props.showBefore ? 'original' : 'cleaned'));
const effectiveZoomMode = computed(() => props.zoomMode ?? 'fit');
const viewModes = computed(() => [
    {
        value: 'original' as const,
        label: t('scanCleanup.preview.original'),
    },
    {
        value: 'cleaned' as const,
        label: t('scanCleanup.preview.cleaned'),
    },
]);
const analysisWidth = computed(() => {
    const metadata = props.result?.pageMetadata;
    if (!metadata || !props.result) {
        return 1;
    }
    return scanCleanupAnalysisWidth(metadata, props.result.rawWidth, props.result.rawHeight);
});
const cutterX = computed(() => props.manualSplitX ?? props.result?.pageMetadata.cutterX ?? analysisWidth.value / 2);
const showCutter = computed(() => Boolean(props.result)
    && (props.manualSplitX !== null
        || props.result?.pageMetadata.layoutClassification !== 'single-uncut-page'));
const cutterStyle = computed(() => ({insetInlineStart: `${scanCleanupCutterRatio(cutterX.value, analysisWidth.value) * 100}%`}));

function navigateFromKeyboard(direction: 'previous' | 'next') {
    if (direction === 'previous' && props.pageNumber > 1) emit('previous');
    if (direction === 'next' && props.pageNumber < props.totalPages) emit('next');
}

function updateCutterFromClientX(clientX: number) {
    const rect = cutterStage.value?.getBoundingClientRect();
    if (!rect || rect.width <= 0) {
        return;
    }
    const ratio = (clientX - rect.left) / rect.width;
    emit('update:manualSplitX', scanCleanupCutterXFromRatio(ratio, analysisWidth.value));
}

function startCutterDrag(event: PointerEvent) {
    draggingCutter.value = true;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    updateCutterFromClientX(event.clientX);
}

function dragCutter(event: PointerEvent) {
    if (draggingCutter.value) updateCutterFromClientX(event.clientX);
}

function finishCutterDrag(event: PointerEvent) {
    if (!draggingCutter.value) {
        return;
    }
    draggingCutter.value = false;
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
}

function nudgeCutter(direction: -1 | 1, coarse: boolean) {
    const step = analysisWidth.value * (coarse ? 0.05 : 0.01);
    emit('update:manualSplitX', Math.min(
        analysisWidth.value * 0.98,
        Math.max(analysisWidth.value * 0.02, cutterX.value + direction * step),
    ));
}

function revokeUrls() {
    if (rawUrl.value) URL.revokeObjectURL(rawUrl.value);
    for (const url of cleanedUrls.value) URL.revokeObjectURL(url);
    rawUrl.value = '';
    cleanedUrls.value = [];
}

function pngUrl(bytes: Uint8Array) {
    return URL.createObjectURL(new Blob([new Uint8Array(bytes)], {type: 'image/png'}));
}

watch(() => props.result, result => {
    revokeUrls();
    if (!result) {
        return;
    }
    rawUrl.value = pngUrl(result.rawImageData);
    cleanedUrls.value = result.outputs.map(output => pngUrl(output.imageData));
}, {immediate: true});

onBeforeUnmount(revokeUrls);

const renderedOutputs = computed(() => {
    if (!props.result) {
        return [];
    }
    const canvas = resolvePreviewCanvasSize(
        props.result.outputs.map(output => output.metadata),
        props.matchPageSize,
    );
    const outputs = props.result.outputs.map((output, index) => {
        const metadata = output.metadata;
        const placement = resolvePreviewPlacement(
            metadata.outputWidth,
            metadata.outputHeight,
            canvas?.width ?? metadata.outputWidth,
            canvas?.height ?? metadata.outputHeight,
            props.alignment,
        );
        const imageStyle = toPreviewStyleRect({
            x: 0,
            y: 0,
            width: metadata.outputWidth,
            height: metadata.outputHeight,
        }, placement);
        const content = transformPreviewContentBox(metadata);
        return {
            metadata,
            url: cleanedUrls.value[index] ?? '',
            placement,
            imageStyle,
            contentStyle: content ? toPreviewStyleRect(content, placement) : null,
        };
    });
    return props.readingOrder === 'rtl' && outputs.length > 1 ? outputs.reverse() : outputs;
});
</script>

<style scoped>
.preview-pane {
    display: flex;
    height: 100%;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    gap: var(--app-space-3xl);
}

.preview-pane:focus-visible {
    border-radius: var(--app-radius-lg);
    outline: 2px solid var(--ui-primary);
    outline-offset: var(--app-space-xs);
}

.preview-header,
.page-navigation,
.preview-controls,
.preview-segmented,
.overlay-legend,
.refresh-indicator {
    display: flex;
    align-items: center;
}

.refresh-indicator.is-error {
    border-color: var(--ui-error);
    color: var(--ui-error);
}

.preview-header {
    justify-content: space-between;
    gap: var(--app-space-3xl);
}

.preview-controls {
    gap: var(--app-space-9xl);
}

.preview-segmented {
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-md);
    padding: var(--app-space-xs);
    background: var(--ui-bg);
}

.page-navigation {
    gap: var(--app-space-sm);
}

.page-label {
    min-width: var(--app-scan-preview-page-label-width);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-secondary);
    text-align: center;
}

.preview-surface {
    position: relative;
    display: grid;
    min-height: 0;
    flex: 1;
    place-items: center;
    overflow: hidden;
    padding: var(--app-space-9xl);
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-lg);
    background: var(--ui-bg-muted);
}

.preview-surface.is-actual {
    place-items: start;
    overflow: auto;
}

.raw-preview {
    display: flex;
    width: 100%;
    height: 100%;
    min-height: 0;
    align-items: center;
    justify-content: center;
}

.cutter-stage {
    position: relative;
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
}

.cutter-control {
    position: absolute;
    inset-block: 0;
    z-index: var(--app-z-local-raised);
    width: var(--app-space-9xl);
    border: 0;
    background: transparent;
    cursor: col-resize;
    transform: translateX(-50%);
}

.cutter-control > span {
    position: absolute;
    inset-block: 0;
    inset-inline-start: 50%;
    width: var(--app-space-xs);
    background: var(--ui-primary);
    box-shadow: 0 0 0 1px var(--ui-bg);
}

.cutter-control:focus-visible {
    outline: 2px solid var(--ui-primary);
    outline-offset: var(--app-space-xs);
}

.cleaned-outputs {
    display: flex;
    width: 100%;
    height: 100%;
    min-height: 0;
    align-items: stretch;
    justify-content: center;
}

.raw-preview.is-actual,
.cleaned-outputs.is-actual {
    width: max-content;
    height: max-content;
    align-items: flex-start;
    justify-content: flex-start;
}

.raw-preview img {
    display: block;
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    box-shadow: var(--app-document-page-shadow);
}

.cleaned-outputs {
    gap: var(--app-space-3xl);
}

.output-column {
    display: flex;
    min-width: 0;
    min-height: 0;
    max-width: 100%;
    flex: 1;
    flex-direction: column;
    align-items: center;
    gap: var(--app-space-sm);
}

.half-label {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
}

.uniform-canvas {
    position: relative;
    width: auto;
    min-height: 0;
    max-width: 100%;
    flex: 1 1 0;
    border: 1px dashed transparent;
    background: var(--ui-bg);
    box-shadow: var(--app-document-page-shadow);
}

.uniform-canvas.is-actual {
    max-width: none;
    max-height: none;
    flex: none;
}

.uniform-canvas.has-uniform-canvas {
    border-color: var(--ui-border);
    background: var(--ui-bg-elevated);
}

.cleaned-image,
.margin-overlay,
.content-overlay {
    position: absolute;
    display: block;
}

.cleaned-image {
    object-fit: fill;
}

.margin-overlay {
    box-sizing: border-box;
    border: 2px solid var(--ui-warning);
    pointer-events: none;
}

.content-overlay {
    border: 2px solid var(--ui-primary);
    background: color-mix(in srgb, var(--ui-primary) 10%, transparent);
    pointer-events: none;
}

.preview-loading,
.preview-message {
    display: flex;
    max-width: var(--app-scan-preview-message-width);
    flex-direction: column;
    align-items: center;
    gap: var(--app-space-3xl);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-body-sm);
    text-align: center;
}

.preview-skeleton {
    width: min(var(--app-scan-preview-page-width), 70%);
    height: var(--app-scan-preview-skeleton-height);
}

.preview-message.is-error,
.preview-error-detail {
    color: var(--ui-error);
}

.preview-error-detail {
    font-size: var(--app-text-size-kicker);
}

.refresh-indicator {
    position: absolute;
    right: var(--app-space-3xl);
    top: var(--app-space-3xl);
    gap: var(--app-space-sm);
    padding: var(--app-space-sm) var(--app-space-3xl);
    border: 1px solid var(--ui-border);
    border-radius: var(--app-radius-full);
    background: var(--ui-bg);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
}

.is-spinning {
    animation: scan-preview-spin 1s linear infinite;
}

@keyframes scan-preview-spin {
    to {
        transform: rotate(1turn);
    }
}

.overlay-legend {
    flex-wrap: wrap;
    gap: var(--app-space-5xl);
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-kicker);
}

.overlay-legend > span {
    display: inline-flex;
    align-items: center;
    gap: var(--app-space-sm);
}

.legend-swatch {
    display: inline-block;
    width: var(--app-space-9xl);
    height: var(--app-space-9xl);
    border: 2px solid;
    border-radius: var(--app-radius-xs);
}

.legend-swatch.is-content {
    border-color: var(--ui-primary);
}

.legend-swatch.is-margin {
    border-color: var(--ui-warning);
}

.legend-swatch.is-canvas {
    border-style: dashed;
    border-color: var(--ui-border);
}

@media (width <= 48rem) {
    .preview-controls {
        gap: var(--app-space-sm);
    }
}
</style>
