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
            </div>
        </header>

        <div
            ref="previewSurface"
            class="preview-surface"
            :class="{'is-stale-page': isStalePage}"
            aria-live="polite"
        >
            <div
                v-if="result"
                class="preview-result-layer"
                :class="{
                    'is-cutter-source-dimmed': cutterSourceUnderlayVisible,
                    'is-source-underlay-dimmed': sourceUnderlayVisible,
                }"
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
                <div v-else class="preview-viewport-layout">
                    <div ref="cutterStage" class="cutter-stage" :class="{'is-stale-content': isStalePage}">
                        <OriginalCanvas
                            v-if="effectiveViewMode === 'original'"
                            :alt="t('scanCleanup.preview.originalAlt', {page: result.pageNumber})"
                            :crop-overlay-styles="losslessCropOverlayStyles"
                            :pixel-swap="rawPixelSwap"
                            @complete="completeRawPixelSwap"
                            @load="loadRawPixelSwap"
                        />
                        <CleanedCanvas
                            v-else
                            :active-placement-half="activePlacementHalf"
                            :alt-by-half="cleanedAltByHalf"
                            :match-page-size="matchPageSize"
                            :outputs="renderedOutputs"
                            @complete="completeCleanedPixelSwap"
                            @load="loadCleanedPixelSwap"
                            @set-canvas="setOutputCanvas"
                            @set-fit-area="setOutputFitArea"
                        >
                            <template #paper-overlay="{output}">
                                <PlacementOverlay
                                    :anchors="placementAnchors"
                                    :enabled="matchPageSize"
                                    :labels="placementLabels"
                                    :outputs="placementOverlayOutputFor(output.metadata.half)"
                                    @abort="dragTransaction.abort"
                                    @cancel="dragTransaction.cancel"
                                    @finish="dragTransaction.finish"
                                    @lost-pointer-capture="dragTransaction.lostPointerCapture"
                                    @move="dragTransaction.move"
                                    @nudge="nudgePlacement"
                                    @start="startPlacementDrag"
                                />
                                <ContentBoxOverlay
                                    :group-labels="contentGroupLabels"
                                    :handle-labels="contentHandleLabels"
                                    :handles="contentHandles"
                                    :outputs="contentOverlayOutputFor(output.metadata.half)"
                                    @abort="dragTransaction.abort"
                                    @cancel="dragTransaction.cancel"
                                    @finish="dragTransaction.finish"
                                    @lost-pointer-capture="dragTransaction.lostPointerCapture"
                                    @move="dragTransaction.move"
                                    @nudge="nudgeContentBox"
                                    @reset="emit('update:manualContentBox', $event, null)"
                                    @start="startContentDrag"
                                />
                            </template>
                        </CleanedCanvas>
                    </div>
                    <span class="preview-viewport-caption" aria-hidden="true" />
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
            <div v-if="!result" class="preview-empty-layer">
                <div v-if="!error" class="preview-viewport-layout preview-loading" role="status">
                    <div ref="cutterStage" class="cutter-stage">
                        <div
                            class="cleaned-outputs preview-skeleton-outputs"
                            :class="{'is-spread': loadingFrames.length > 1}"
                        >
                            <div
                                v-for="output in loadingFrames"
                                :key="output.half"
                                class="output-column"
                            >
                                <div
                                    :ref="element => setOutputFitArea(output.half, element)"
                                    class="output-fit-area"
                                    :data-output-half="output.half"
                                >
                                    <div
                                        class="uniform-canvas preview-skeleton-page"
                                        :style="output.style"
                                        :data-frame-width="output.width"
                                        :data-frame-height="output.height"
                                    >
                                        <USkeleton class="preview-skeleton-fill" />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <span class="preview-viewport-caption">{{ t('scanCleanup.preview.loading') }}</span>
                </div>
                <div v-else class="preview-message is-error" role="alert">
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
            </div>
            <div
                v-if="result"
                class="drag-overlay-layer"
                :style="dragOverlayStyle"
            >
                <div
                    v-if="sourceUnderlayVisible"
                    class="cutter-source-underlay"
                    :style="cutterSourceFrameStyle"
                    aria-hidden="true"
                >
                    <img :src="rawPixelSwap.currentUrl" :style="cutterSourceImageStyle">
                </div>

                <CutterOverlay
                    :hint="t('scanCleanup.preview.cutterHint')"
                    :label="t('scanCleanup.preview.cutter')"
                    :refreshing="loading && !cutterSourceUnderlayVisible"
                    :style="cutterStyle"
                    :visible="showCutter"
                    @abort="dragTransaction.abort"
                    @cancel="dragTransaction.cancel"
                    @finish="dragTransaction.finish"
                    @lost-pointer-capture="dragTransaction.lostPointerCapture"
                    @move="dragTransaction.move"
                    @nudge="nudgeCutter"
                    @reset="emit('update:manualSplit', null)"
                    @start="startCutterDrag"
                />

                <ZoneEditorOverlay
                    v-if="zoneEditing"
                    :frame="cutterSourceFitPlacement"
                    :manual-zones="manualZones"
                    :rotation-degrees="rotationDegrees ?? 0"
                    :selected="selectedZone"
                    :zone-kind="zoneKind"
                    @update:manual-zones="emit('update:manualZones', $event)"
                    @update:selected="selectedZone = $event"
                />
            </div>
            <ZoneEditorControls
                v-if="result && zoneEditing"
                :output-mode="outputMode ?? 'bw'"
                :selected-layer="selectedPictureLayer"
                :zone-count="zoneCount"
                :zone-kind="zoneKind"
                @update:selected-layer="updateSelectedPictureLayer"
                @update:zone-kind="zoneKind = $event"
                @use-mixed-output="emit('useMixedOutput')"
            />
            <aside
                v-if="showFirstRunGuidance && !zoneEditing"
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
    IScanCleanupManualZones,
    IScanCleanupNormalizedRect,
    IScanCleanupNormalizedSplit,
    IScanCleanupPreviewMetadata,
    IScanCleanupPixelRect,
    IScanCleanupPreviewResult,
    TScanCleanupOutputHalf,
    TScanCleanupOutputMode,
    TScanCleanupPageAlignment,
    TScanCleanupPageRotation,
    TScanCleanupPictureZoneLayer,
} from '@contracts/electronApiScanCleanup';
import type {
    ComponentPublicInstance,
    CSSProperties,
} from 'vue';
import type {IDocumentPageSource} from '@app/utils/document-viewer/source/documentPageSource';
import ScanCleanupSegmented from '@app/modules/scan-cleanup/components/ScanCleanupSegmented.vue';
import CleanedCanvas from '@app/modules/scan-cleanup/components/preview/CleanedCanvas.vue';
import ContentBoxOverlay from '@app/modules/scan-cleanup/components/preview/ContentBoxOverlay.vue';
import CutterOverlay from '@app/modules/scan-cleanup/components/preview/CutterOverlay.vue';
import OriginalCanvas from '@app/modules/scan-cleanup/components/preview/OriginalCanvas.vue';
import PlacementOverlay from '@app/modules/scan-cleanup/components/preview/PlacementOverlay.vue';
import ZoneEditorControls from '@app/modules/scan-cleanup/components/preview/ZoneEditorControls.vue';
import ZoneEditorOverlay from '@app/modules/scan-cleanup/components/preview/ZoneEditorOverlay.vue';
import type {
    IRenderedScanCleanupOutput,
    IScanCleanupContentOverlayOutput,
    IScanCleanupPlacementOverlayOutput,
    TScanCleanupContentHandle,
} from '@app/modules/scan-cleanup/runtime/scanCleanupPreviewPresentation';
import {
    type IScanCleanupDragRect,
    useScanCleanupDragTransaction,
} from '@app/modules/scan-cleanup/composables/useScanCleanupDragTransaction';
import {useScanCleanupViewportFrame} from '@app/modules/scan-cleanup/composables/useScanCleanupViewportFrame';
import {
    clampPreviewRect,
    expandPreviewRectByMargins,
    previewPointToSourceHalf,
    normalizeManualSplitX,
    normalizePreviewContentBox,
    resolveNormalizedContentBox,
    resolveNormalizedManualSplitX,
    scanCleanupAnalysisWidth,
    scanCleanupCutterRatio,
    scanCleanupCutterXFromRatio,
    transformPreviewContentBox,
    transformPreviewSourceHalfRect,
    unrotatePreviewRect,
} from '@app/modules/scan-cleanup/geometry/coordinates';
import {
    resolvePreviewFitPlacement,
    resolvePreviewOutputFitRects,
    resolvePreviewOutputFitSizes,
    resolvePreviewSpreadCutterCenter,
} from '@app/modules/scan-cleanup/geometry/viewport';
import {
    resolvePreviewMetadataPlacement,
    toPreviewStyleRect,
} from '@app/modules/scan-cleanup/geometry/placement';
import {
    createPreviewImageSwap,
    useScanCleanupPreviewImages,
} from '@app/modules/scan-cleanup/composables/useScanCleanupPreviewImages';
import {
    cloneScanCleanupZonePolygon,
    type IScanCleanupZoneSelection,
    type TScanCleanupZoneKind,
} from '@app/modules/scan-cleanup/geometry/zoneGeometry';

