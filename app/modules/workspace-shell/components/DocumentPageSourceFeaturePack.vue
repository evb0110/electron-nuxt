<template>
    <div
        class="document-source-feature-pack"
        data-document-feature-pack="page-source"
        data-testid="document-page-source-viewer"
    >
        <Teleport to="#document-viewer-chassis-sidebar">
            <DocumentSourceSidebar
                v-if="showSidebar"
                :source="source"
                :current-page="currentPage"
                :annotation-revision="annotationRevision"
                @go-to-page="scrollToPage"
                @annotations-changed="annotationRevision += 1"
            />
        </Teleport>
        <div
            class="document-source-viewer__surface"
            :style="surfaceStyle"
        >
            <template
                v-for="pageNumber in mountedPages"
                :key="pageNumber"
            >
                <Teleport
                    v-if="getChassisOpeningShellTarget(pageNumber)"
                    :to="getChassisOpeningShellTarget(pageNumber)!"
                >
                    <div
                        v-if="getVisual(pageNumber) === 'none'"
                        class="document-source-viewer__pending-frame"
                    />
                    <img
                        v-if="getSurface(pageNumber)"
                        :key="getSurface(pageNumber)!"
                        :src="getSurface(pageNumber)!"
                        class="document-source-viewer__image"
                        :class="{'document-source-viewer__image--committed': getVisual(pageNumber) === 'fresh'}"
                        alt=""
                        draggable="false"
                        data-testid="document-page-source-image"
                        :data-page-render-generation="getRenderGeneration(pageNumber)"
                        :data-document-load-generation="loadGeneration"
                        :data-open-surface-generation="activeOpenSurfaceGeneration ?? ''"
                        @load="handleSurfaceLoad(pageNumber, getSurface(pageNumber)!, $event)"
                        @error="handleSurfaceError(pageNumber, getSurface(pageNumber)!)"
                    >
                    <div
                        v-if="getVisual(pageNumber) === 'error'"
                        class="document-source-viewer__error"
                        role="alert"
                    >
                        {{ getVisualError(pageNumber) }}
                    </div>
                    <template v-if="getVisual(pageNumber) === 'fresh'">
                        <button
                            v-for="annotation in getAnnotations(pageNumber)"
                            :key="annotation.id"
                            type="button"
                            class="document-source-viewer__annotation"
                            :style="getAnnotationStyle(annotation)"
                            :aria-label="String(annotation.payload.label ?? 'Annotation')"
                        />
                    </template>
                </Teleport>
                <section
                    v-else
                    :ref="element => setPageElement(pageNumber, element)"
                    class="document-source-viewer__page"
                    :style="getPageStyle(pageNumber)"
                    :data-page-number="pageNumber"
                    :data-page-source-visual="getVisual(pageNumber)"
                    data-testid="document-page-source-page"
                >
                    <div
                        v-if="getVisual(pageNumber) === 'skeleton'"
                        class="document-source-viewer__skeleton"
                    />
                    <div
                        v-else-if="getVisual(pageNumber) === 'error'"
                        class="document-source-viewer__error"
                        role="alert"
                    >
                        {{ getVisualError(pageNumber) }}
                    </div>
                    <img
                        v-if="getSurface(pageNumber)"
                        :key="getSurface(pageNumber)!"
                        :src="getSurface(pageNumber)!"
                        class="document-source-viewer__image"
                        :class="{'document-source-viewer__image--committed': getVisual(pageNumber) === 'fresh'}"
                        alt=""
                        draggable="false"
                        data-testid="document-page-source-image"
                        :data-page-render-generation="getRenderGeneration(pageNumber)"
                        :data-document-load-generation="loadGeneration"
                        :data-open-surface-generation="activeOpenSurfaceGeneration ?? ''"
                        @load="handleSurfaceLoad(pageNumber, getSurface(pageNumber)!, $event)"
                        @error="handleSurfaceError(pageNumber, getSurface(pageNumber)!)"
                    >
                    <template v-if="getVisual(pageNumber) === 'fresh'">
                        <button
                            v-for="annotation in getAnnotations(pageNumber)"
                            :key="annotation.id"
                            type="button"
                            class="document-source-viewer__annotation"
                            :style="getAnnotationStyle(annotation)"
                            :aria-label="String(annotation.payload.label ?? 'Annotation')"
                        />
                    </template>
                </section>
            </template>
        </div>
    </div>
</template>

