<template>
    <section
        class="preview-pane"
        :aria-label="t('scanCleanup.preview.title')"
        tabindex="0"
        @keydown="handlePaneKeydown"
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
                <ScanCleanupSegmented
                    :model-value="effectiveViewMode"
                    :items="viewModes"
                    :group-label="t('scanCleanup.preview.comparison')"
                    @update:model-value="$emit('update:viewMode', $event as 'original' | 'cleaned')"
                />
                <ScanCleanupSegmented
                    :model-value="effectiveZoomMode"
                    :items="zoomModes"
                    :group-label="t('scanCleanup.preview.zoom')"
                    @update:model-value="$emit('update:zoomMode', $event as 'fit' | 'actual')"
                />
            </div>
        </header>

        <div
            class="preview-surface"
            :class="[
                {'is-actual': effectiveZoomMode === 'actual'},
                {'is-stale-page': isStalePage},
                effectiveZoomMode === 'actual' && 'app-scrollbar app-scroll-region--balanced',
            ]"
            aria-live="polite"
        >
            <Transition name="scan-preview-crossfade">
                <div
                    v-if="result"
                    :key="previewTransitionKey"
                    class="preview-result-layer"
                >
                <div
                    v-if="result.outputs.length === 0 && effectiveViewMode === 'cleaned'"
                    class="preview-message"
                    :class="{'is-stale-content': isStalePage}"
                >
                    <span>{{ result.pageMetadata.excluded
                        ? t('scanCleanup.preview.excluded')
                        : t('scanCleanup.preview.blankSkipped') }}</span>
                </div>
                <div v-else ref="cutterStage" class="cutter-stage" :class="{'is-stale-content': isStalePage}">
                    <div v-if="effectiveViewMode === 'original'" class="raw-preview" :class="{'is-actual': effectiveZoomMode === 'actual'}">
                        <img
                            :src="rawUrl"
                            :alt="t('scanCleanup.preview.originalAlt', {page: result.pageNumber})"
                            :style="effectiveZoomMode === 'actual' ? {width: `${result.rawWidth}px`, maxWidth: 'none', maxHeight: 'none'} : undefined"
                        >
                        <span
                            v-for="(style, index) in losslessCropOverlayStyles"
                            :key="`lossless-crop-${String(index)}`"
                            class="lossless-crop-overlay"
                            :style="style"
                            aria-hidden="true"
                        />
                    </div>
                    <div v-else class="cleaned-outputs" :class="{'is-spread': result.outputs.length > 1, 'is-actual': effectiveZoomMode === 'actual'}">
                        <div
                            v-for="(output, index) in renderedOutputs"
                            :key="`${result.pageNumber}-${output.metadata.half}-${index}`"
                            class="output-column"
                        >
                            <div :ref="element => setOutputFitArea(index, element)" class="output-fit-area">
                                <div
                                    class="uniform-canvas"
                                    :class="{'has-uniform-canvas': matchPageSize, 'is-actual': effectiveZoomMode === 'actual'}"
                                    :style="output.canvasStyle"
                                >
                                    <div
                                        class="placed-image"
                                        :class="{'is-draggable': matchPageSize}"
                                        :style="output.imageStyle"
                                        :tabindex="matchPageSize ? 0 : -1"
                                        :role="matchPageSize ? 'button' : undefined"
                                        :aria-label="matchPageSize ? t('scanCleanup.preview.placement', {half: outputHalfLabel(output.metadata.half)}) : undefined"
                                        @pointerdown="startPlacementDrag($event, output)"
                                        @pointermove="dragPlacement($event, output)"
                                        @pointerup="finishPlacementDrag"
                                        @pointercancel="finishPlacementDrag"
                                        @keydown.esc.stop.prevent="cancelPlacementDrag"
                                        @keydown="nudgePlacement($event, output)"
                                    >
                                        <img
                                            class="cleaned-image"
                                            :src="output.url"
                                            :alt="t('scanCleanup.preview.cleanedAlt', {
                                                page: result.pageNumber,
                                                half: outputHalfLabel(output.metadata.half),
                                            })"
                                        >
                                        <span class="margin-overlay" aria-hidden="true" />
                                    </div>
                                    <div
                                        v-if="output.contentStyle"
                                        class="content-overlay"
                                        :style="output.contentStyle"
                                        tabindex="0"
                                        role="group"
                                        :aria-label="t('scanCleanup.preview.contentBoxFor', {half: outputHalfLabel(output.metadata.half)})"
                                        @dblclick.stop="$emit('update:manualContentBox', output.metadata.half, null)"
                                    >
                                        <button
                                            v-for="handle in contentHandles"
                                            :key="handle"
                                            type="button"
                                            class="content-handle"
                                            :class="`is-${handle}`"
                                            :aria-label="contentHandleLabel(handle, output.metadata.half)"
                                            @pointerdown.stop="startContentDrag($event, output, handle)"
                                            @pointermove.stop="dragContentBox($event, output)"
                                            @pointerup.stop="finishContentDrag"
                                            @pointercancel.stop="finishContentDrag"
                                            @keydown.esc.stop.prevent="cancelContentDrag"
                                            @keydown="nudgeContentBox($event, output, handle)"
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <button
                        v-if="showCutter"
                        class="cutter-control"
                        :class="{'is-refreshing': loading}"
                        type="button"
                        :style="cutterStyle"
                        :aria-label="t('scanCleanup.preview.cutter')"
                        aria-describedby="scan-cleanup-cutter-hint"
                        @pointerdown="startCutterDrag"
                        @pointermove="dragCutter"
                        @pointerup="finishCutterDrag"
                        @pointercancel="finishCutterDrag"
                        @keydown.esc.stop.prevent="cancelCutterDrag"
                        @dblclick.prevent="$emit('update:manualSplitX', null)"
                        @keydown.left.prevent="nudgeCutter(-1, $event.shiftKey)"
                        @keydown.right.prevent="nudgeCutter(1, $event.shiftKey)"
                    >
                        <span class="cutter-line" aria-hidden="true" />
                        <span class="cutter-grab-handle" aria-hidden="true">
                            <UIcon name="i-ph-dots-six-vertical" class="size-4" />
                        </span>
                    </button>
                    <span id="scan-cleanup-cutter-hint" class="sr-only">
                        {{ t('scanCleanup.preview.cutterHint') }}
                    </span>
                </div>
                <div v-if="loading && isStalePage" class="page-loading-overlay" role="status">
                    <UIcon name="i-ph-circle-notch" class="size-6 is-spinning" />
                    <span>{{ t('scanCleanup.preview.loadingPage', {page: pageNumber}) }}</span>
                </div>
                <div v-else-if="loading" class="refresh-indicator">
                    <UIcon name="i-ph-circle-notch" class="size-4 is-spinning" />
                    <span class="sr-only">{{ t('scanCleanup.preview.refreshing') }}</span>
                </div>
                <div v-if="error" class="preview-refresh-error" role="alert">
                    <span>{{ t('scanCleanup.preview.unavailable') }}</span>
                    <UButton
                        type="button"
                        color="neutral"
                        variant="outline"
                        size="xs"
                        :label="t('scanCleanup.preview.retry')"
                        @click="$emit('retry')"
                    />
                    <details class="preview-error-disclosure">
                        <summary>{{ t('scanCleanup.preview.technicalDetails') }}</summary>
                        <span class="preview-error-detail">{{ error }}</span>
                    </details>
                </div>
                </div>
            </Transition>
            <Transition name="scan-preview-crossfade">
                <div v-if="!result" class="preview-empty-layer">
                    <div v-if="loading" class="preview-loading" role="status">
                        <USkeleton class="preview-skeleton" />
                        <span>{{ t('scanCleanup.preview.loading') }}</span>
                    </div>
                    <div v-else-if="error" class="preview-message is-error" role="alert">
                        <UIcon name="i-ph-warning-circle" class="size-6" />
                        <span>{{ t('scanCleanup.preview.unavailable') }}</span>
                        <UButton
                            type="button"
                            color="neutral"
                            variant="outline"
                            size="sm"
                            :label="t('scanCleanup.preview.retry')"
                            @click="$emit('retry')"
                        />
                        <details class="preview-error-disclosure">
                            <summary>{{ t('scanCleanup.preview.technicalDetails') }}</summary>
                            <span class="preview-error-detail">{{ error }}</span>
                        </details>
                    </div>
                    <div v-else class="preview-message" role="status">
                        <UIcon name="i-ph-image" class="size-6" />
                        <span>{{ t('scanCleanup.preview.waiting') }}</span>
                    </div>
                </div>
            </Transition>
            <aside
                v-if="showFirstRunGuidance"
                class="scan-cleanup-first-run-guidance"
                :aria-label="t('scanCleanup.firstRun.title')"
            >
                <strong>{{ t('scanCleanup.firstRun.title') }}</strong>
                <ol>
                    <li>{{ t('scanCleanup.firstRun.detect') }}</li>
                    <li>{{ t('scanCleanup.firstRun.review') }}</li>
                    <li>{{ t('scanCleanup.firstRun.cleanUp') }}</li>
                </ol>
                <UButton
                    type="button"
                    color="primary"
                    size="sm"
                    :label="t('scanCleanup.firstRun.dismiss')"
                    @click="$emit('dismiss-first-run-guidance')"
                />
            </aside>
        </div>

        <div v-if="effectiveViewMode === 'cleaned' || lossless" class="overlay-legend" :aria-label="t('scanCleanup.preview.legend')">
            <span><i class="legend-swatch is-content" />{{ t('scanCleanup.preview.contentBox') }}</span>
            <span><i class="legend-swatch is-margin" />{{ t('scanCleanup.preview.marginBox') }}</span>
            <span v-if="matchPageSize"><i class="legend-swatch is-canvas" />{{ t('scanCleanup.preview.canvas') }}</span>
        </div>
    </section>