interface ICutterDragGeometry {
    kind: 'cutter';
    value: IScanCleanupNormalizedSplit;
}

interface IContentDragGeometry {
    half: TScanCleanupOutputHalf;
    kind: 'content';
    value: IScanCleanupNormalizedRect;
}

interface IPlacementDragGeometry {
    alignment: TScanCleanupPageAlignment;
    half: TScanCleanupOutputHalf;
    kind: 'placement';
    left: number;
    top: number;
}

type TScanCleanupDragGeometry = ICutterDragGeometry | IContentDragGeometry | IPlacementDragGeometry;

const props = defineProps<{
    result: IScanCleanupPreviewResult | null;
    loading: boolean;
    error: string;
    viewMode?: 'original' | 'cleaned';
    matchPageSize: boolean;
    alignment: TScanCleanupPageAlignment;
    pageNumber: number;
    totalPages: number;
    stalePage?: boolean;
    showFirstRunGuidance?: boolean;
    manualSplit: IScanCleanupNormalizedSplit | null;
    readingOrder: 'ltr' | 'rtl';
    manualContentBoxes?: Partial<Record<TScanCleanupOutputHalf, IScanCleanupNormalizedRect>>;
    manualZones?: IScanCleanupManualZones | undefined;
    placementOverrides?: Partial<Record<TScanCleanupOutputHalf, TScanCleanupPageAlignment>>;
    outputMode?: TScanCleanupOutputMode;
    zoneEditing?: boolean;
    lossless?: boolean;
    source?: IDocumentPageSource | null;
    layoutClassification?: IScanCleanupPreviewMetadata['layoutClassification'] | undefined;
    rotationDegrees?: TScanCleanupPageRotation;
}>();

const emit = defineEmits<{
    'dismiss-first-run-guidance': [];
    previous: [];
    next: [];
    retry: [];
    'update:viewMode': [value: 'original' | 'cleaned'];
    'update:manualSplit': [value: IScanCleanupNormalizedSplit | null];
    'update:manualContentBox': [half: TScanCleanupOutputHalf, value: IScanCleanupNormalizedRect | null];
    'update:manualZones': [value: IScanCleanupManualZones];
    'update:placement': [half: TScanCleanupOutputHalf, value: TScanCleanupPageAlignment];
    useMixedOutput: [];
}>();

const {t} = useTypedI18n();
const previewSurface = ref<HTMLElement | null>(null);
const cutterStage = ref<HTMLElement | null>(null);
const dragTransaction = useScanCleanupDragTransaction<TScanCleanupDragGeometry>();
const outputFitAreas = new Map<TScanCleanupOutputHalf, HTMLElement>();
const outputCanvases = new Map<TScanCleanupOutputHalf, HTMLElement>();
const outputFitAreaSizes = reactive<Partial<Record<TScanCleanupOutputHalf, {
    left: number;
    top: number;
    width: number;
    height: number
}>>>({});
const outputCanvasRects = reactive<Partial<Record<TScanCleanupOutputHalf, IScanCleanupDragRect>>>({});
let outputResizeObserver: ResizeObserver | null = null;
const contentHandles: readonly TScanCleanupContentHandle[] = [
    'n',
    'ne',
    'e',
    'se',
    's',
    'sw',
    'w',
    'nw',
];
const cutterStageSize = reactive({
    height: 0,
    width: 0,
});
const dragOverlayBounds = reactive<IScanCleanupDragRect>({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
});
let cutterResizeObserver: ResizeObserver | null = null;
const effectiveViewMode = computed(() => props.lossless
    ? 'original'
    : props.viewMode ?? 'cleaned');
const isStalePage = computed(() => props.stalePage
    ?? Boolean(props.result && props.result.pageNumber !== props.pageNumber));
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
const dragOutputSnapshot = ref<IRenderedScanCleanupOutput[] | null>(null);
const selectedZone = ref<IScanCleanupZoneSelection | null>(null);
const zoneKind = ref<TScanCleanupZoneKind>('picture');
const {
    frame: frozenViewportFrame,
    placeholderHalves,
    refresh: refreshFrozenViewportFrame,
} = useScanCleanupViewportFrame({
    activeDrag: dragTransaction.active,
    fitAreaSizes: outputFitAreaSizes,
    layoutClassification: () => props.layoutClassification,
    matchPageSize: () => props.matchPageSize,
    requestedPage: () => props.pageNumber,
    result: () => props.result,
    rotationDegrees: () => props.rotationDegrees ?? 0,
    source: () => props.source ?? null,
});

const loadingFrames = computed(() => {
    const frames = placeholderHalves.value.map(half => ({
        half,
        ...(frozenViewportFrame.value.outputs[half] ?? {
            width: 1,
            height: Math.SQRT2,
        }),
    }));
    const sizes = resolvePreviewOutputFitSizes(
        frames.map(frame => outputFitAreaSizes[frame.half] ?? {
            width: 0,
            height: 0,
        }),
        frames,
    );
    return frames.map((frame, index) => {
        const fitArea = outputFitAreaSizes[frame.half];
        const size = sizes[index];
        const width = size?.width ?? 0;
        const height = size?.height ?? 0;
        const measured = (fitArea?.width ?? 0) > 0
            && (fitArea?.height ?? 0) > 0
            && width > 0
            && height > 0;
        return {
            ...frame,
            style: measured ? {
                width: `${width}px`,
                height: `${height}px`,
            } : {
                width: 'auto',
                maxWidth: '100%',
                height: 'var(--app-scan-preview-skeleton-height)',
                maxHeight: '100%',
                aspectRatio: `${frame.width} / ${frame.height}`,
            },
        };
    });
});