<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import { useResizeObserver } from '@vueuse/core';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TPdfViewMode } from '@contracts/shared';
import type { IDocumentViewerExpose } from '@app/modules/pdf-viewer/public';
import DocumentSourceSidebar from '@app/modules/workspace-shell/components/DocumentSourceSidebar.vue';
import { createDjvuPagePreviewSourceFromPath } from '@app/platform/browser-api/public';
import { createDjvuPageSource } from '@app/utils/document-viewer/source/createDjvuPageSource';
import type {
    IDocumentPageMetrics,
    IDocumentPageSource,
    IDocumentAnnotationRecord,
    IDocumentSourceCapabilities,
    IDocumentSurfaceLease,
    TDocumentRenderPriority,
} from '@app/utils/document-viewer/source/documentPageSource';
import { createRafCoalescedCallback } from '@app/utils/createRafCoalescedCallback';
import { workspaceSurfaceBudgetController } from '@app/modules/workspace-shell/memory/workspaceSurfaceBudgetController';
import { injectDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import { shouldProjectDocumentViewportScroll } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import { createDocumentViewportWritePort } from '@app/utils/document-viewer/chassis/documentViewportWritePort';
import { createWheelFlipGate } from '@app/utils/document-viewer/single-page-wheel/createWheelFlipGate';
import {
    createColdOpenProvisionalDocumentPageMetrics,
    createProvisionalDocumentPageMetrics,
    hydrateRemainingDocumentPageMetrics,
    loadInitialDocumentPageMetric,
} from '@app/modules/workspace-shell/viewers/loadPrioritizedDocumentPageMetrics';
import {
    canScrollWithinPageBounds,
    resolveWheelDirection,
    resolveWheelTargetPage,
} from '@app/utils/document-viewer/single-page-wheel/singlePageWheelNavigation';
import {
    clampDocumentFitScale,
    clampDocumentManualZoom,
} from '@app/utils/document-viewer/zoomPolicy';
import { resolveDocumentPageSourceOpeningFrame } from '@app/modules/workspace-shell/viewers/resolveDocumentPageSourceOpeningFrame';
import { createDocumentPageSourceVisualRetryState } from '@app/modules/workspace-shell/viewers/createDocumentPageSourceVisualRetryState';
import {
    captureDocumentZoomAnchor,
    resolveDocumentZoomAnchorScroll,
} from '@app/utils/document-viewer/zoomAnchor';

interface IPageVisualState {
    generation: number;
    error: string | null;
    ready: boolean;
    lease: IDocumentSurfaceLease | null;
    priority: TDocumentRenderPriority;
    widthPx: number;
    unsubscribeInvalidation: (() => void) | null;
}

let nextSourcePageSlotOwnerId = 0;

defineOptions({inheritAttrs: false});

const {
    src,
    zoom = 1,
    zoomMode = 'fit-width',
    fitMode = 'width',
    viewMode = 'single',
    continuousScroll = true,
    dragMode = false,
    documentRevisionToken = null,
    isActive = true,
    currentPage = 1,
    showSidebar = false,
} = defineProps<{
    src: TDocumentRef | null;
    zoom?: number;
    zoomMode?: 'custom' | 'fit-width' | 'fit-height';
    fitMode?: 'width' | 'height';
    viewMode?: TPdfViewMode;
    continuousScroll?: boolean;
    dragMode?: boolean;
    documentRevisionToken?: TDocumentRevisionToken | null;
    isActive?: boolean;
    currentPage?: number;
    showSidebar?: boolean;
}>();
void fitMode;
void dragMode;
const emit = defineEmits<{
    'update:zoom': [number];
    'update:zoomMode': ['custom' | 'fit-width' | 'fit-height'];
    'update:effectiveZoom': [number];
    'update:currentPage': [number];
    'update:totalPages': [number];
    'update:document': [null];
    'update:sourceCapabilities': [IDocumentSourceCapabilities];
    loading: [boolean];
    loadError: [unknown];
    'initial-visual-pending': [];
    'initial-visual-ready': [{pageNumber: number;}];
}>();

const viewerContainer = ref<HTMLElement | null>(null);
const containerWidth = ref(0);
const containerHeight = ref(0);
const wheelFlipGate = createWheelFlipGate();
const chassisAuthority = injectDocumentViewerChassisAuthority();
const viewportWritePort = chassisAuthority?.viewportWritePort ?? createDocumentViewportWritePort();
const renderSession = chassisAuthority?.renderCoordinator.createSession(
    `page-source-feature:${String(++nextSourcePageSlotOwnerId)}`,
);
const openingPageFrameOwnerId = `page-source:${String(nextSourcePageSlotOwnerId)}`;
const pageSlots = renderSession?.pageSlots;
const surfaceBudget = chassisAuthority?.surfaceBudget ?? workspaceSurfaceBudgetController;
const source = shallowRef<IDocumentPageSource | null>(null);
const pageMetrics = shallowRef<IDocumentPageMetrics[]>([]);
const exactPageMetricNumbers = new Set<number>();
const exactPageMetricLoads = new Map<number, Promise<IDocumentPageMetrics>>();
const pageStates = shallowReactive(new Map<number, IPageVisualState>());
const renderControllers = new Map<number, AbortController>();
const DOCUMENT_SOURCE_VISUAL_ERROR_MAX_RETRIES = 2;
const visualRetryState = createDocumentPageSourceVisualRetryState(DOCUMENT_SOURCE_VISUAL_ERROR_MAX_RETRIES);
const DOCUMENT_SOURCE_CONTINUOUS_MOUNT_RADIUS = 12;
const DOCUMENT_SOURCE_PAGE_MARGIN = 16;
const loadGeneration = ref(0);
const annotationRevision = ref(0);
let loadSettled = Promise.resolve();
let loadController: AbortController | null = null;
let releaseViewportFeature: (() => void) | null = null;
let deferredMetricHydration: (() => Promise<void>) | null = null;
let activeOpenSurfaceGeneration: number | null = null;
let activeOpenSurfaceRevision: string | null = null;

function supersedeActiveOpenSurfaceGeneration() {
    const openSurface = chassisAuthority?.openSurface;
    const snapshot = openSurface?.snapshot.value;
    if (
        !openSurface
        || !snapshot
        || activeOpenSurfaceGeneration === null
        || snapshot.generation !== activeOpenSurfaceGeneration
        || snapshot.openingPageFrame?.ownerId !== openingPageFrameOwnerId
        || ![
            'pending',
            'geometry-committed',
            'canvas-committed',
            'viewport-committed',
        ].includes(snapshot.phase)
    ) {
        activeOpenSurfaceGeneration = null;
        activeOpenSurfaceRevision = null;
        return;
    }
    openSurface.supersede();
    activeOpenSurfaceGeneration = null;
    activeOpenSurfaceRevision = null;
}

onMounted(() => {
    viewerContainer.value = chassisAuthority?.viewportElement.value ?? null;
    measureViewport();
    releaseViewportFeature = chassisAuthority?.bindViewportFeature({
        getClass: () => 'document-source-viewer app-scrollbar',
        getStyle: () => ({}),
        events: {
            scroll: () => handleScroll(),
            wheel: event => handleWheel(event as WheelEvent),
        },
    }) ?? null;
});

function measureViewport() {
    containerWidth.value = viewerContainer.value?.clientWidth ?? 0;
    containerHeight.value = viewerContainer.value?.clientHeight ?? 0;
}
useResizeObserver(viewerContainer, measureViewport);

const effectiveZoom = computed(() => {
    const metric = pageMetrics.value[currentPage - 1];
    if (zoomMode === 'custom' || !metric) {
        return clampDocumentManualZoom(zoom);
    }
    const widthScale = clampDocumentFitScale((containerWidth.value - 32) / metric.widthPoints);
    if (zoomMode === 'fit-height') {
        return clampDocumentFitScale((containerHeight.value - 32) / metric.heightPoints);
    }
    return widthScale;
});
const pageHeights = computed(() => pageMetrics.value.map(metric => metric.heightPoints * effectiveZoom.value));
const pageTops = computed(() => {
    let top = DOCUMENT_SOURCE_PAGE_MARGIN;
    return pageHeights.value.map((height) => {
        const value = top;
        top += height + DOCUMENT_SOURCE_PAGE_MARGIN;
        return value;
    });
});
const totalHeight = computed(() => Math.max(
    containerHeight.value,
    (pageTops.value.at(-1) ?? DOCUMENT_SOURCE_PAGE_MARGIN)
        + (pageHeights.value.at(-1) ?? 0)
        + DOCUMENT_SOURCE_PAGE_MARGIN,
    (pageTops.value[currentPage - 1] ?? DOCUMENT_SOURCE_PAGE_MARGIN)
        + (pageHeights.value[currentPage - 1] ?? 0)
        + DOCUMENT_SOURCE_PAGE_MARGIN,
));
const pageLayouts = computed(() => pageMetrics.value.map((metric, index) => ({
    top: continuousScroll
        ? pageTops.value[index] ?? DOCUMENT_SOURCE_PAGE_MARGIN
        : DOCUMENT_SOURCE_PAGE_MARGIN,
    width: metric.widthPoints * effectiveZoom.value,
    height: metric.heightPoints * effectiveZoom.value,
})));
const mountedPages = computed(() => {
    const pageCount = source.value?.pageCount
        ?? chassisAuthority?.openSurface.snapshot.value.openingPageGeometry?.pageCount
        ?? pageMetrics.value.length;
    if (pageCount === 0) {
        return [];
    }
    return renderSession?.resolveMountedPages({
        currentPage,
        destinationPage: chassisAuthority?.openSurface.snapshot.value.openingPageFrame?.pageNumber,
        pageCount,
        radius: continuousScroll ? DOCUMENT_SOURCE_CONTINUOUS_MOUNT_RADIUS : 3,
    }) ?? [];
});
const surfaceStyle = computed(() => ({height: continuousScroll ? `${Math.max(1, totalHeight.value)}px` : '100%'}));

function getPageStyle(pageNumber: number) {
    const metrics = pageMetrics.value[pageNumber - 1];
    if (!metrics) {
        return {};
    }
    const width = metrics.widthPoints * effectiveZoom.value;
    const height = metrics.heightPoints * effectiveZoom.value;
    return {
        width: `${width}px`,
        height: `${height}px`,
        top: continuousScroll
            ? `${String(pageTops.value[pageNumber - 1] ?? DOCUMENT_SOURCE_PAGE_MARGIN)}px`
            : `${String(DOCUMENT_SOURCE_PAGE_MARGIN)}px`,
        left: `max(${String(DOCUMENT_SOURCE_PAGE_MARGIN)}px, calc(50% - ${String(width / 2)}px))`,
        display: !continuousScroll && pageNumber !== currentPage ? 'none' : undefined,
    };
}
function isChassisOpeningPage(pageNumber: number) {
    const snapshot = chassisAuthority?.openSurface.snapshot.value;
    const frame = snapshot?.openingPageFrame;
    return Boolean(
        frame
        && snapshot !== undefined
        && frame.generation === snapshot.generation
        && frame.pageNumber === pageNumber
        && frame.pageNumber === chassisAuthority?.currentPage.value,
    );
}
function getChassisOpeningShellTarget(pageNumber: number) {
    const snapshot = chassisAuthority?.openSurface.snapshot.value;
    const frame = snapshot?.openingPageFrame;
    const target = chassisAuthority?.openingPageElement.value;
    return isChassisOpeningPage(pageNumber)
        && target?.isConnected
        && target.dataset.pageNumber === String(pageNumber)
        && target.dataset.openSurfaceGeneration === String(snapshot?.generation)
        && target.dataset.openSurfaceFrameOwner === frame?.ownerId
        ? target
        : null;
}
function getVisual(pageNumber: number) {
    const state = pageStates.get(pageNumber);
    const viewportVisual = chassisAuthority?.openSurface.viewportSession.value.visual;
    if (viewportVisual?.kind === 'page' && viewportVisual.pageNumber === pageNumber) {
        if (viewportVisual.presentation === 'skeleton') {
            return 'skeleton';
        }
        if (viewportVisual.presentation === 'error') {
            return 'error';
        }
        if (viewportVisual.presentation === 'canvas') {
            return state?.ready ? 'fresh' : 'none';
        }
        return 'none';
    }
    return state?.error ? 'error' : state?.ready ? 'fresh' : 'none';
}
function getVisualError(pageNumber: number) {
    const viewportVisual = chassisAuthority?.openSurface.viewportSession.value.visual;
    return pageStates.get(pageNumber)?.error
        ?? (viewportVisual?.kind === 'page' && viewportVisual.pageNumber === pageNumber
            ? viewportVisual.error
            : null)
        ?? `Unable to display page ${String(pageNumber)}`;
}

function beginPagePresentationPending(
    pageNumber: number,
    state: IPageVisualState,
) {
    state.error = null;
    state.ready = false;
    const openSurface = chassisAuthority?.openSurface;
    const viewportState = openSurface?.viewportSession.value;
    if (
        openSurface
        && viewportState?.lifecycle === 'ready'
        && viewportState.requestedPage === pageNumber
    ) {
        openSurface.requestNavigation(pageNumber);
    }
}

function commitPageTerminalError(pageNumber: number) {
    let state = pageStates.get(pageNumber);
    if (!state) {
        const errorState = shallowReactive<IPageVisualState>({
            generation: loadGeneration.value,
            error: null,
            ready: false,
            lease: null,
            priority: 'navigation',
            widthPx: 0,
            unsubscribeInvalidation: null,
        });
        pageStates.set(pageNumber, errorState);
        state = errorState;
    }
    state.unsubscribeInvalidation?.();
    state.lease?.release();
    state.unsubscribeInvalidation = null;
    state.lease = null;
    const message = `Unable to display page ${String(pageNumber)}`;
    state.error = message;
    state.ready = false;
    const openSurface = chassisAuthority?.openSurface;
    const snapshot = openSurface?.snapshot.value;
    const viewportState = openSurface?.viewportSession.value;
    if (
        openSurface
        && snapshot
        && viewportState?.requestedPage === pageNumber
        && activeOpenSurfaceGeneration !== null
        && snapshot.generation === activeOpenSurfaceGeneration
    ) {
        if (viewportState.lifecycle === 'transitioning') {
            const navigationFence = openSurface.createRenderFence({
                generation: activeOpenSurfaceGeneration,
                documentRevision: snapshot.identity?.documentRevision ?? '',
                renderVersion: loadGeneration.value,
                requestId: state.generation,
                pageNumber,
            });
            if (navigationFence) openSurface.reject(navigationFence, message);
        } else {
            const committedFence = snapshot.committedRender;
            if (committedFence?.pageNumber === pageNumber) {
                openSurface.reject(committedFence, message);
            } else {
                openSurface.fail(activeOpenSurfaceGeneration, message);
            }
        }
    }
    return message;
}
function getSurface(pageNumber: number) {
    const surface = pageStates.get(pageNumber)?.lease?.surface;
    return typeof surface === 'string' ? surface : null;
}
function getRenderGeneration(pageNumber: number) {
    return pageStates.get(pageNumber)?.generation ?? '';
}
function getAnnotations(pageNumber: number) {
    void annotationRevision.value;
    return source.value?.annotationProvider?.getPageAnnotations(pageNumber) ?? [];
}
function getAnnotationNumber(payload: Readonly<Record<string, unknown>>, key: string, fallback: number) {
    const value = payload[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function getAnnotationStyle(annotation: IDocumentAnnotationRecord) {
    const {payload} = annotation;
    return {
        left: `${getAnnotationNumber(payload, 'x', 0.08) * 100}%`,
        top: `${getAnnotationNumber(payload, 'y', 0.08) * 100}%`,
        width: `${getAnnotationNumber(payload, 'width', 0.18) * 100}%`,
        height: `${getAnnotationNumber(payload, 'height', 0.08) * 100}%`,
        borderColor: typeof payload.color === 'string' ? payload.color : '#f59e0b',
    };
}
function setPageElement(pageNumber: number, element: Element | ComponentPublicInstance | null) {
    if (element instanceof HTMLElement) {
        pageSlots?.markMounted(pageNumber);
    } else {
        pageSlots?.markUnmounted(pageNumber);
    }
}

let chassisOpeningSlotPage: number | null = null;
watch(
    () => [
        chassisAuthority?.openingPageElement.value ?? null,
        chassisAuthority?.openSurface.snapshot.value.openingPageFrame?.pageNumber ?? null,
        chassisAuthority?.openSurface.snapshot.value.generation ?? null,
    ] as const,
    ([
        _target,
        pageNumber,
        _generation,
    ]) => {
        const ownedTarget = pageNumber === null ? null : getChassisOpeningShellTarget(pageNumber);
        if (
            chassisOpeningSlotPage !== null
            && (!ownedTarget || chassisOpeningSlotPage !== pageNumber)
        ) {
            pageSlots?.markUnmounted(chassisOpeningSlotPage);
            chassisOpeningSlotPage = null;
        }
        if (!ownedTarget || pageNumber === null || chassisOpeningSlotPage === pageNumber) {
            return;
        }
        pageSlots?.markMounted(pageNumber);
        chassisOpeningSlotPage = pageNumber;
    },
    {
        flush: 'post',
        immediate: true,
    },
);

function publishExactPageMetric(
    activeSource: IDocumentPageSource,
    generation: number,
    pageNumber: number,
    metric: IDocumentPageMetrics,
) {
    if (
        source.value !== activeSource
        || generation !== loadGeneration.value
        || pageNumber < 1
        || pageNumber > activeSource.pageCount
    ) {
        return false;
    }
    const nextMetrics = pageMetrics.value.slice();
    nextMetrics[pageNumber - 1] = metric;
    pageMetrics.value = nextMetrics;
    exactPageMetricNumbers.add(pageNumber);
    return true;
}

function ensureExactPageMetric(
    activeSource: IDocumentPageSource,
    generation: number,
    pageNumber: number,
    signal: AbortSignal,
) {
    const exactMetric = pageMetrics.value[pageNumber - 1];
    if (exactPageMetricNumbers.has(pageNumber) && exactMetric) {
        return Promise.resolve(exactMetric);
    }
    const pendingMetric = exactPageMetricLoads.get(pageNumber);
    if (pendingMetric) {
        return pendingMetric;
    }
    const metricLoad = loadInitialDocumentPageMetric(activeSource, pageNumber, signal)
        .then((metric) => {
            publishExactPageMetric(activeSource, generation, pageNumber, metric);
            return metric;
        })
        .finally(() => {
            if (exactPageMetricLoads.get(pageNumber) === metricLoad) {
                exactPageMetricLoads.delete(pageNumber);
            }
        });
    exactPageMetricLoads.set(pageNumber, metricLoad);
    return metricLoad;
}

async function renderPage(pageNumber: number) {
    const activeSource = source.value;
    const generation = loadGeneration.value;
    const signal = loadController?.signal;
    if (!activeSource || !signal || !isActive) {
        return;
    }
    if (!exactPageMetricNumbers.has(pageNumber)) {
        if (pageNumber !== currentPage) {
            return;
        }
        try {
            await ensureExactPageMetric(activeSource, generation, pageNumber, signal);
            await nextTick();
        } catch (error) {
            if (!(error instanceof DOMException && error.name === 'AbortError')) {
                const message = commitPageTerminalError(pageNumber);
                if (pageNumber === currentPage) {
                    emit('loadError', error instanceof Error ? error : new Error(message));
                }
            }
            return;
        }
    }
    const metric = pageMetrics.value[pageNumber - 1];
    if (
        !metric
        || !exactPageMetricNumbers.has(pageNumber)
        || source.value !== activeSource
        || generation !== loadGeneration.value
        || signal.aborted
    ) {
        return;
    }
    const previous = pageStates.get(pageNumber);
    const priority: TDocumentRenderPriority = pageNumber === currentPage ? 'navigation' : 'nearby';
    const widthPx = Math.max(1, Math.round(
        metric.widthPoints * effectiveZoom.value * (window.devicePixelRatio || 1),
    ));
    const activeController = renderControllers.get(pageNumber);
    if (previous?.widthPx === widthPx) {
        if (previous.lease) {
            if (priority === 'navigation' && previous.priority !== 'navigation') {
                previous.lease.promotePriority?.('navigation');
                previous.priority = 'navigation';
            }
            if (previous.ready && priority === 'navigation') {
                void nextTick(() => commitReadyPageToViewportSession(pageNumber, previous));
            }
            return;
        }
        if (activeController && (previous.priority === 'navigation' || priority !== 'navigation')) {
            return;
        }
    }
    activeController?.abort();
    previous?.unsubscribeInvalidation?.();
    previous?.lease?.release();
    if (previous) {
        previous.unsubscribeInvalidation = null;
        previous.lease = null;
        beginPagePresentationPending(pageNumber, previous);
    }
    const controller = new AbortController();
    renderControllers.set(pageNumber, controller);
    let attemptGeneration: number | null = null;
    try {
        const renderOutcome = await renderSession?.runPageRender(
            pageNumber,
            async (generation) => {
                attemptGeneration = generation;
                const nextState = shallowReactive<IPageVisualState>({
                    generation,
                    error: null,
                    ready: false,
                    lease: null,
                    priority,
                    widthPx,
                    unsubscribeInvalidation: null,
                });
                pageStates.set(pageNumber, nextState);
                beginPagePresentationPending(pageNumber, nextState);
                await nextTick();
                return activeSource.renderPage({
                    pageNumber,
                    widthPx,
                    priority,
                    signal: controller.signal,
                });
            },
        );
        if (!renderOutcome) {
            return;
        }
        const {
            generation,
            value: lease,
        } = renderOutcome;
        const current = pageStates.get(pageNumber);
        if (!renderOutcome.committed || source.value !== activeSource || current?.generation !== generation) {
            lease.release();
            return;
        }
        current.unsubscribeInvalidation?.();
        current.lease?.release();
        current.lease = lease;
        current.priority = priority;
        current.widthPx = widthPx;
        current.unsubscribeInvalidation = null;
        if (lease.onInvalidated) {
            current.unsubscribeInvalidation = lease.onInvalidated(() => {
                const invalidated = pageStates.get(pageNumber);
                if (invalidated !== current) {
                    return;
                }
                invalidated.unsubscribeInvalidation?.();
                invalidated.unsubscribeInvalidation = null;
                invalidated.lease = null;
                beginPagePresentationPending(pageNumber, invalidated);
                scheduleRender.schedule();
            });
        }
    } catch (error) {
        const current = pageStates.get(pageNumber);
        const isCurrentAttempt = renderControllers.get(pageNumber) === controller
            && source.value === activeSource
            && current?.generation === attemptGeneration;
        if (!isCurrentAttempt) {
            return;
        }
        if (current) {
            if (visualRetryState.recordFailure(pageNumber)) {
                beginPagePresentationPending(pageNumber, current);
                scheduleRender.schedule();
            } else {
                commitPageTerminalError(pageNumber);
                if (pageNumber === currentPage) {
                    emit('loadError', error);
                }
            }
        }
    } finally {
        if (renderControllers.get(pageNumber) === controller) {
            renderControllers.delete(pageNumber);
        }
    }
}

function isOwnedConnectedPageImage(image: HTMLImageElement, pageNumber: number) {
    const openingTarget = getChassisOpeningShellTarget(pageNumber);
    if (openingTarget) {
        return image.parentElement === openingTarget && openingTarget.isConnected;
    }
    const page = image.closest<HTMLElement>('[data-testid="document-page-source-page"]');
    return Boolean(page?.isConnected && page.dataset.pageNumber === String(pageNumber));
}

function waitForSurfacePaint(image: HTMLImageElement, signal: AbortSignal) {
    if (signal.aborted || !image.isConnected) {
        return Promise.resolve(false);
    }
    if (document.visibilityState !== 'visible') {
        return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
        let settled = false;
        let animationFrame: number | null = null;
        const finish = (painted: boolean) => {
            if (settled) {
                return;
            }
            settled = true;
            if (animationFrame !== null) cancelAnimationFrame(animationFrame);
            signal.removeEventListener('abort', handleAbort);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            resolve(painted);
        };
        const handleAbort = () => finish(false);
        const handleVisibilityChange = () => {
            if (document.visibilityState !== 'visible') finish(true);
        };
        signal.addEventListener('abort', handleAbort, {once: true});
        document.addEventListener('visibilitychange', handleVisibilityChange);
        animationFrame = requestAnimationFrame(() => finish(true));
    });
}

function getConnectedPageImage(pageNumber: number, state: IPageVisualState) {
    const openingTarget = getChassisOpeningShellTarget(pageNumber);
    const candidates = openingTarget
        ? openingTarget.querySelectorAll<HTMLImageElement>('[data-testid="document-page-source-image"]')
        : viewerContainer.value?.querySelectorAll<HTMLImageElement>('[data-testid="document-page-source-image"]');
    return [...(candidates ?? [])].find(image => (
        image.dataset.pageRenderGeneration === String(state.generation)
        && image.dataset.documentLoadGeneration === String(loadGeneration.value)
        && isOwnedConnectedPageImage(image, pageNumber)
        && image.complete
        && image.naturalWidth > 0
    )) ?? null;
}

function commitReadyPageToViewportSession(pageNumber: number, state: IPageVisualState) {
    const openSurface = chassisAuthority?.openSurface;
    const snapshot = openSurface?.snapshot.value;
    const viewportState = openSurface?.viewportSession.value;
    const surfaceGeneration = activeOpenSurfaceGeneration;
    const image = getConnectedPageImage(pageNumber, state);
    if (
        !state.ready
        || !image
        || pageStates.get(pageNumber) !== state
        || !openSurface
        || !snapshot
        || !viewportState
        || surfaceGeneration === null
        || snapshot.generation !== surfaceGeneration
        || viewportState.requestedPage !== pageNumber
        || viewportState.viewportIntent?.pageNumber !== pageNumber
        || ![
            'opening',
            'transitioning',
        ].includes(viewportState.lifecycle)
    ) {
        return false;
    }
    const fence = openSurface.createRenderFence({
        generation: surfaceGeneration,
        documentRevision: snapshot.identity?.documentRevision ?? '',
        renderVersion: loadGeneration.value,
        requestId: state.generation,
        pageNumber,
    });
    const viewport = viewerContainer.value;
    return Boolean(
        fence
        && openSurface.commitCanvas(fence)
        && viewport
        && openSurface.commitViewport({
            generation: surfaceGeneration,
            documentRevision: fence.documentRevision,
            viewportIntentId: viewportState.viewportIntent.id,
            documentGeometryRevision: loadGeneration.value,
            interactionEpoch: 0,
            pageNumber,
            left: viewport.scrollLeft,
            top: viewport.scrollTop,
        })
        && openSurface.markReady(fence),
    );
}

async function handleSurfaceLoad(pageNumber: number, surface: string, event: Event) {
    let state = pageStates.get(pageNumber);
    const image = event.currentTarget;
    const signal = loadController?.signal;
    const expectedLoadGeneration = loadGeneration.value;
    const expectedOpenSurfaceGeneration = activeOpenSurfaceGeneration;
    const expectedRenderGeneration = state?.generation ?? null;
    if (
        !(image instanceof HTMLImageElement)
        || !signal
        || state?.lease?.surface !== surface
        || image.dataset.pageRenderGeneration !== String(expectedRenderGeneration)
        || image.dataset.documentLoadGeneration !== String(expectedLoadGeneration)
        || image.dataset.openSurfaceGeneration !== String(expectedOpenSurfaceGeneration ?? '')
        || !isOwnedConnectedPageImage(image, pageNumber)
    ) {
        return;
    }
    if (!await waitForSurfacePaint(image, signal)) {
        return;
    }
    state = pageStates.get(pageNumber);
    if (
        signal.aborted
        || expectedLoadGeneration !== loadGeneration.value
        || expectedOpenSurfaceGeneration !== activeOpenSurfaceGeneration
        || state?.generation !== expectedRenderGeneration
        || state.lease?.surface !== surface
        || !image.isConnected
        || !isOwnedConnectedPageImage(image, pageNumber)
    ) {
        return;
    }
    state.ready = true;
    state.error = null;
    visualRetryState.markReady(pageNumber);
    const isInitialOpenTransition = chassisAuthority?.openSurface.viewportSession.value.lifecycle === 'opening';
    if (!commitReadyPageToViewportSession(pageNumber, state)) {
        return;
    }
    await nextTick();
    if (!await waitForSurfacePaint(image, signal)) {
        return;
    }
    if (isInitialOpenTransition) emit('initial-visual-ready', {pageNumber});
}

function handleSurfaceError(pageNumber: number, surface: string) {
    const state = pageStates.get(pageNumber);
    if (state?.lease?.surface !== surface) {
        return;
    }
    state.unsubscribeInvalidation?.();
    state.lease.release();
    state.unsubscribeInvalidation = null;
    state.lease = null;
    if (!visualRetryState.recordFailure(pageNumber)) {
        const message = commitPageTerminalError(pageNumber);
        if (pageNumber === currentPage) {
            emit('loadError', new Error(message));
        }
        return;
    }
    beginPagePresentationPending(pageNumber, state);
    void renderPage(pageNumber);
}
async function renderMountedPages() {
    await nextTick();
    const pagesByViewportPriority = [...mountedPages.value]
        .sort((left, right) => Math.abs(left - currentPage) - Math.abs(right - currentPage));
    await Promise.all(pagesByViewportPriority.map(renderPage));
}
const scheduleRender = createRafCoalescedCallback(() => void renderMountedPages());

function handleScroll() {
    if (!continuousScroll || !viewerContainer.value) {
        return;
    }
    if (chassisAuthority?.viewportWritePort.consumeAuthorityScroll(viewerContainer.value)) {
        return;
    }
    if (
        chassisAuthority
        && !shouldProjectDocumentViewportScroll(
            chassisAuthority.openSurface.snapshot.value,
            chassisAuthority.openSurface.viewportSession.value,
        )
    ) {
        return;
    }
    chassisAuthority?.viewportWritePort.observeUserScroll(viewerContainer.value);
    const viewportMiddle = viewerContainer.value.scrollTop + viewerContainer.value.clientHeight / 2;
    let nearestPage = 1;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let page = 1; page <= pageMetrics.value.length; page += 1) {
        const middle = (pageTops.value[page - 1] ?? 0) + (pageHeights.value[page - 1] ?? 0) / 2;
        const distance = Math.abs(middle - viewportMiddle);
        if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestPage = page;
        }
    }
    if (nearestPage !== currentPage) {
        emit('update:currentPage', nearestPage);
    }
}
function handleWheel(event: WheelEvent) {
    if (!event.ctrlKey && !event.metaKey) {
        if (continuousScroll || Math.abs(event.deltaY) < Math.abs(event.deltaX) || event.deltaY === 0) {
            return;
        }
        const container = viewerContainer.value;
        const layout = pageLayouts.value[currentPage - 1];
        if (!container || !layout) {
            return;
        }
        const direction = resolveWheelDirection(event.deltaY);
        const bounds = {
            min: 0,
            max: Math.max(0, layout.height + 32 - container.clientHeight),
        };
        if (canScrollWithinPageBounds(container, bounds, direction)) {
            wheelFlipGate.recordInteriorScroll();
            return;
        }
        event.preventDefault();
        const now = performance.now();
        if (wheelFlipGate.shouldBlockFlip(direction, now, {
            delta: event.deltaY,
            requireGestureIdle: true,
        })) {
            return;
        }
        const target = resolveWheelTargetPage(currentPage, viewMode, source.value?.pageCount ?? 0, direction);
        wheelFlipGate.recordFlip(direction, now, event.deltaY);
        if (target !== currentPage) scrollToPage(target);
        return;
    }
    event.preventDefault();
    emit('update:zoomMode', 'custom');
    emit('update:zoom', clampDocumentManualZoom(effectiveZoom.value * Math.exp(-event.deltaY * 0.0016)));
}
function scrollToPage(pageNumber: number) {
    const normalized = chassisAuthority?.navigate(pageNumber)
        ?? Math.max(1, Math.min(source.value?.pageCount ?? 1, Math.trunc(pageNumber)));
    emit('update:currentPage', normalized);
    const intent = chassisAuthority?.viewportWritePort.beginIntent(
        `page-source-navigation:${String(normalized)}:${String(loadGeneration.value)}`,
    );
    const activeSource = source.value;
    const signal = loadController?.signal;
    if (activeSource && signal && !exactPageMetricNumbers.has(normalized)) {
        void ensureExactPageMetric(
            activeSource,
            loadGeneration.value,
            normalized,
            signal,
        ).then(() => scheduleRender.schedule()).catch((error: unknown) => {
            if (!(error instanceof DOMException && error.name === 'AbortError')) {
                const message = commitPageTerminalError(normalized);
                if (normalized === currentPage) {
                    emit('loadError', error instanceof Error ? error : new Error(message));
                }
            }
        });
    }
    void nextTick(() => {
        if (viewerContainer.value) {
            if (!intent) {
                return;
            }
            chassisAuthority?.viewportWritePort.apply(viewerContainer.value, {
                intent,
                reason: 'source-neutral-page-navigation',
                top: continuousScroll
                    ? Math.max(
                        0,
                        (pageTops.value[normalized - 1] ?? DOCUMENT_SOURCE_PAGE_MARGIN)
                            - DOCUMENT_SOURCE_PAGE_MARGIN,
                    )
                    : 0,
            });
        }
        scheduleRender.schedule();
    });
}
function releasePageState(pageNumber: number) {
    renderControllers.get(pageNumber)?.abort();
    renderControllers.delete(pageNumber);
    const state = pageStates.get(pageNumber);
    state?.unsubscribeInvalidation?.();
    state?.lease?.release();
    pageStates.delete(pageNumber);
    visualRetryState.releasePage(pageNumber);
}