</template>

<script setup lang="ts">
import type {
    IScanCleanupPreviewMetadata,
    IScanCleanupPreviewRect,
    IScanCleanupPreviewResult,
    TScanCleanupOutputHalf,
    TScanCleanupPageAlignment,
} from '@contracts/electronApiScanCleanup';
import type {ComponentPublicInstance} from 'vue';
import ScanCleanupSegmented from '@app/modules/scan-cleanup/components/ScanCleanupSegmented.vue';
import {
    clampPreviewRect,
    previewPointToSourceHalf,
    resolvePreviewCanvasSize,
    resolvePreviewFitPlacement,
    resolvePreviewOutputFitRects,
    resolvePreviewOutputFitSizes,
    resolvePreviewPlacement,
    resolvePreviewSpreadCutterCenter,
    scanCleanupAnalysisWidth,
    scanCleanupCutterRatio,
    scanCleanupCutterXFromRatio,
    toPreviewStyleRect,
    transformPreviewContentBox,
    transformPreviewSourceHalfRect,
} from '@app/modules/scan-cleanup/utils/scanCleanupPreviewGeometry';

type TContentHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

interface IRenderedOutput {
    canvasStyle: Record<string, string>;
    contentRect: IScanCleanupPreviewRect | null;
    contentStyle: ReturnType<typeof toPreviewStyleRect> | null;
    imageStyle: ReturnType<typeof toPreviewStyleRect>;
    metadata: IScanCleanupPreviewMetadata;
    placement: ReturnType<typeof resolvePreviewPlacement>;
    url: string;
}

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
    stalePage?: boolean;
    showFirstRunGuidance?: boolean;
    manualSplitX: number | null;
    readingOrder: 'ltr' | 'rtl';
    manualContentBoxes?: Partial<Record<TScanCleanupOutputHalf, IScanCleanupPreviewRect>>;
    placementOverrides?: Partial<Record<TScanCleanupOutputHalf, TScanCleanupPageAlignment>>;
    lossless?: boolean;
}>();