const analysisWidth = computed(() => {
    const metadata = props.result?.pageMetadata;
    if (!metadata || !props.result) {
        return 1;
    }
    return scanCleanupAnalysisWidth(metadata, props.result.rawWidthPx, props.result.rawHeightPx);
});
const analysisHeight = computed(() => {
    const rotation = props.result?.pageMetadata.rotationDegrees ?? 0;
    return rotation === 90 || rotation === 270
        ? props.result?.rawWidthPx ?? 1
        : props.result?.rawHeightPx ?? 1;
});
const draftGeometry = computed(() => dragTransaction.draftGeometry.value);
const activeCutterDraft = computed(() => draftGeometry.value?.kind === 'cutter'
    ? draftGeometry.value
    : null);
const activePlacementHalf = computed(() => draftGeometry.value?.kind === 'placement'
    ? draftGeometry.value.half
    : null);
const cutterXPx = computed(() => resolveNormalizedManualSplitX(props.manualSplit, analysisWidth.value)
    ?? props.result?.pageMetadata.cutterXPx
    ?? analysisWidth.value / 2);
const displayedCutterX = computed(() => activeCutterDraft.value
    ? resolveNormalizedManualSplitX(activeCutterDraft.value.value, analysisWidth.value) ?? cutterXPx.value
    : cutterXPx.value);
const showCutter = computed(() => props.zoneEditing !== true
    && (
        activeCutterDraft.value !== null
        || Boolean(props.result) && (
            props.result?.pageMetadata.layoutClassification === 'two-page-spread'
            || props.manualSplit !== null
        )
    ));
const originalFitPlacement = computed(() => resolvePreviewFitPlacement(
    cutterStageSize.width,
    cutterStageSize.height,
    props.result?.rawWidthPx ?? 1,
    props.result?.rawHeightPx ?? 1,
));
const cutterSourceFitPlacement = computed(() => resolvePreviewFitPlacement(
    cutterStageSize.width,
    cutterStageSize.height,
    analysisWidth.value,
    analysisHeight.value,
));
const cutterSourceUnderlayVisible = computed(() => activeCutterDraft.value !== null
    && effectiveViewMode.value === 'cleaned');
const sourceUnderlayVisible = computed(() => props.zoneEditing === true || cutterSourceUnderlayVisible.value);
const dragOverlayStyle = computed<CSSProperties>(() => ({
    left: `${dragOverlayBounds.x}px`,
    top: `${dragOverlayBounds.y}px`,
    width: `${dragOverlayBounds.width}px`,
    height: `${dragOverlayBounds.height}px`,
}));
const cutterSourceFrameStyle = computed<CSSProperties>(() => ({
    left: `${cutterSourceFitPlacement.value.left}px`,
    top: `${cutterSourceFitPlacement.value.top}px`,
    width: `${cutterSourceFitPlacement.value.width}px`,
    height: `${cutterSourceFitPlacement.value.height}px`,
}));
const cutterSourceImageStyle = computed<CSSProperties>(() => {
    const rotation = props.result?.pageMetadata.rotationDegrees ?? 0;
    const swapsAxes = rotation === 90 || rotation === 270;
    return {
        width: `${swapsAxes ? cutterSourceFitPlacement.value.height : cutterSourceFitPlacement.value.width}px`,
        height: `${swapsAxes ? cutterSourceFitPlacement.value.width : cutterSourceFitPlacement.value.height}px`,
        transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
    };
});
const zoneCount = computed(() => (props.manualZones?.picture.length ?? 0)
    + (props.manualZones?.fill.length ?? 0));