async function commitInitialPageShell(
    pageNumber: number,
    generation: number,
    surfaceGeneration = chassisAuthority?.openSurface.snapshot.value.generation ?? null,
) {
    measureViewport();
    if (
        generation !== loadGeneration.value
        || surfaceGeneration === null
        || !chassisAuthority
        || chassisAuthority.openSurface.snapshot.value.generation !== surfaceGeneration
    ) {
        return false;
    }
    const metric = pageMetrics.value[pageNumber - 1];
    const viewport = viewerContainer.value;
    const activeSource = source.value;
    if (!metric || !viewport || !activeSource) {
        return false;
    }
    const surface = chassisAuthority.openSurface;
    let snapshot = surface.snapshot.value;
    if (snapshot.openingPageGeometry === null && !surface.commitOpeningPageGeometry(surfaceGeneration, {
        documentId: snapshot.identity?.documentId ?? String(src),
        pageNumber,
        pageCount: activeSource.pageCount,
        width: metric.widthPoints,
        height: metric.heightPoints,
        rotation: metric.rotation,
    })) {
        return false;
    }
    snapshot = surface.snapshot.value;
    const frameGeometry = snapshot.openingPageGeometry;
    const resolvedFrame = frameGeometry && resolveDocumentPageSourceOpeningFrame({
        geometry: frameGeometry,
        viewportWidth: viewport.clientWidth,
        viewportHeight: viewport.clientHeight,
        zoom,
        zoomMode,
    });
    if (!resolvedFrame) {
        return false;
    }
    const existingFrame = snapshot.openingPageFrame;
    const frameCommitted = existingFrame !== null
        ? existingFrame.generation === surfaceGeneration && existingFrame.pageNumber === pageNumber
        : surface.commitOpeningPageFrame(surfaceGeneration, {
            generation: surfaceGeneration,
            ownerId: openingPageFrameOwnerId,
            pageNumber,
            intentKey: `page-source:${zoomMode}:${String(zoom)}:${String(continuousScroll)}`,
            style: resolvedFrame.style,
        });
    if (!frameCommitted) {
        return false;
    }
    await nextTick();
    const target = getChassisOpeningShellTarget(pageNumber);
    const rect = target?.getBoundingClientRect();
    if (!target || !rect || rect.width <= 0 || rect.height <= 0) {
        return false;
    }
    return surface.commitGeometry(surfaceGeneration, {
        width: rect.width,
        height: rect.height,
        margin: DOCUMENT_SOURCE_PAGE_MARGIN,
    });
}