const emit = defineEmits<{
    'dismiss-first-run-guidance': [];
    previous: [];
    next: [];
    retry: [];
    'update:viewMode': [value: 'original' | 'cleaned'];
    'update:zoomMode': [value: 'fit' | 'actual'];
    'update:manualSplitX': [value: number | null];
    'update:manualContentBox': [half: TScanCleanupOutputHalf, value: IScanCleanupPreviewRect | null];
    'update:placement': [half: TScanCleanupOutputHalf, value: TScanCleanupPageAlignment];
}>();

const {t} = useTypedI18n();
const rawUrl = ref('');
const cleanedUrls = ref<string[]>([]);
const cutterStage = ref<HTMLElement | null>(null);
const draggingCutter = ref(false);
const outputFitAreas = new Map<number, HTMLElement>();
const outputFitAreaSizes = reactive<Record<number, {
    left: number;
    top: number;
    width: number;
    height: number
}>>({});
let outputResizeObserver: ResizeObserver | null = null;
const contentHandles: readonly TContentHandle[] = [
    'n',
    'ne',
    'e',
    'se',
    's',
    'sw',
    'w',
    'nw',
];
const contentDrag = shallowRef<{
    half: TScanCleanupOutputHalf;
    handle: TContentHandle;
    pointerId: number;
    rect: IScanCleanupPreviewRect;
} | null>(null);
const placementDrag = shallowRef<{
    half: TScanCleanupOutputHalf;
    pointerId: number
} | null>(null);
const cutterStageSize = reactive({
    height: 0,
    width: 0,
});
let cutterResizeObserver: ResizeObserver | null = null;
const effectiveViewMode = computed(() => props.lossless
    ? 'original'
    : props.viewMode ?? (props.showBefore ? 'original' : 'cleaned'));
