<template>
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
        data-document-feature-pack="page-source"
        data-testid="document-page-source-viewer"
    >
                <section
                v-for="pageNumber in mountedPages"
                :key="pageNumber"
                :ref="element => setPageElement(pageNumber, element)"
                class="document-source-viewer__page"
                :style="getPageStyle(pageNumber)"
                :data-page-number="pageNumber"
                data-testid="document-page-source-page"
            >
                <div
                    v-if="getVisual(pageNumber) === 'none' || getVisual(pageNumber) === 'skeleton'"
                    class="document-source-viewer__skeleton"
                />
                <img
                    v-if="getSurface(pageNumber)"
                    :src="getSurface(pageNumber)!"
                    class="document-source-viewer__image"
                    :class="{'document-source-viewer__image--stale': getVisual(pageNumber) === 'stale'}"
                    alt=""
                    draggable="false"
                    data-testid="document-page-source-image"
                >
                <button
                    v-for="annotation in getAnnotations(pageNumber)"
                    :key="annotation.id"
                    type="button"
                    class="document-source-viewer__annotation"
                    :style="getAnnotationStyle(annotation)"
                    :aria-label="String(annotation.payload.label ?? 'Annotation')"
                />
                </section>
    </div>
</template>

<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import { useResizeObserver } from '@vueuse/core';
import type { TDocumentRef } from '@contracts/documentRef';
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
} from '@app/utils/document-viewer/source/documentPageSource';
import { createRafCoalescedCallback } from '@app/utils/createRafCoalescedCallback';
import { workspaceSurfaceBudgetController } from '@app/modules/workspace-shell/memory/workspaceSurfaceBudgetController';
import { injectDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import { createDocumentViewportWritePort } from '@app/utils/document-viewer/chassis/documentViewportWritePort';
import { createWheelFlipGate } from '@app/utils/document-viewer/single-page-wheel/createWheelFlipGate';
import {
    canScrollWithinPageBounds,
    resolveWheelDirection,
    resolveWheelTargetPage,
} from '@app/utils/document-viewer/single-page-wheel/singlePageWheelNavigation';
import {
    clampDocumentFitScale,
    clampDocumentManualZoom,
} from '@app/utils/document-viewer/zoomPolicy';
import {
    captureDocumentZoomAnchor,
    resolveDocumentZoomAnchorScroll,
} from '@app/utils/document-viewer/zoomAnchor';

type TVisual = 'none' | 'skeleton' | 'stale' | 'fresh';
interface IPageVisualState {
    generation: number;
    visual: TVisual;
    lease: IDocumentSurfaceLease | null;
}

let nextSourcePageSlotOwnerId = 0;

const {
    src,
    zoom = 1,
    zoomMode = 'fit-width',
    viewMode = 'single',
    continuousScroll = true,
    isActive = true,
    currentPage = 1,
    showSidebar = false,
} = defineProps<{
    src: TDocumentRef | null;
    zoom?: number;
    zoomMode?: 'custom' | 'fit-width' | 'fit-height';
    viewMode?: TPdfViewMode;
    continuousScroll?: boolean;
    isActive?: boolean;
    currentPage?: number;
    showSidebar?: boolean;
}>();
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
const pageSlots = renderSession?.pageSlots;
const surfaceBudget = chassisAuthority?.surfaceBudget ?? workspaceSurfaceBudgetController;
const source = shallowRef<IDocumentPageSource | null>(null);
const pageMetrics = shallowRef<IDocumentPageMetrics[]>([]);
const pageStates = shallowReactive(new Map<number, IPageVisualState>());
const renderControllers = new Map<number, AbortController>();
const loadGeneration = ref(0);
const annotationRevision = ref(0);
let loadSettled = Promise.resolve();
let loadController: AbortController | null = null;
let releaseViewportFeature: (() => void) | null = null;

onMounted(() => {
    viewerContainer.value = chassisAuthority?.viewportElement.value ?? null;
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
    let top = 16;
    return pageHeights.value.map((height) => {
        const value = top;
        top += height + 16;
        return value;
    });
});
const totalHeight = computed(() => (pageTops.value.at(-1) ?? 0) + (pageHeights.value.at(-1) ?? 0) + 16);
const pageLayouts = computed(() => pageMetrics.value.map((metric, index) => ({
    top: continuousScroll ? pageTops.value[index] ?? 16 : 16,
    width: metric.widthPoints * effectiveZoom.value,
    height: metric.heightPoints * effectiveZoom.value,
})));
const mountedPages = computed(() => {
    const pageCount = source.value?.pageCount ?? 0;
    if (pageCount === 0) {
        return [];
    }
    return renderSession?.resolveMountedPages({
        currentPage,
        pageCount,
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
        top: continuousScroll ? `${pageTops.value[pageNumber - 1] ?? 0}px` : '16px',
        left: `max(16px, calc(50% - ${width / 2}px))`,
        display: !continuousScroll && pageNumber !== currentPage ? 'none' : undefined,
    };
}
function getVisual(pageNumber: number) {
    return pageStates.get(pageNumber)?.visual ?? 'none';
}
function getSurface(pageNumber: number) {
    const surface = pageStates.get(pageNumber)?.lease?.surface;
    return typeof surface === 'string' ? surface : null;
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

async function renderPage(pageNumber: number) {
    const activeSource = source.value;
    const metric = pageMetrics.value[pageNumber - 1];
    if (!activeSource || !metric || !isActive) {
        return;
    }
    const previous = pageStates.get(pageNumber);
    renderControllers.get(pageNumber)?.abort();
    const controller = new AbortController();
    renderControllers.set(pageNumber, controller);
    let attemptGeneration: number | null = null;
    try {
        const renderOutcome = await renderSession?.runPageRender(
            pageNumber,
            Boolean(previous?.lease),
            async (generation) => {
                attemptGeneration = generation;
                pageStates.set(pageNumber, {
                    generation,
                    visual: renderSession.getPageVisual(pageNumber),
                    lease: previous?.lease ?? null,
                });
                await nextTick();
                return activeSource.renderPage({
                    pageNumber,
                    widthPx: Math.max(1, Math.round(
                        metric.widthPoints * effectiveZoom.value * (window.devicePixelRatio || 1),
                    )),
                    priority: pageNumber === currentPage ? 'navigation' : 'nearby',
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
        current.lease?.release();
        pageStates.set(pageNumber, {
            generation,
            visual: 'fresh',
            lease,
        });
        if (pageNumber === currentPage) {
            emit('initial-visual-ready', {pageNumber});
        }
    } catch (error) {
        const current = pageStates.get(pageNumber);
        const isCurrentAttempt = renderControllers.get(pageNumber) === controller
            && source.value === activeSource
            && current?.generation === attemptGeneration;
        if (!isCurrentAttempt) {
            return;
        }
        if (current?.lease) {
            current.visual = 'stale';
        } else if (pageNumber === currentPage) {
            emit('loadError', error);
        }
    } finally {
        if (renderControllers.get(pageNumber) === controller) {
            renderControllers.delete(pageNumber);
        }
    }
}
async function renderMountedPages() {
    await nextTick();
    await Promise.all(mountedPages.value.map(renderPage));
}
const scheduleRender = createRafCoalescedCallback(() => void renderMountedPages());

function handleScroll() {
    if (!continuousScroll || !viewerContainer.value) {
        return;
    }
    if (chassisAuthority?.viewportWritePort.consumeAuthorityScroll(viewerContainer.value)) {
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
    void nextTick(() => {
        if (viewerContainer.value) {
            if (!intent) {
                return;
            }
            chassisAuthority?.viewportWritePort.apply(viewerContainer.value, {
                intent,
                reason: 'source-neutral-page-navigation',
                top: continuousScroll ? pageTops.value[normalized - 1] ?? 0 : 0,
            });
        }
        scheduleRender.schedule();
    });
}
function releasePageState(pageNumber: number) {
    renderControllers.get(pageNumber)?.abort();
    renderControllers.delete(pageNumber);
    pageStates.get(pageNumber)?.lease?.release();
    pageStates.delete(pageNumber);
}

async function loadPageMetrics(activeSource: IDocumentPageSource, signal: AbortSignal) {
    const metrics = Array.from<IDocumentPageMetrics>({length: activeSource.pageCount});
    let nextPage = 1;
    const workers = Array.from({length: Math.min(activeSource.pageCount, 8)}, async () => {
        while (nextPage <= activeSource.pageCount) {
            signal.throwIfAborted();
            const pageNumber = nextPage++;
            metrics[pageNumber - 1] = await activeSource.getPageMetrics(pageNumber, signal);
        }
    });
    await Promise.all(workers);
    return metrics;
}

watch(() => src, (documentRef) => {
    const generation = ++loadGeneration.value;
    loadController?.abort();
    const activeLoadController = new AbortController();
    loadController = activeLoadController;
    renderControllers.forEach(controller => controller.abort());
    renderControllers.clear();
    const previousSource = source.value;
    previousSource?.dispose();
    if (chassisAuthority?.source.value === previousSource) {
        chassisAuthority.bindSource(null);
    }
    source.value = null;
    pageMetrics.value = [];
    pageStates.forEach(state => state.lease?.release());
    pageStates.clear();
    emit('loading', Boolean(documentRef));
    if (!documentRef) {
        emit('update:totalPages', 0);
        return;
    }
    emit('initial-visual-pending');
    loadSettled = (async () => {
        try {
            const preview = await createDjvuPagePreviewSourceFromPath(documentRef);
            const nextSource = await createDjvuPageSource(
                documentRef,
                preview,
                surfaceBudget,
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
            pageMetrics.value = await loadPageMetrics(nextSource, activeLoadController.signal);
            if (generation !== loadGeneration.value) {
                return;
            }
            emit('update:totalPages', nextSource.pageCount);
            emit('loading', false);
            scrollToPage(chassisAuthority?.currentPage.value ?? currentPage);
            await renderMountedPages();
        } catch (error) {
            if (!(error instanceof DOMException && error.name === 'AbortError')) {
                emit('loading', false);
                emit('loadError', error);
            }
        }
    })();
}, {immediate: true});
watch(effectiveZoom, (value) => {
    emit('update:effectiveZoom', value);
    scheduleRender.schedule();
});
watch(pageLayouts, async (layouts, previousLayouts) => {
    const container = viewerContainer.value;
    if (!container || layouts.length === 0 || previousLayouts.length !== layouts.length) {
        return;
    }
    const anchor = captureDocumentZoomAnchor(container, previousLayouts);
    await nextTick();
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
    releaseViewportFeature?.();
    scheduleRender.cancel();
    renderSession?.dispose();
    loadController?.abort();
    renderControllers.forEach(controller => controller.abort());
    renderControllers.clear();
    const activeSource = source.value;
    activeSource?.dispose();
    if (chassisAuthority?.source.value === activeSource) {
        chassisAuthority.bindSource(null);
    }
    pageStates.forEach(state => state.lease?.release());
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
    background: var(--ui-bg);
    box-shadow: var(--shadow-popup);
}

.document-source-viewer__image {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: fill;
}
.document-source-viewer__image--stale { image-rendering: auto; }

.document-source-viewer__skeleton {
    position: absolute;
    inset: 0;
    background: var(--ui-bg-elevated);
}

.document-source-viewer__annotation {
    position: absolute;
    z-index: var(--app-z-local-overlay);
    background: color-mix(in srgb, currentcolor 18%, transparent);
    border: 2px solid;
    border-radius: var(--app-document-source-badge-radius);
}
</style>