function seedOpeningPageMetrics() {
    const geometry = chassisAuthority?.openSurface.snapshot.value.openingPageGeometry;
    if (!geometry) {
        return false;
    }
    pageMetrics.value = createProvisionalDocumentPageMetrics(geometry.pageCount, {
        widthPoints: geometry.width,
        heightPoints: geometry.height,
        rotation: geometry.rotation as IDocumentPageMetrics['rotation'],
    });
    return true;
}

function seedColdOpenProvisionalPageMetrics() {
    const requestedPage = Math.max(1, Math.trunc(
        chassisAuthority?.currentPage.value ?? currentPage,
    ));
    pageMetrics.value = createColdOpenProvisionalDocumentPageMetrics(requestedPage);
}

watch(
    () => chassisAuthority?.openSurface.snapshot.value.openingPageGeometry ?? null,
    (geometry) => {
        if (!geometry) {
            return;
        }
        if (!source.value) {
            seedOpeningPageMetrics();
        }
        void commitInitialPageShell(
            geometry.pageNumber,
            loadGeneration.value,
            chassisAuthority?.openSurface.snapshot.value.generation ?? null,
        );
    },
    {immediate: true},
);

watch(() => src, (documentRef, previousDocumentRef) => {
    if (previousDocumentRef && previousDocumentRef !== documentRef) {
        supersedeActiveOpenSurfaceGeneration();
    }
    const generation = ++loadGeneration.value;
    activeOpenSurfaceRevision = documentRef
        ? String(documentRevisionToken ?? `page-source:${String(generation)}`)
        : null;
    activeOpenSurfaceGeneration = documentRef && chassisAuthority
        ? chassisAuthority.openSurface.claim({
            documentId: chassisAuthority.openSurface.snapshot.value.identity?.documentId
                ?? String(documentRef),
            documentRevision: activeOpenSurfaceRevision ?? '',
        })
        : null;
    loadController?.abort();
    const activeLoadController = new AbortController();
    loadController = activeLoadController;
    renderControllers.forEach(controller => controller.abort());
    renderControllers.clear();
    exactPageMetricNumbers.clear();
    exactPageMetricLoads.clear();
    visualRetryState.beginSourceGeneration();
    const previousSource = source.value;
    previousSource?.dispose();
    if (chassisAuthority?.source.value === previousSource) {
        chassisAuthority.bindSource(null);
    }
    source.value = null;
    if (!seedOpeningPageMetrics()) {
        if (documentRef) {
            seedColdOpenProvisionalPageMetrics();
        } else {
            pageMetrics.value = [];
        }
    }
    pageStates.forEach((state) => {
        state.unsubscribeInvalidation?.();
        state.lease?.release();
    });
    pageStates.clear();
    deferredMetricHydration = null;
    emit('loading', Boolean(documentRef));
    if (!documentRef) {
        emit('update:totalPages', 0);
        return;
    }
    emit('initial-visual-pending');
    loadSettled = (async () => {
        try {
            const preview = await createDjvuPagePreviewSourceFromPath(documentRef);
            const requestedInitialPage = Math.max(1, Math.trunc(
                chassisAuthority?.currentPage.value ?? currentPage,
            ));
            const nextSource = await createDjvuPageSource(
                documentRef,
                preview,
                surfaceBudget,
                {initialPageNumber: requestedInitialPage},
            );
            if (generation !== loadGeneration.value) {
                nextSource.dispose();
                return;
            }
            source.value = nextSource;
            chassisAuthority?.bindSource(nextSource);
            emit('update:sourceCapabilities', {
                annotations: Boolean(nextSource.annotationProvider),
                directImageExport: Boolean(nextSource.rasterProvider),
                outline: Boolean(nextSource.outlineProvider),
                pageEdits: false,
                search: Boolean(nextSource.textProvider),
                text: Boolean(nextSource.textProvider),
            });
            const initialPage = Math.max(1, Math.min(
                nextSource.pageCount,
                Math.trunc(chassisAuthority?.currentPage.value ?? currentPage),
            ));
            const initialMetric = await loadInitialDocumentPageMetric(
                nextSource,
                initialPage,
                activeLoadController.signal,
            );
            if (generation !== loadGeneration.value) {
                return;
            }
            pageMetrics.value = createProvisionalDocumentPageMetrics(
                nextSource.pageCount,
                initialMetric,
            );
            exactPageMetricNumbers.add(initialPage);
            emit('update:totalPages', nextSource.pageCount);
            emit('loading', false);
            scrollToPage(initialPage);
            deferredMetricHydration = async () => {
                try {
                    const metrics = await hydrateRemainingDocumentPageMetrics({
                        source: nextSource,
                        initialPage,
                        initialMetric,
                        signal: activeLoadController.signal,
                        isCurrent: () => (
                            generation === loadGeneration.value
                            && source.value === nextSource
                            && !activeLoadController.signal.aborted
                        ),
                        getPriorityPage: () => Math.max(1, Math.min(
                            nextSource.pageCount,
                            Math.trunc(chassisAuthority?.currentPage.value ?? currentPage),
                        )),
                        loadMetric: (pageNumber, signal) => ensureExactPageMetric(
                            nextSource,
                            generation,
                            pageNumber,
                            signal,
                        ),
                        onMetric: () => scheduleRender.schedule(),
                    });
                    if (!metrics) {
                        return;
                    }
                    pageMetrics.value = metrics;
                    scheduleRender.schedule();
                } catch (error) {
                    if (!(error instanceof DOMException && error.name === 'AbortError')) {
                        emit('loadError', error);
                    }
                }
            };
            if (!await commitInitialPageShell(initialPage, generation, activeOpenSurfaceGeneration)) {
                throw new Error('Unable to commit the initial document page shell');
            }
            await renderPage(initialPage);
            const hydrateMetrics = deferredMetricHydration;
            deferredMetricHydration = null;
            void hydrateMetrics?.();
        } catch (error) {
            if (!(error instanceof DOMException && error.name === 'AbortError')) {
                emit('loading', false);
                commitPageTerminalError(Math.max(1, Math.trunc(
                    chassisAuthority?.currentPage.value ?? currentPage,
                )));
                emit('loadError', error);
            }
        }
    })();
}, {immediate: true});
watch(
    () => [
        chassisAuthority?.openSurface.snapshot.value.generation ?? null,
        chassisAuthority?.openSurface.snapshot.value.identity?.documentId ?? null,
        chassisAuthority?.openSurface.snapshot.value.identity?.documentRevision ?? null,
        src,
    ] as const,
    ([
        generation,
        documentId,
        documentRevision,
        documentRef,
    ]) => {
        if (
            generation === null
            || !documentRef
            || documentId !== String(documentRef)
            || documentRevision !== activeOpenSurfaceRevision
            || chassisAuthority?.openSurface.snapshot.value.openingPageFrame === null
        ) {
            return;
        }
        activeOpenSurfaceGeneration = generation;
    },
    {flush: 'sync'},
);
watch(effectiveZoom, (value) => {
    emit('update:effectiveZoom', value);
    scheduleRender.schedule();
});
watch(pageLayouts, async (layouts, previousLayouts) => {
    const container = viewerContainer.value;
    const openSurface = chassisAuthority?.openSurface;
    const surfaceGeneration = openSurface?.snapshot.value.generation ?? null;
    if (
        !container
        || layouts.length === 0
        || previousLayouts.length !== layouts.length
        || openSurface && !shouldProjectDocumentViewportScroll(
            openSurface.snapshot.value,
            openSurface.viewportSession.value,
        )
    ) {
        return;
    }
    const anchor = captureDocumentZoomAnchor(container, previousLayouts);
    await nextTick();
    if (
        openSurface
        && (
            openSurface.snapshot.value.generation !== surfaceGeneration
            || !shouldProjectDocumentViewportScroll(
                openSurface.snapshot.value,
                openSurface.viewportSession.value,
            )
        )
    ) {
        return;
    }
    const restored = resolveDocumentZoomAnchorScroll(container, layouts, anchor);
    if (restored) {
        viewportWritePort.apply(container, {
            intent: viewportWritePort.beginIntent(`page-source-zoom-anchor:${String(loadGeneration.value)}`),
            reason: 'zoom-anchor-restoration',
            ...restored,
        });
    }
}, {flush: 'post'});
watch(mountedPages, (pages) => {
    const retainedPages = new Set(pages);
    for (const pageNumber of pageStates.keys()) {
        if (!retainedPages.has(pageNumber)) {
            releasePageState(pageNumber);
        }
    }
    scheduleRender.schedule();
});