const effectiveZoomMode = computed(() => props.zoomMode ?? 'fit');
const isStalePage = computed(() => props.stalePage
    ?? Boolean(props.result && props.result.pageNumber !== props.pageNumber));
const previewTransitionKey = ref(0);
const viewModes = computed(() => props.lossless ? [{
    value: 'original' as const,
    label: t('scanCleanup.preview.preview'),
}] : [
    {
        value: 'original' as const,
        label: t('scanCleanup.preview.original'),
    },
    {
        value: 'cleaned' as const,
        label: t('scanCleanup.preview.cleaned'),
    },
]);
const zoomModes = computed(() => [
    {
        value: 'fit' as const,
        label: t('scanCleanup.preview.fit'),
    },
    {
        value: 'actual' as const,
        label: '100%',
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
    && effectiveZoomMode.value === 'fit'
    && (
        props.result?.pageMetadata.layoutClassification === 'two-page-spread'
        || props.manualSplitX !== null
    ));
const originalFitPlacement = computed(() => resolvePreviewFitPlacement(
    cutterStageSize.width,
    cutterStageSize.height,
    props.result?.rawWidth ?? 1,
    props.result?.rawHeight ?? 1,
));
function unrotatePreviewRect(rect: IScanCleanupPreviewRect, metadata: IScanCleanupPreviewMetadata) {
    const points = [
        {
            x: rect.x,
            y: rect.y,
        },
        {
            x: rect.x + rect.width,
            y: rect.y,
        },
        {
            x: rect.x,
            y: rect.y + rect.height,
        },
        {
            x: rect.x + rect.width,
            y: rect.y + rect.height,
        },
    ].map(point => {
        if (metadata.rotation === 90) {
            return {
                x: point.y,
                y: metadata.inputHeight - point.x,
            };
        }
        if (metadata.rotation === 180) {
            return {
                x: metadata.inputWidth - point.x,
                y: metadata.inputHeight - point.y,
            };
        }
        if (metadata.rotation === 270) {
            return {
                x: metadata.inputWidth - point.y,
                y: point.x,
            };
        }
        return point;
    });
    const left = Math.min(...points.map(point => point.x));
    const right = Math.max(...points.map(point => point.x));
    const top = Math.min(...points.map(point => point.y));
    const bottom = Math.max(...points.map(point => point.y));
    return {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    };
}
const losslessCropOverlayStyles = computed(() => {
    if (!props.lossless || !props.result || originalFitPlacement.value.width <= 0) {
        return [];
    }
    return props.result.outputs.map(output => {
        const metadata = output.metadata;
        const content = props.manualContentBoxes?.[metadata.half] ?? metadata.contentBox;
        const [
            top,
            right,
            bottom,
            left,
        ] = metadata.appliedMargins;
        const local = content ? {
            x: content.x - left,
            y: content.y - top,
            width: content.width + left + right,
            height: content.height + top + bottom,
        } : {
            x: 0,
            y: 0,
            width: metadata.sourceRegion.width,
            height: metadata.sourceRegion.height,
        };
        const rawRect = unrotatePreviewRect({
            x: metadata.sourceRegion.x + local.x,
            y: metadata.sourceRegion.y + local.y,
            width: local.width,
            height: local.height,
        }, metadata);
        return {
            insetInlineStart: `${originalFitPlacement.value.left + rawRect.x / props.result!.rawWidth * originalFitPlacement.value.width}px`,
            insetBlockStart: `${originalFitPlacement.value.top + rawRect.y / props.result!.rawHeight * originalFitPlacement.value.height}px`,
            width: `${rawRect.width / props.result!.rawWidth * originalFitPlacement.value.width}px`,
            height: `${rawRect.height / props.result!.rawHeight * originalFitPlacement.value.height}px`,
        };
    });
});
const cutterStyle = computed(() => {
    const sourceRatio = scanCleanupCutterRatio(cutterX.value, analysisWidth.value);
    if (effectiveViewMode.value === 'original' && originalFitPlacement.value.width > 0) {
        return {
            insetBlockEnd: 'auto',
            insetBlockStart: `${originalFitPlacement.value.top}px`,
            insetInlineStart: `${originalFitPlacement.value.left + originalFitPlacement.value.width * sourceRatio}px`,
            height: `${originalFitPlacement.value.height}px`,
        };
    }
    const outputs = props.result?.outputs ?? [];
    const canvas = resolvePreviewCanvasSize(outputs.map(output => output.metadata), props.matchPageSize);
    const canvases = outputs.map(output => ({
        width: canvas?.width ?? output.metadata.outputWidth,
        height: canvas?.height ?? output.metadata.outputHeight,
    }));
    if (props.readingOrder === 'rtl' && canvases.length > 1) {
        canvases.reverse();
    }
    const areas = canvases
        .map((_, index) => outputFitAreaSizes[index])
        .filter(area => area !== undefined);
    const renderedGapCenter = areas.length === canvases.length
        ? resolvePreviewSpreadCutterCenter(resolvePreviewOutputFitRects(areas, canvases))
        : null;
    if (renderedGapCenter !== null) {
        return {insetInlineStart: `${renderedGapCenter}px`};
    }
    const visualRatio = props.readingOrder === 'rtl' ? 1 - sourceRatio : sourceRatio;
    return {insetInlineStart: `${visualRatio * 100}%`};
});

function navigateFromKeyboard(direction: 'previous' | 'next') {
    if (direction === 'previous' && props.pageNumber > 1) emit('previous');
    if (direction === 'next' && props.pageNumber < props.totalPages) emit('next');
}

function handlePaneKeydown(event: KeyboardEvent) {
    if (event.target !== event.currentTarget) {
        return;
    }
    if (event.key === 'ArrowLeft') {
        event.preventDefault();
        navigateFromKeyboard('previous');
    } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        navigateFromKeyboard('next');
    }
}

function outputHalfLabel(half: TScanCleanupOutputHalf) {
    return t(`scanCleanup.preview.outputHalf.${half}`);
}

function contentHandleLabel(handle: TContentHandle, half: TScanCleanupOutputHalf) {
    return t('scanCleanup.preview.resizeContent', {
        direction: t(`scanCleanup.preview.resizeDirections.${handle}`),
        half: outputHalfLabel(half),
    });
}

function updateCutterFromClientX(clientX: number) {
    const rect = cutterStage.value?.getBoundingClientRect();
    if (!rect || rect.width <= 0) {
        return;
    }
    let ratio = (clientX - rect.left) / rect.width;
    if (effectiveViewMode.value === 'original' && originalFitPlacement.value.width > 0) {
        ratio = (clientX - rect.left - originalFitPlacement.value.left) / originalFitPlacement.value.width;
    } else {
        const areas = Object.values(outputFitAreaSizes);
        if (areas.length >= 2) {
            const left = Math.min(...areas.map(area => area.left));
            const right = Math.max(...areas.map(area => area.left + area.width));
            if (right > left) {
                ratio = (clientX - rect.left - left) / (right - left);
            }
        }
        if (props.readingOrder === 'rtl') ratio = 1 - ratio;
    }
    emit('update:manualSplitX', scanCleanupCutterXFromRatio(ratio, analysisWidth.value));
}

function startCutterDrag(event: PointerEvent) {
    if (event.button !== 0) {
        return;
    }
    draggingCutter.value = true;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    updateCutterFromClientX(event.clientX);
}

function cancelCutterDrag() {
    draggingCutter.value = false;
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

function setOutputFitArea(index: number, element: Element | ComponentPublicInstance | null) {
    const htmlElement = element instanceof HTMLElement ? element : null;
    const previous = outputFitAreas.get(index);
    if (previous && previous !== htmlElement) outputResizeObserver?.unobserve(previous);
    if (!htmlElement) {
        outputFitAreas.delete(index);
        Reflect.deleteProperty(outputFitAreaSizes, index);
        return;
    }
    outputFitAreas.set(index, htmlElement);
    outputResizeObserver?.observe(htmlElement);
    updateOutputFitAreaSizes();
}

function updateOutputFitAreaSizes() {
    const stageRect = cutterStage.value?.getBoundingClientRect();
    for (const [
        index,
        element,
    ] of outputFitAreas) {
        const rect = element.getBoundingClientRect();
        const current = outputFitAreaSizes[index];
        const left = rect.left - (stageRect?.left ?? 0);
        const top = rect.top - (stageRect?.top ?? 0);
        if (
            current?.left !== left
            || current.top !== top
            || current.width !== rect.width
            || current.height !== rect.height
        ) {
            outputFitAreaSizes[index] = {
                left,
                top,
                width: rect.width,
                height: rect.height,
            };
        }
    }
}

function observeOutputFitAreas() {
    outputResizeObserver?.disconnect();
    if (typeof ResizeObserver === 'undefined') {
        updateOutputFitAreaSizes();
        return;
    }
    outputResizeObserver = new ResizeObserver(updateOutputFitAreaSizes);
    for (const element of outputFitAreas.values()) outputResizeObserver.observe(element);
    updateOutputFitAreaSizes();
}

function sourcePointFromEvent(event: PointerEvent, output: IRenderedOutput) {
    const canvas = (event.currentTarget as HTMLElement).closest<HTMLElement>('.uniform-canvas');
    const rect = canvas?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
        return null;
    }
    return previewPointToSourceHalf(output.metadata, {
        x: (event.clientX - rect.left) / rect.width * output.placement.canvasWidth,
        y: (event.clientY - rect.top) / rect.height * output.placement.canvasHeight,
    });
}

function startContentDrag(event: PointerEvent, output: IRenderedOutput, handle: TContentHandle) {
    if (!output.contentRect || event.button !== 0) {
        return;
    }
    contentDrag.value = {
        half: output.metadata.half,
        handle,
        pointerId: event.pointerId,
        rect: {...output.contentRect},
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragContentBox(event, output);
}

function resizedContentRect(
    rect: IScanCleanupPreviewRect,
    handle: TContentHandle,
    point: {
        x: number;
        y: number
    },
    metadata: IScanCleanupPreviewMetadata,
) {
    const minimum = Math.max(1, Math.min(metadata.sourceRegion.width, metadata.sourceRegion.height) * 0.02);
    let left = rect.x;
    let top = rect.y;
    let right = rect.x + rect.width;
    let bottom = rect.y + rect.height;
    if (handle.includes('w')) left = Math.min(right - minimum, point.x);
    if (handle.includes('e')) right = Math.max(left + minimum, point.x);
    if (handle.includes('n')) top = Math.min(bottom - minimum, point.y);
    if (handle.includes('s')) bottom = Math.max(top + minimum, point.y);
    left = Math.max(0, left);
    top = Math.max(0, top);
    right = Math.min(metadata.sourceRegion.width, right);
    bottom = Math.min(metadata.sourceRegion.height, bottom);
    return clampPreviewRect({
        x: left,
        y: top,
        width: Math.max(minimum, right - left),
        height: Math.max(minimum, bottom - top),
    }, metadata.sourceRegion.width, metadata.sourceRegion.height);
}

function dragContentBox(event: PointerEvent, output: IRenderedOutput) {
    const drag = contentDrag.value;
    if (!drag || drag.pointerId !== event.pointerId || drag.half !== output.metadata.half) {
        return;
    }
    const point = sourcePointFromEvent(event, output);
    if (!point) {
        return;
    }
    emit('update:manualContentBox', drag.half, resizedContentRect(drag.rect, drag.handle, point, output.metadata));
}

function finishContentDrag(event: PointerEvent) {
    const drag = contentDrag.value;
    if (!drag || drag.pointerId !== event.pointerId) {
        return;
    }
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    contentDrag.value = null;
}

function cancelContentDrag() {
    contentDrag.value = null;
}

function nudgeContentBox(event: KeyboardEvent, output: IRenderedOutput, handle: TContentHandle) {
    if (!output.contentRect || !event.key.startsWith('Arrow')) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    const step = Math.max(1, Math.min(output.metadata.sourceRegion.width, output.metadata.sourceRegion.height)
        * (event.shiftKey ? 0.05 : 0.01));
    const point = {
        x: handle.includes('w') ? output.contentRect.x : output.contentRect.x + output.contentRect.width,
        y: handle.includes('n') ? output.contentRect.y : output.contentRect.y + output.contentRect.height,
    };
    if (event.key === 'ArrowLeft') point.x -= step;
    if (event.key === 'ArrowRight') point.x += step;
    if (event.key === 'ArrowUp') point.y -= step;
    if (event.key === 'ArrowDown') point.y += step;
    emit('update:manualContentBox', output.metadata.half, resizedContentRect(
        output.contentRect,
        handle,
        point,
        output.metadata,
    ));
}

function alignmentFromPoint(event: PointerEvent) {
    const canvas = (event.currentTarget as HTMLElement).closest<HTMLElement>('.uniform-canvas');
    const rect = canvas?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
        return null;
    }
    const horizontal = event.clientX - rect.left < rect.width / 3
        ? 'left'
        : event.clientX - rect.left > rect.width * 2 / 3 ? 'right' : 'center';
    const vertical = event.clientY - rect.top < rect.height / 3
        ? 'top'
        : event.clientY - rect.top > rect.height * 2 / 3 ? 'bottom' : 'center';
    return vertical === 'center' && horizontal === 'center'
        ? 'center' as const
        : `${vertical}-${horizontal}` as TScanCleanupPageAlignment;
}

function startPlacementDrag(event: PointerEvent, output: IRenderedOutput) {
    if (!props.matchPageSize || event.button !== 0) {
        return;
    }
    placementDrag.value = {
        half: output.metadata.half,
        pointerId: event.pointerId,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragPlacement(event, output);
}

function dragPlacement(event: PointerEvent, output: IRenderedOutput) {
    const drag = placementDrag.value;
    if (!drag || drag.pointerId !== event.pointerId || drag.half !== output.metadata.half) {
        return;
    }
    const alignment = alignmentFromPoint(event);
    if (alignment) emit('update:placement', output.metadata.half, alignment);
}

function finishPlacementDrag(event: PointerEvent) {
    const drag = placementDrag.value;
    if (!drag || drag.pointerId !== event.pointerId) {
        return;
    }
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    placementDrag.value = null;
}

function cancelPlacementDrag() {
    placementDrag.value = null;
}

function nudgePlacement(event: KeyboardEvent, output: IRenderedOutput) {
    if (!props.matchPageSize || !event.key.startsWith('Arrow')) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    const current = props.placementOverrides?.[output.metadata.half] ?? props.alignment;
    const [
        vertical,
        horizontal = vertical,
    ] = current.split('-');
    const axes = [
        'left',
        'center',
        'right',
    ] as const;
    const verticalAxes = [
        'top',
        'center',
        'bottom',
    ] as const;
    let x = axes.indexOf(horizontal as typeof axes[number]);
    let y = verticalAxes.indexOf(vertical as typeof verticalAxes[number]);
    if (event.key === 'ArrowLeft') x = Math.max(0, x - 1);
    if (event.key === 'ArrowRight') x = Math.min(2, x + 1);
    if (event.key === 'ArrowUp') y = Math.max(0, y - 1);
    if (event.key === 'ArrowDown') y = Math.min(2, y + 1);
    const next = x === 1 && y === 1 ? 'center' : `${verticalAxes[y]}-${axes[x]}`;
    emit('update:placement', output.metadata.half, next as TScanCleanupPageAlignment);
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

function updateCutterStageSize() {
    const rect = cutterStage.value?.getBoundingClientRect();
    cutterStageSize.width = rect?.width ?? 0;
    cutterStageSize.height = rect?.height ?? 0;
}

function observeCutterStage() {
    cutterResizeObserver?.disconnect();
    updateCutterStageSize();
    if (typeof ResizeObserver === 'undefined' || !cutterStage.value) {
        return;
    }
    cutterResizeObserver ??= new ResizeObserver(updateCutterStageSize);
    cutterResizeObserver.observe(cutterStage.value);
}

watch(() => props.result, result => {
    previewTransitionKey.value += 1;
    revokeUrls();
    if (!result) {
        return;
    }
    rawUrl.value = pngUrl(result.rawImageData);
    cleanedUrls.value = result.outputs.map(output => pngUrl(output.imageData));
    void nextTick(() => {
        observeCutterStage();
        observeOutputFitAreas();
    });
}, {immediate: true});

onMounted(() => {
    observeCutterStage();
    observeOutputFitAreas();
});
onBeforeUnmount(() => {
    cutterResizeObserver?.disconnect();
    outputResizeObserver?.disconnect();
    revokeUrls();
});

const renderedOutputs = computed(() => {
    if (!props.result) {
        return [];
    }
    const canvas = resolvePreviewCanvasSize(
        props.result.outputs.map(output => output.metadata),
        props.matchPageSize,
    );
    const outputs = props.result.outputs.map((output, index): IRenderedOutput => {
        const metadata = output.metadata;
        const alignment = props.placementOverrides?.[metadata.half] ?? props.alignment;
        const placement = resolvePreviewPlacement(
            metadata.outputWidth,
            metadata.outputHeight,
            canvas?.width ?? metadata.outputWidth,
            canvas?.height ?? metadata.outputHeight,
            alignment,
        );
        const imageStyle = toPreviewStyleRect({
            x: 0,
            y: 0,
            width: metadata.outputWidth,
            height: metadata.outputHeight,
        }, placement);
        const contentRect = props.manualContentBoxes?.[metadata.half] ?? metadata.contentBox;
        const content = props.manualContentBoxes?.[metadata.half]
            ? transformPreviewSourceHalfRect(metadata, contentRect)
            : transformPreviewContentBox(metadata);
        return {
            metadata,
            url: cleanedUrls.value[index] ?? '',
            placement,
            imageStyle,
            contentRect,
            contentStyle: content ? toPreviewStyleRect(content, placement) : null,
            canvasStyle: {},
        };
    });
    const ordered = props.readingOrder === 'rtl' && outputs.length > 1 ? outputs.reverse() : outputs;
    const sizes = effectiveZoomMode.value === 'actual'
        ? ordered.map(output => ({
            width: output.placement.canvasWidth,
            height: output.placement.canvasHeight,
        }))
        : resolvePreviewOutputFitSizes(
            ordered.map((_, index) => outputFitAreaSizes[index] ?? {
                width: 0,
                height: 0,
            }),
            ordered.map(output => ({
                width: output.placement.canvasWidth,
                height: output.placement.canvasHeight,
            })),
        );
    return ordered.map((output, index) => ({
        ...output,
        canvasStyle: {
            width: `${sizes[index]?.width ?? 0}px`,
            height: `${sizes[index]?.height ?? 0}px`,
        },
    }));
});
</script>

<style scoped src="./ScanCleanupPreviewPane.css"></style>