const selectedPictureLayer = computed<TScanCleanupPictureZoneLayer | null>(() => {
    if (selectedZone.value?.kind !== 'picture') {
        return null;
    }
    return props.manualZones?.picture[selectedZone.value.index]?.layer ?? null;
});
const placementAnchors: Array<{
    alignment: TScanCleanupPageAlignment;
    style: CSSProperties;
}> = [
    {
        alignment: 'top-left',
        style: {
            left: '0%',
            top: '0%',
        },
    },
    {
        alignment: 'top-center',
        style: {
            left: '50%',
            top: '0%',
        },
    },
    {
        alignment: 'top-right',
        style: {
            left: '100%',
            top: '0%',
        },
    },
    {
        alignment: 'center-left',
        style: {
            left: '0%',
            top: '50%',
        },
    },
    {
        alignment: 'center',
        style: {
            left: '50%',
            top: '50%',
        },
    },
    {
        alignment: 'center-right',
        style: {
            left: '100%',
            top: '50%',
        },
    },
    {
        alignment: 'bottom-left',
        style: {
            left: '0%',
            top: '100%',
        },
    },
    {
        alignment: 'bottom-center',
        style: {
            left: '50%',
            top: '100%',
        },
    },
    {
        alignment: 'bottom-right',
        style: {
            left: '100%',
            top: '100%',
        },
    },
];
const losslessCropOverlayStyles = computed(() => {
    if (!props.lossless || !props.result || originalFitPlacement.value.width <= 0) {
        return [];
    }
    return props.result.outputs.map(output => {
        const metadata = output.metadata;
        const content = resolveNormalizedContentBox(metadata, props.manualContentBoxes?.[metadata.half])
            ?? metadata.contentBox;
        const local = content ? expandPreviewRectByMargins(content, metadata.appliedMargins) : {
            xPx: 0,
            yPx: 0,
            widthPx: metadata.sourceRegion.widthPx,
            heightPx: metadata.sourceRegion.heightPx,
        };
        const rawRect = unrotatePreviewRect({
            xPx: metadata.sourceRegion.xPx + local.xPx,
            yPx: metadata.sourceRegion.yPx + local.yPx,
            widthPx: local.widthPx,
            heightPx: local.heightPx,
        }, metadata);
        return {
            insetInlineStart: `${originalFitPlacement.value.left + rawRect.xPx / props.result!.rawWidthPx * originalFitPlacement.value.width}px`,
            insetBlockStart: `${originalFitPlacement.value.top + rawRect.yPx / props.result!.rawHeightPx * originalFitPlacement.value.height}px`,
            width: `${rawRect.widthPx / props.result!.rawWidthPx * originalFitPlacement.value.width}px`,
            height: `${rawRect.heightPx / props.result!.rawHeightPx * originalFitPlacement.value.height}px`,
        };
    });
});
const cutterStyle = computed(() => {
    const sourceRatio = scanCleanupCutterRatio(displayedCutterX.value, analysisWidth.value);
    if (cutterSourceUnderlayVisible.value) {
        return {
            insetBlockEnd: 'auto',
            insetBlockStart: `${cutterSourceFitPlacement.value.top}px`,
            insetInlineStart: `${cutterSourceFitPlacement.value.left + cutterSourceFitPlacement.value.width * sourceRatio}px`,
            height: `${cutterSourceFitPlacement.value.height}px`,
        };
    }
    if (effectiveViewMode.value === 'original' && originalFitPlacement.value.width > 0) {
        return {
            insetBlockEnd: 'auto',
            insetBlockStart: `${originalFitPlacement.value.top}px`,
            insetInlineStart: `${originalFitPlacement.value.left + originalFitPlacement.value.width * sourceRatio}px`,
            height: `${originalFitPlacement.value.height}px`,
        };
    }
    const outputs = props.result?.outputs ?? [];
    const canvases = outputs.map(output => frozenViewportFrame.value.outputs[output.metadata.half] ?? {
        width: analysisWidth.value / Math.max(1, outputs.length),
        height: analysisHeight.value,
    });
    if (props.readingOrder === 'rtl' && canvases.length > 1) {
        canvases.reverse();
    }
    const orderedHalves = outputs.map(output => output.metadata.half);
    if (props.readingOrder === 'rtl' && orderedHalves.length > 1) {
        orderedHalves.reverse();
    }
    const areas = orderedHalves
        .map(half => outputFitAreaSizes[half])
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

function captureDragOutputSnapshot() {
    dragOutputSnapshot.value = renderedOutputs.value.map(output => ({
        ...output,
        canvasStyle: {...output.canvasStyle},
        imageStyle: {...output.imageStyle},
        placement: {...output.placement},
    }));
}

function outputHalfLabel(half: TScanCleanupOutputHalf) {
    return t(`scanCleanup.preview.outputHalf.${half}`);
}

function contentHandleLabel(handle: TScanCleanupContentHandle, half: TScanCleanupOutputHalf) {
    return t('scanCleanup.preview.resizeContent', {
        direction: t(`scanCleanup.preview.resizeDirections.${handle}`),
        half: outputHalfLabel(half),
    });
}

function updateSelectedPictureLayer(layer: TScanCleanupPictureZoneLayer) {
    if (selectedZone.value?.kind !== 'picture') {
        return;
    }
    const next = {
        picture: (props.manualZones?.picture ?? []).map(zone => ({
            layer: zone.layer,
            polygon: cloneScanCleanupZonePolygon(zone.polygon),
        })),
        fill: (props.manualZones?.fill ?? []).map(cloneScanCleanupZonePolygon),
    };
    const zone = next.picture[selectedZone.value.index];
    if (!zone) {
        return;
    }
    next.picture[selectedZone.value.index] = {
        ...zone,
        layer,
    };
    emit('update:manualZones', next);
}

const outputHalves = computed(() => props.result?.outputs.map(output => output.metadata.half) ?? []);
const cleanedAltByHalf = computed(() => Object.fromEntries(outputHalves.value.map(half => [
    half,
    t('scanCleanup.preview.cleanedAlt', {
        page: props.result?.pageNumber ?? props.pageNumber,
        half: outputHalfLabel(half),
    }),
])));
const placementLabels = computed(() => Object.fromEntries(outputHalves.value.map(half => [
    half,
    t('scanCleanup.preview.placement', {half: outputHalfLabel(half)}),
])));
const contentGroupLabels = computed(() => Object.fromEntries(outputHalves.value.map(half => [
    half,
    t('scanCleanup.preview.contentBoxFor', {half: outputHalfLabel(half)}),
])));
const contentHandleLabels = computed(() => Object.fromEntries(outputHalves.value.map(half => [
    half,
    Object.fromEntries(contentHandles.map(handle => [
        handle,
        contentHandleLabel(handle, half),
    ])),
])));

function startCutterDrag(event: PointerEvent) {
    updateOverlayGeometry(true);
    const stageRect = currentStageRect();
    const sourceFrame = effectiveViewMode.value === 'cleaned'
        ? cutterSourceFitPlacement.value
        : originalFitPlacement.value;
    if (!stageRect || sourceFrame.width <= 0) {
        return;
    }
    const rotation = props.result?.pageMetadata.rotationDegrees ?? 0;
    const canonicalGeometry: ICutterDragGeometry = {
        kind: 'cutter',
        value: props.manualSplit
            ? {...props.manualSplit}
            : normalizeManualSplitX(cutterXPx.value, analysisWidth.value, rotation),
    };
    const started = dragTransaction.start(event, {
        canonicalGeometry,
        stageRect,
        fitScale: sourceFrame.width / Math.max(1, analysisWidth.value),
        update: (pointerEvent, snapshot) => {
            const ratio = (pointerEvent.clientX - snapshot.stageRect.x - sourceFrame.left) / sourceFrame.width;
            return {
                kind: 'cutter',
                value: normalizeManualSplitX(
                    scanCleanupCutterXFromRatio(ratio, analysisWidth.value),
                    analysisWidth.value,
                    rotation,
                ),
            };
        },
        commit: geometry => {
            if (geometry.kind === 'cutter') {
                emit('update:manualSplit', geometry.value);
            }
        },
    });
    if (started) {
        captureDragOutputSnapshot();
        dragTransaction.move(event);
    }
}

function nudgeCutter(direction: -1 | 1, coarse: boolean) {
    const step = analysisWidth.value * (coarse ? 0.05 : 0.01);
    emit('update:manualSplit', normalizeManualSplitX(Math.min(
        analysisWidth.value * 0.98,
        Math.max(analysisWidth.value * 0.02, cutterXPx.value + direction * step),
    ), analysisWidth.value, props.result?.pageMetadata.rotationDegrees ?? 0));
}

function setOutputFitArea(half: TScanCleanupOutputHalf, element: Element | ComponentPublicInstance | null) {
    const htmlElement = element instanceof HTMLElement ? element : null;
    const previous = outputFitAreas.get(half);
    if (previous === htmlElement) {
        return;
    }
    if (previous && previous !== htmlElement) outputResizeObserver?.unobserve(previous);
    if (!htmlElement) {
        return;
    }
    outputFitAreas.set(half, htmlElement);
    outputResizeObserver?.observe(htmlElement);
    updateOutputFitAreaSizes();
}

function setOutputCanvas(half: TScanCleanupOutputHalf, element: Element | ComponentPublicInstance | null) {
    const htmlElement = element instanceof HTMLElement ? element : null;
    if (!htmlElement) {
        return;
    }
    if (outputCanvases.get(half) === htmlElement) {
        return;
    }
    outputCanvases.set(half, htmlElement);
    const rect = htmlElement.getBoundingClientRect();
    outputCanvasRects[half] = {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
    };
    outputResizeObserver?.observe(htmlElement);
    updateOverlayGeometry();
}

function currentStageRect(): IScanCleanupDragRect | null {
    const rect = cutterStage.value?.getBoundingClientRect();
    if (!rect) {
        return null;
    }
    return {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
    };
}

function updateOverlayGeometry(force = false) {
    if (dragTransaction.active.value && !force) {
        return;
    }
    const stageRect = currentStageRect();
    const surfaceRect = previewSurface.value?.getBoundingClientRect();
    if (!stageRect || !surfaceRect) {
        return;
    }
    dragOverlayBounds.x = stageRect.x - surfaceRect.left;
    dragOverlayBounds.y = stageRect.y - surfaceRect.top;
    dragOverlayBounds.width = stageRect.width;
    dragOverlayBounds.height = stageRect.height;
    cutterStageSize.width = stageRect.width;
    cutterStageSize.height = stageRect.height;
    for (const [
        half,
        canvas,
    ] of outputCanvases) {
        const rect = canvas.getBoundingClientRect();
        outputCanvasRects[half] = {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
        };
    }
}

function updateOutputFitAreaSizes() {
    const stageRect = cutterStage.value?.getBoundingClientRect();
    for (const [
        half,
        element,
    ] of outputFitAreas) {
        const rect = element.getBoundingClientRect();
        const current = outputFitAreaSizes[half];
        const left = rect.left - (stageRect?.left ?? 0);
        const top = rect.top - (stageRect?.top ?? 0);
        if (
            current?.left !== left
            || current.top !== top
            || current.width !== rect.width
            || current.height !== rect.height
        ) {
            outputFitAreaSizes[half] = {
                left,
                top,
                width: rect.width,
                height: rect.height,
            };
        }
    }
    updateOverlayGeometry();
}

function pruneOutputElementRefs() {
    const activeHalves = new Set(props.result?.outputs.map(output => output.metadata.half) ?? []);
    for (const [
        half,
        element,
    ] of outputFitAreas) {
        if (!activeHalves.has(half)) {
            outputResizeObserver?.unobserve(element);
            outputFitAreas.delete(half);
            Reflect.deleteProperty(outputFitAreaSizes, half);
        }
    }
    for (const [
        half,
        element,
    ] of outputCanvases) {
        if (!activeHalves.has(half)) {
            outputResizeObserver?.unobserve(element);
            outputCanvases.delete(half);
            Reflect.deleteProperty(outputCanvasRects, half);
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
    for (const element of outputCanvases.values()) outputResizeObserver.observe(element);
    updateOutputFitAreaSizes();
}

function sourcePointFromClient(
    clientX: number,
    clientY: number,
    output: IRenderedScanCleanupOutput,
    rect: IScanCleanupDragRect,
) {
    return previewPointToSourceHalf(output.metadata, {
        x: (clientX - rect.x) / rect.width * output.placement.canvasWidthPx - output.placement.left,
        y: (clientY - rect.y) / rect.height * output.placement.canvasHeightPx - output.placement.top,
    });
}

function startContentDrag(
    event: PointerEvent,
    output: IScanCleanupContentOverlayOutput,
    handle: TScanCleanupContentHandle,
) {
    updateOverlayGeometry(true);
    const canvasClientRect = outputCanvasRects[output.metadata.half] ?? output.canvasClientRect;
    if (!output.contentRect || canvasClientRect.width <= 0 || canvasClientRect.height <= 0) {
        return;
    }
    const startRect = {...output.contentRect};
    const manualContentBox = props.manualContentBoxes?.[output.metadata.half];
    const canonicalGeometry: IContentDragGeometry = {
        kind: 'content',
        half: output.metadata.half,
        value: manualContentBox
            ? {...manualContentBox}
            : normalizePreviewContentBox(output.metadata, startRect),
    };
    const stageRect = currentStageRect();
    if (!stageRect) {
        return;
    }
    const started = dragTransaction.start(event, {
        canonicalGeometry,
        stageRect,
        fitScale: canvasClientRect.width / Math.max(1, output.placement.canvasWidthPx),
        update: pointerEvent => {
            const point = sourcePointFromClient(
                pointerEvent.clientX,
                pointerEvent.clientY,
                output,
                canvasClientRect,
            );
            return {
                kind: 'content',
                half: output.metadata.half,
                value: normalizePreviewContentBox(
                    output.metadata,
                    point
                        ? resizedContentRect(startRect, handle, point, output.metadata)
                        : startRect,
                ),
            };
        },
        commit: geometry => {
            if (geometry.kind === 'content') {
                emit('update:manualContentBox', geometry.half, geometry.value);
            }
        },
    });
    if (started) {
        captureDragOutputSnapshot();
        dragTransaction.move(event);
    }
}

function resizedContentRect(
    rect: IScanCleanupPixelRect,
    handle: TScanCleanupContentHandle,
    point: {
        x: number;
        y: number
    },
    metadata: IScanCleanupPreviewMetadata,
) {
    const minimum = Math.max(1, Math.min(metadata.sourceRegion.widthPx, metadata.sourceRegion.heightPx) * 0.02);
    let left = rect.xPx;
    let top = rect.yPx;
    let right = rect.xPx + rect.widthPx;
    let bottom = rect.yPx + rect.heightPx;
    if (handle.includes('w')) left = Math.min(right - minimum, point.x);
    if (handle.includes('e')) right = Math.max(left + minimum, point.x);
    if (handle.includes('n')) top = Math.min(bottom - minimum, point.y);
    if (handle.includes('s')) bottom = Math.max(top + minimum, point.y);
    left = Math.max(0, left);
    top = Math.max(0, top);
    right = Math.min(metadata.sourceRegion.widthPx, right);
    bottom = Math.min(metadata.sourceRegion.heightPx, bottom);
    return clampPreviewRect({
        xPx: left,
        yPx: top,
        widthPx: Math.max(minimum, right - left),
        heightPx: Math.max(minimum, bottom - top),
    }, metadata.sourceRegion.widthPx, metadata.sourceRegion.heightPx);
}

function nudgeContentBox(
    event: KeyboardEvent,
    output: IRenderedScanCleanupOutput,
    handle: TScanCleanupContentHandle,
) {
    if (!output.contentRect || !event.key.startsWith('Arrow')) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    const step = Math.max(1, Math.min(output.metadata.sourceRegion.widthPx, output.metadata.sourceRegion.heightPx)
        * (event.shiftKey ? 0.05 : 0.01));
    const point = {
        x: handle.includes('w') ? output.contentRect.xPx : output.contentRect.xPx + output.contentRect.widthPx,
        y: handle.includes('n') ? output.contentRect.yPx : output.contentRect.yPx + output.contentRect.heightPx,
    };
    if (event.key === 'ArrowLeft') point.x -= step;
    if (event.key === 'ArrowRight') point.x += step;
    if (event.key === 'ArrowUp') point.y -= step;
    if (event.key === 'ArrowDown') point.y += step;
    emit('update:manualContentBox', output.metadata.half, normalizePreviewContentBox(
        output.metadata,
        resizedContentRect(output.contentRect, handle, point, output.metadata),
    ));
}

function alignmentFromOffset(left: number, top: number, maxLeft: number, maxTop: number) {
    const horizontal = maxLeft <= 0 || left / maxLeft < 0.25
        ? 'left'
        : left / maxLeft > 0.75 ? 'right' : 'center';
    const vertical = maxTop <= 0 || top / maxTop < 0.25
        ? 'top'
        : top / maxTop > 0.75 ? 'bottom' : 'center';
    return vertical === 'center' && horizontal === 'center'
        ? 'center' as const
        : `${vertical}-${horizontal}` as TScanCleanupPageAlignment;
}

function startPlacementDrag(event: PointerEvent, output: IScanCleanupPlacementOverlayOutput) {
    updateOverlayGeometry(true);
    const canvasClientRect = outputCanvasRects[output.metadata.half] ?? output.canvasClientRect;
    if (!props.matchPageSize || canvasClientRect.width <= 0 || canvasClientRect.height <= 0) {
        return;
    }
    const maxLeft = Math.max(0, output.placement.canvasWidthPx - output.metadata.outputWidthPx);
    const maxTop = Math.max(0, output.placement.canvasHeightPx - output.metadata.outputHeightPx);
    const canonicalGeometry: IPlacementDragGeometry = {
        kind: 'placement',
        half: output.metadata.half,
        alignment: output.alignment,
        left: output.placement.left,
        top: output.placement.top,
    };
    const stageRect = currentStageRect();
    if (!stageRect) {
        return;
    }
    const fitScale = canvasClientRect.width / Math.max(1, output.placement.canvasWidthPx);
    const started = dragTransaction.start(event, {
        canonicalGeometry,
        stageRect,
        fitScale,
        update: (pointerEvent, snapshot) => {
            const left = Math.min(maxLeft, Math.max(0,
                output.placement.left + (pointerEvent.clientX - snapshot.pointerStart.x) / snapshot.fitScale,
            ));
            const top = Math.min(maxTop, Math.max(0,
                output.placement.top + (pointerEvent.clientY - snapshot.pointerStart.y) / snapshot.fitScale,
            ));
            return {
                kind: 'placement',
                half: output.metadata.half,
                alignment: alignmentFromOffset(left, top, maxLeft, maxTop),
                left,
                top,
            };
        },
        commit: geometry => {
            if (geometry.kind === 'placement') {
                emit('update:placement', geometry.half, geometry.alignment);
            }
        },
    });
    if (started) {
        captureDragOutputSnapshot();
        dragTransaction.move(event);
    }
}

function nudgePlacement(event: KeyboardEvent, output: IRenderedScanCleanupOutput) {
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

function updateCutterStageSize() {
    updateOverlayGeometry();
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

const {
    cleanedPixelSwaps,
    completeCleanedPixelSwap,
    completeRawPixelSwap,
    loadCleanedPixelSwap,
    loadRawPixelSwap,
    rawPixelSwap,
} = useScanCleanupPreviewImages(() => props.result, (hadPreviousResult) => {
    void nextTick(() => {
        pruneOutputElementRefs();
        refreshFrozenViewportFrame();
        if (!hadPreviousResult) {
            observeCutterStage();
        }
    });
});

onMounted(() => {
    observeCutterStage();
    observeOutputFitAreas();
});
watch([
    () => props.pageNumber,
    () => props.zoneEditing,
], () => {
    selectedZone.value = null;
});
watch(() => props.manualZones, () => {
    const selection = selectedZone.value;
    if (!selection) {
        return;
    }
    const count = selection.kind === 'picture'
        ? props.manualZones?.picture.length ?? 0
        : props.manualZones?.fill.length ?? 0;
    if (selection.index >= count) {
        selectedZone.value = null;
    }
}, {deep: true});
watch(() => dragTransaction.active.value, active => {
    if (!active) {
        dragOutputSnapshot.value = null;
        void nextTick(() => {
            refreshFrozenViewportFrame();
            updateOverlayGeometry();
        });
    }
});
onBeforeUnmount(() => {
    cutterResizeObserver?.disconnect();
    outputResizeObserver?.disconnect();
});

const renderedOutputs = computed(() => {
    if (dragTransaction.active.value && dragOutputSnapshot.value) {
        return dragOutputSnapshot.value;
    }
    if (!props.result) {
        return [];
    }
    const outputs = props.result.outputs.map((output): IRenderedScanCleanupOutput => {
        const metadata = output.metadata;
        const placement = resolvePreviewMetadataPlacement(metadata);
        const imageStyle = toPreviewStyleRect({
            xPx: 0,
            yPx: 0,
            widthPx: metadata.outputWidthPx,
            heightPx: metadata.outputHeightPx,
        }, placement);
        const manualContentRect = resolveNormalizedContentBox(metadata, props.manualContentBoxes?.[metadata.half]);
        const contentRect = manualContentRect ?? metadata.contentBox;
        const content = manualContentRect
            ? transformPreviewSourceHalfRect(metadata, contentRect)
            : transformPreviewContentBox(metadata);
        return {
            metadata,
            pixelSwap: cleanedPixelSwaps[metadata.half] ?? createPreviewImageSwap(),
            placement,
            imageStyle,
            contentRect,
            contentStyle: content ? toPreviewStyleRect(content, placement) : null,
            canvasStyle: {},
        };
    });
    const ordered = props.readingOrder === 'rtl' && outputs.length > 1 ? outputs.reverse() : outputs;
    const sizes = resolvePreviewOutputFitSizes(
        ordered.map(output => outputFitAreaSizes[output.metadata.half] ?? {
            width: 0,
            height: 0,
        }),
        ordered.map(output => ({
            width: output.placement.canvasWidthPx,
            height: output.placement.canvasHeightPx,
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

function activeStageRect() {
    return dragTransaction.snapshot.value?.stageRect ?? currentStageRect() ?? {
        x: 0,
        y: 0,
        width: dragOverlayBounds.width,
        height: dragOverlayBounds.height,
    };
}

const contentOverlayOutputs = computed<IScanCleanupContentOverlayOutput[]>(() => {
    if (activeCutterDraft.value || props.zoneEditing) {
        return [];
    }
    const stageRect = activeStageRect();
    const draft = draftGeometry.value?.kind === 'content' ? draftGeometry.value : null;
    const outputs = dragTransaction.active.value && dragOutputSnapshot.value
        ? dragOutputSnapshot.value
        : renderedOutputs.value;
    return outputs.flatMap(output => {
        const canvasClientRect = outputCanvasRects[output.metadata.half] ?? {
            x: stageRect.x,
            y: stageRect.y,
            width: 0,
            height: 0,
        };
        const normalized = draft?.half === output.metadata.half
            ? draft.value
            : props.manualContentBoxes?.[output.metadata.half];
        const contentRect = resolveNormalizedContentBox(output.metadata, normalized) ?? output.contentRect;
        const transformed = normalized
            ? transformPreviewSourceHalfRect(output.metadata, contentRect)
            : transformPreviewContentBox(output.metadata);
        if (!contentRect || !transformed) {
            return [];
        }
        return [{
            ...output,
            canvasClientRect: {...canvasClientRect},
            contentRect,
            style: toPreviewStyleRect(transformed, output.placement),
        }];
    });
});

const placementOverlayOutputs = computed<IScanCleanupPlacementOverlayOutput[]>(() => {
    const stageRect = activeStageRect();
    if (!props.matchPageSize || activeCutterDraft.value || props.zoneEditing) {
        return [];
    }
    const draft = draftGeometry.value?.kind === 'placement' ? draftGeometry.value : null;
    const outputs = dragTransaction.active.value && dragOutputSnapshot.value
        ? dragOutputSnapshot.value
        : renderedOutputs.value;
    return outputs.flatMap(output => {
        const canvasClientRect = outputCanvasRects[output.metadata.half] ?? {
            x: stageRect.x,
            y: stageRect.y,
            width: 0,
            height: 0,
        };
        const active = draft?.half === output.metadata.half;
        const placement = active ? {
            ...output.placement,
            left: draft.left,
            top: draft.top,
        } : output.placement;
        return [{
            ...output,
            pixelSwap: cleanedPixelSwaps[output.metadata.half] ?? output.pixelSwap,
            active,
            alignment: active
                ? draft.alignment
                : props.placementOverrides?.[output.metadata.half] ?? props.alignment,
            canvasClientRect: {...canvasClientRect},
            canvasStyle: {inset: '0'},
            imageStyle: toPreviewStyleRect({
                xPx: 0,
                yPx: 0,
                widthPx: output.metadata.outputWidthPx,
                heightPx: output.metadata.outputHeightPx,
            }, placement),
        }];
    });
});

function contentOverlayOutputFor(half: TScanCleanupOutputHalf) {
    const output = contentOverlayOutputs.value.find(candidate => candidate.metadata.half === half);
    return output ? [output] : [];
}

function placementOverlayOutputFor(half: TScanCleanupOutputHalf) {
    const output = placementOverlayOutputs.value.find(candidate => candidate.metadata.half === half);
    return output ? [output] : [];
}
</script>

<style>
.preview-pane {
    display: flex;
    height: 100%;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
}

.preview-pane:focus-visible {
    border-radius: var(--app-radius-lg);
    outline: 2px solid var(--ui-primary);
    outline-offset: var(--app-space-xs);
}

.preview-header,
.page-navigation,
.preview-controls,
.overlay-legend,
.refresh-indicator,
.page-loading-overlay,
.cutter-grab-handle {
    display: flex;
    align-items: center;
}

.refresh-indicator.is-error {
    border-color: var(--ui-error);
    color: var(--ui-error);
}

.preview-refresh-error {
    position: absolute;
    z-index: var(--app-z-local-overlay);
    inset-inline: var(--app-space-9xl);
    inset-block-end: var(--app-space-9xl);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: var(--app-space-5xl);
    border: 1px solid var(--ui-error);
    border-radius: var(--app-radius-md);
    background: var(--ui-bg);
    padding: var(--app-space-5xl) var(--app-space-9xl);
    color: var(--ui-error);
    font-size: var(--app-text-size-body-sm);
}

.preview-header {
    box-sizing: border-box;
    height: var(--app-scan-header-height);
    min-height: var(--app-scan-header-height);
    flex: 0 0 var(--app-scan-header-height);
    justify-content: space-between;
    gap: var(--app-space-3xl);
    border-block-end: var(--app-hairline-height) solid var(--ui-border);
    padding-inline: var(--app-space-12xl);
}

.preview-controls {
    gap: var(--app-space-9xl);
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
    margin: var(--app-space-12xl);
}

.preview-result-layer,
.preview-empty-layer {
    display: grid;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    grid-area: 1 / 1;
    place-items: center;
}

.preview-result-layer > .preview-viewport-layout,
.preview-result-layer > .preview-message {
    grid-area: 1 / 1;
}

.preview-viewport-layout {
    display: grid;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    grid-template-rows: minmax(0, 1fr) var(--app-control-height-sm);
}

.preview-viewport-caption {
    display: grid;
    min-width: 0;
    place-items: center;
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-body-sm);
    text-align: center;
}

.is-stale-content {
    opacity: var(--app-scan-preview-stale-opacity);
    pointer-events: none;
    transition: opacity var(--app-scan-preview-crossfade-duration);
    user-select: none;
}

.page-loading-overlay {
    position: absolute;
    z-index: var(--app-z-local-overlay);
    inset: 0;
    flex-direction: column;
    justify-content: center;
    gap: var(--app-space-5xl);
    background: color-mix(in srgb, var(--ui-bg-muted) 42%, transparent);
    color: var(--ui-text);
    font-size: var(--app-text-size-body-sm);
    font-weight: 600;
    pointer-events: none;
}

.raw-preview {
    position: relative;
    display: flex;
    width: 100%;
    height: 100%;
    min-height: 0;
    align-items: center;
    justify-content: center;
}

.lossless-crop-overlay {
    position: absolute;
    z-index: var(--app-z-local-raised);
    box-sizing: border-box;
    border: var(--app-hairline-height) solid var(--ui-primary);
    background: color-mix(in srgb, var(--ui-primary) 8%, transparent);
    pointer-events: none;
}

.cutter-stage {
    position: relative;
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
}

.drag-overlay-layer {
    position: absolute;
    z-index: var(--app-z-local-raised);
    pointer-events: none;
}

.preview-result-layer.is-source-underlay-dimmed {
    opacity: var(--app-scan-preview-stale-opacity);
}

.cutter-source-underlay,
.placement-overlay-canvas {
    position: absolute;
    pointer-events: none;
}

.cutter-source-underlay {
    overflow: hidden;
    background: var(--ui-bg);
    box-shadow: var(--app-document-page-shadow);
}

.cutter-source-underlay img {
    position: absolute;
    inset-inline-start: 50%;
    inset-block-start: 50%;
    max-width: none;
    max-height: none;
    object-fit: fill;
}

.cutter-control {
    position: absolute;
    inset-block: 0;
    z-index: var(--app-z-local-raised);
    width: var(--app-space-9xl);
    border: 0;
    border-radius: var(--app-radius-md);
    background: transparent;
    cursor: col-resize;
    pointer-events: auto;
    touch-action: none;
    transform: translateX(-50%);
}

.cutter-control.is-refreshing {
    opacity: var(--app-scan-preview-stale-opacity);
}

.cutter-line {
    position: absolute;
    inset-block: 0;
    inset-inline-start: 50%;
    width: var(--app-space-xs);
    background: var(--ui-primary);
    box-shadow: 0 0 0 var(--app-hairline-height) var(--ui-bg);
    transform: translateX(-50%);
    transition:
        background-color var(--app-transition-fast),
        width var(--app-transition-fast);
}

.cutter-control:hover .cutter-line,
.cutter-control:focus-visible .cutter-line {
    width: var(--app-space-sm);
    background: var(--ui-primary-hover);
}

.cutter-grab-handle {
    position: absolute;
    inset-inline-start: 50%;
    inset-block-start: 50%;
    width: var(--app-scan-cutter-handle-width);
    height: var(--app-scan-cutter-handle-height);
    justify-content: center;
    border: var(--app-hairline-height) solid var(--ui-primary);
    border-radius: var(--app-radius-md);
    background: var(--ui-bg);
    color: var(--ui-primary);
    box-shadow: var(--shadow-sm);
    transform: translate(-50%, -50%);
}

.cutter-control:focus-visible {
    outline: 2px solid var(--ui-primary);
    outline-offset: var(--app-space-xs);
}

.cleaned-outputs {
    display: grid;
    width: 100%;
    height: 100%;
    min-height: 0;
    grid-auto-columns: minmax(0, 1fr);
    grid-auto-flow: column;
}

.raw-preview img {
    display: block;
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    box-shadow: var(--app-document-page-shadow);
}

.raw-preview .preview-pixel {
    position: absolute;
    inset: 0;
    margin: auto;
}

.output-column {
    box-sizing: border-box;
    display: flex;
    min-width: 0;
    min-height: 0;
    max-width: 100%;
    flex-direction: column;
    align-items: center;
    gap: var(--app-space-sm);
    padding-inline: calc(var(--app-space-3xl) / 2);
}

.output-fit-area {
    display: grid;
    width: 100%;
    min-height: 0;
    flex: 1;
    place-items: center;
}

.uniform-canvas {
    position: relative;
    min-height: 0;
    flex: none;
    border: var(--app-hairline-height) dashed transparent;
    border-radius: var(--app-radius-md);
    background: var(--ui-bg);
    box-shadow: var(--app-document-page-shadow);
    overflow: hidden;
}

.uniform-canvas.has-uniform-canvas {
    border-color: var(--ui-border);
    background: var(--ui-bg-elevated);
}

.placed-image,
.content-overlay,
.placement-control {
    position: absolute;
    display: block;
}

.placed-image {
    touch-action: none;
}

.placed-image.is-draggable {
    cursor: grab;
}

.placed-image.is-draggable:active {
    cursor: grabbing;
}

.placed-image.is-drag-placeholder {
    opacity: var(--app-scan-preview-stale-opacity);
}

.placement-control {
    border: 0;
    background: transparent;
    cursor: grab;
    pointer-events: auto;
    touch-action: none;
}

.placement-control.is-active {
    box-shadow: var(--app-document-page-shadow);
    cursor: grabbing;
}

.placement-control:focus-visible {
    outline: var(--app-hairline-height) solid var(--ui-primary);
    outline-offset: var(--app-space-xs);
}

.placement-snap-anchor {
    position: absolute;
    width: var(--app-space-sm);
    height: var(--app-space-sm);
    border: var(--app-hairline-height) solid var(--ui-primary);
    border-radius: 50%;
    background: var(--ui-bg);
    opacity: var(--app-scan-preview-stale-opacity);
    transform: translate(-50%, -50%);
}

.placement-snap-anchor.is-nearest {
    background: var(--ui-primary);
    opacity: 1;
}

.placed-image:focus-visible,
.content-overlay:focus-visible {
    outline: var(--app-hairline-height) solid var(--ui-primary);
    outline-offset: var(--app-space-xs);
}

.cleaned-image {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: fill;
    pointer-events: none;
}

.placed-image > .preview-pixel {
    position: absolute;
    inset: 0;
}

.preview-pixel {
    transition: opacity var(--app-scan-preview-crossfade-duration);
}

.preview-pixel.is-incoming,
.preview-pixel.is-outgoing {
    opacity: 0;
}

.preview-pixel.is-entering {
    opacity: 1;
}

.margin-overlay {
    position: absolute;
    inset: 0;
    box-sizing: border-box;
    border: var(--app-hairline-height) solid var(--ui-warning);
    pointer-events: none;
}

.content-overlay {
    box-sizing: border-box;
    border: var(--app-hairline-height) solid var(--ui-primary);
    background: color-mix(in srgb, var(--ui-primary) 10%, transparent);
    pointer-events: auto;
    touch-action: none;
}

.content-handle {
    position: absolute;
    width: var(--app-scan-content-handle-hit-size);
    height: var(--app-scan-content-handle-hit-size);
    border: 0;
    background: transparent;
    padding: 0;
    touch-action: none;
}

.content-handle::after {
    position: absolute;
    inset: 50% auto auto 50%;
    width: var(--app-scan-content-handle-size);
    height: var(--app-scan-content-handle-size);
    border: var(--app-hairline-height) solid var(--ui-primary);
    border-radius: var(--app-radius-xs);
    background: var(--ui-bg);
    content: '';
    opacity: 0;
    transform: translate(-50%, -50%);
    transition: opacity var(--app-transition-fast);
}

.content-overlay:hover .content-handle::after,
.content-overlay:focus-within .content-handle::after,
.content-handle:focus-visible::after {
    opacity: 1;
}

.content-handle.is-n,
.content-handle.is-s {
    left: 50%;
    cursor: ns-resize;
    transform: translateX(-50%);
}

.content-handle.is-e,
.content-handle.is-w {
    top: 50%;
    cursor: ew-resize;
    transform: translateY(-50%);
}

.content-handle.is-n,
.content-handle.is-ne,
.content-handle.is-nw {
    top: calc(-0.5 * var(--app-scan-content-handle-hit-size));
}

.content-handle.is-s,
.content-handle.is-se,
.content-handle.is-sw {
    bottom: calc(-0.5 * var(--app-scan-content-handle-hit-size));
}

.content-handle.is-e,
.content-handle.is-ne,
.content-handle.is-se {
    right: calc(-0.5 * var(--app-scan-content-handle-hit-size));
}

.content-handle.is-w,
.content-handle.is-nw,
.content-handle.is-sw {
    left: calc(-0.5 * var(--app-scan-content-handle-hit-size));
}

.content-handle.is-ne,
.content-handle.is-sw {
    cursor: nesw-resize;
}

.content-handle.is-nw,
.content-handle.is-se {
    cursor: nwse-resize;
}

.scan-cleanup-first-run-guidance {
    position: absolute;
    z-index: var(--app-z-local-overlay);
    inset-inline-start: 50%;
    inset-block-start: 50%;
    display: grid;
    width: min(var(--app-scan-first-run-guidance-width), calc(100% - var(--app-space-16xl)));
    gap: var(--app-space-7xl);
    border: var(--app-hairline-height) solid var(--ui-border);
    border-radius: var(--app-radius-lg);
    background: color-mix(in srgb, var(--ui-bg-elevated) 96%, transparent);
    box-shadow: var(--shadow-lg);
    padding: var(--app-space-12xl);
    color: var(--ui-text);
    font-size: var(--app-text-size-body-sm);
    transform: translate(-50%, -50%);
}

.scan-cleanup-first-run-guidance ol {
    display: grid;
    gap: var(--app-space-5xl);
    margin: 0;
    padding-inline-start: var(--app-space-16xl);
    color: var(--ui-text-muted);
}

.scan-cleanup-first-run-guidance button {
    justify-self: end;
}

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

.preview-loading {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
}

.preview-skeleton-page {
    background: var(--ui-bg);
    border: var(--app-hairline-height) solid var(--ui-border);
}

.preview-skeleton-page .preview-skeleton-fill {
    position: absolute;
    inset: var(--app-space-2xl);
    width: auto;
    height: auto;
    background: var(--ui-bg-accented);
    border-radius: inherit;
}

.preview-message.is-error,
.preview-error-detail {
    color: var(--ui-error);
}

.preview-error-detail {
    display: block;
    max-width: var(--app-scan-preview-message-width);
    margin-block-start: var(--app-space-sm);
    font-size: var(--app-text-size-kicker);
    overflow-wrap: anywhere;
}

.preview-error-disclosure {
    width: 100%;
    color: var(--ui-text-muted);
    text-align: start;
}

.preview-error-disclosure summary {
    cursor: pointer;
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