onBeforeUnmount(() => {
    supersedeActiveOpenSurfaceGeneration();
    releaseViewportFeature?.();
    scheduleRender.cancel();
    renderSession?.dispose();
    if (chassisOpeningSlotPage !== null) {
        pageSlots?.markUnmounted(chassisOpeningSlotPage);
        chassisOpeningSlotPage = null;
    }
    loadController?.abort();
    renderControllers.forEach(controller => controller.abort());
    renderControllers.clear();
    const activeSource = source.value;
    activeSource?.dispose();
    if (chassisAuthority?.source.value === activeSource) {
        chassisAuthority.bindSource(null);
    }
    pageStates.forEach((state) => {
        state.unsubscribeInvalidation?.();
        state.lease?.release();
    });
});

defineExpose<IDocumentViewerExpose & {
    captureScrollSnapshot: () => unknown;
    restoreScrollSnapshot: (snapshot: unknown, options: {fallbackPage: number}) => void;
}>({
    getViewerContainer: () => viewerContainer.value,
    getCurrentPage: () => currentPage,
    waitForViewerLoadSettled: () => loadSettled,
    scrollToPage,
    invalidatePages: pages => pages.forEach(page => void renderPage(page)),
    requestScrollToCurrentResult: () => scrollToPage(currentPage),
    captureScrollSnapshot: () => ({page: chassisAuthority?.currentPage.value ?? currentPage}),
    restoreScrollSnapshot: (snapshot, options) => {
        const page = typeof snapshot === 'object' && snapshot !== null && 'page' in snapshot
            ? Number(snapshot.page)
            : options.fallbackPage;
        scrollToPage(Number.isFinite(page) ? page : options.fallbackPage);
    },
});
</script>

<style scoped>
.document-source-feature-pack {
    position: relative;
    min-width: 100%;
    min-height: 100%;
}

.document-source-viewer {
    background: var(--ui-bg-muted);
}

.document-source-viewer__surface {
    position: relative;
    min-width: 100%;
}

.document-source-viewer__page {
    position: absolute;
    overflow: hidden;
    background: var(--app-pdf-page-bg);
    box-shadow: var(--app-pdf-page-shadow);
    border-radius: var(--app-pdf-page-radius);
}

.document-source-viewer__image {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: fill;
    visibility: hidden;
}

.document-source-viewer__image--committed {
    visibility: visible;
}

.document-source-viewer__pending-frame {
    position: absolute;
    z-index: var(--app-z-local-overlay);
    inset: 0;
    background: var(--app-pdf-page-bg);
    border-radius: inherit;
}

.document-source-viewer__skeleton {
    position: absolute;
    inset: 0;
    background: var(--app-pdf-page-bg);
    box-shadow: none;
    border-radius: inherit;
}

.document-source-viewer__error {
    position: absolute;
    z-index: var(--app-z-local-overlay);
    inset: 0;
    display: grid;
    place-items: center;
    padding: var(--app-document-page-error-padding);
    color: var(--ui-error);
    text-align: center;
    background: var(--app-pdf-page-bg);
    border-radius: inherit;
}

.document-source-viewer__annotation {
    position: absolute;
    z-index: var(--app-z-local-overlay);
    background: color-mix(in srgb, currentcolor 18%, transparent);
    border: 2px solid;
    border-radius: var(--app-document-source-badge-radius);
}
</style>
