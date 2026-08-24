import { useResizeObserver } from '@vueuse/core';
import type { IDocumentViewerExpose } from '@app/modules/pdf-viewer/public';
import type {
    IDocumentPageMetrics,
    IDocumentPageSource,
} from '@app/utils/document-viewer/source/documentPageSource';
import { createRafCoalescedCallback } from '@app/utils/createRafCoalescedCallback';
import { workspaceSurfaceBudgetController } from '@app/modules/workspace-shell/memory/workspaceSurfaceBudgetController';
import type { TWorkspaceResourcePressureLevel } from '@app/modules/workspace-shell/memory/workspaceSurfaceBudgetController';
import { injectDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import { shouldProjectDocumentViewportScroll } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import { createDocumentViewportWritePort } from '@app/utils/document-viewer/chassis/documentViewportWritePort';
import {
    createColdOpenProvisionalDocumentPageMetrics,
    createProvisionalDocumentPageMetrics,
    loadInitialDocumentPageMetric,
} from '@app/modules/workspace-shell/viewers/loadPrioritizedDocumentPageMetrics';
import { clampDocumentManualZoom } from '@app/utils/document-viewer/zoomPolicy';
import { resolveDocumentPageDisplayLayouts } from '@app/utils/document-viewer/layout/resolveDocumentPageDisplayLayout';
import {
    resolveNearestDocumentPageToViewportCenter,
    resolveDocumentContinuousScrollWindow,
} from '@app/utils/document-viewer/viewport/resolveDocumentContinuousScrollWindow';
import { DOCUMENT_PAGE_GUTTER_PX } from '@app/utils/document-viewer/layout/documentPageGutterPx';
import { resolveDocumentPageSourceRenderDemand } from '@app/modules/workspace-shell/viewers/resolveDocumentPageSourceRenderDemand';
import { resolveDocumentPageSourceRenderQueue } from '@app/modules/workspace-shell/viewers/resolveDocumentPageSourceRenderQueue';
import {
    createDocumentPageSourcePresentation,
    resolveDocumentPageSourceRenderWidthPx,
} from '@app/modules/workspace-shell/viewers/documentPageSourcePresentation';
import { useDocumentViewportLayoutLifecycle } from '@app/utils/document-viewer/lifecycle/useDocumentViewportLayoutLifecycle';
import { createPageSourcePagedWheelNavigation } from '@app/modules/workspace-shell/viewers/createPageSourcePagedWheelNavigation';
import { createDocumentPageMetricPublication } from '@app/modules/workspace-shell/viewers/createDocumentPageMetricPublication';
import {
    createDocumentWheelZoomHandler,
    type IDocumentWheelInteraction,
} from '@app/utils/document-viewer/input/documentWheelInteraction';
import { useDocumentWheelZoomSessionBoundaries } from '@app/utils/document-viewer/input/useDocumentWheelZoomSessionBoundaries';
import { getPerformanceProfile } from '@app/utils/performanceProfile';
import { resolveOpenPathSecondaryPerformancePolicy } from '@app/utils/openPathSecondaryPerformancePolicy';
import {
    createDocumentPageSourceLifecycle,
    type IDocumentPageSourceTransition,
    openDocumentPageSource,
    type IDocumentPageSourceFeaturePackEmit,
    type TDocumentPageElement,
    type TDocumentPageSourceRuntimeProps,
} from '@app/modules/workspace-shell/viewers/documentPageSourceFeaturePackState';
const DOCUMENT_SOURCE_CONTINUOUS_MOUNT_RADIUS = 12;
const DOCUMENT_SOURCE_MAX_MOUNTED_PAGES = 40;
const DOCUMENT_SOURCE_MAX_RESIDENT_PAGES = 5;
const DOCUMENT_SOURCE_RENDER_CONCURRENCY = 2;
export const DOCUMENT_SOURCE_INACTIVE_LEASE_GRACE_MS = 1_500;
export function shouldRetainInactiveDocumentPageSourceLease(
    retainWarmLease: boolean,
    pressureLevel: TWorkspaceResourcePressureLevel,
) {
    return retainWarmLease && [
        'healthy',
        'guarded',
    ].includes(pressureLevel);
}
export const useDocumentPageSourceRuntime = (options: {
    emit: IDocumentPageSourceFeaturePackEmit;
    readProps: () => TDocumentPageSourceRuntimeProps;
}) => {
    let nextSourcePageSlotOwnerId = 0;
    const emit = options.emit;
    const props = computed(options.readProps);
    const viewerContainer = shallowRef<HTMLElement | null>(null);
    const containerWidth = ref(0);
    const containerHeight = ref(0);
    const viewportScrollTop = ref(0);
    const viewportScrollDirection = ref<-1 | 0 | 1>(0);
    const pagedWheelNavigation = createPageSourcePagedWheelNavigation(DOCUMENT_PAGE_GUTTER_PX);
    const chassisAuthority = injectDocumentViewerChassisAuthority();
    const openSurfaceRenderOwner = chassisAuthority?.openSurface.claimRenderOwner();
    const viewportWritePort = chassisAuthority?.viewportWritePort ?? createDocumentViewportWritePort();
    const renderSession = chassisAuthority?.renderCoordinator.createSession(
        `page-source-feature:${String(++nextSourcePageSlotOwnerId)}`,
    );
    const openingPageFrameOwnerId = `page-source:${String(nextSourcePageSlotOwnerId)}`;
    const pageSlots = renderSession?.pageSlots;
    const surfaceBudget = chassisAuthority?.surfaceBudget ?? workspaceSurfaceBudgetController;
    const rasterBufferProfile = getPerformanceProfile();
    const source = shallowRef<IDocumentPageSource | null>(null);
    const pageMetrics = shallowRef<IDocumentPageMetrics[]>([]);
    const exactPageMetricNumbers = new Set<number>();
    const exactPageMetricLoads = new Map<number, Promise<IDocumentPageMetrics>>();
    let loadSettled = Promise.resolve();
    let loadController: AbortController | null = null;
    let releaseViewportFeature: (() => void) | null = null;
    let inactiveLeaseReleaseTimer: ReturnType<typeof setTimeout> | null = null;
    function measureViewport() {
        containerWidth.value = viewerContainer.value?.clientWidth ?? 0;
        containerHeight.value = viewerContainer.value?.clientHeight ?? 0;
        viewportScrollTop.value = viewerContainer.value?.scrollTop ?? 0;
    }
    useResizeObserver(viewerContainer, measureViewport);
    const pageDisplayLayouts = computed(() => resolveDocumentPageDisplayLayouts({
        availableHeight: Math.max(1, containerHeight.value - DOCUMENT_PAGE_GUTTER_PX * 2),
        availableWidth: Math.max(1, containerWidth.value - DOCUMENT_PAGE_GUTTER_PX * 2),
        manualZoom: clampDocumentManualZoom(props.value.zoom),
        pageSizes: pageMetrics.value.map(metric => ({
            height: metric.heightPoints,
            width: metric.widthPoints,
        })),
        zoomMode: props.value.zoomMode,
    }));
    const effectiveZoom = computed(() => (
        pageDisplayLayouts.value[props.value.currentPage - 1]?.scale
        ?? clampDocumentManualZoom(props.value.zoom)
    ));
    const handleWheelZoom = createDocumentWheelZoomHandler(
        effectiveZoom,
        computed(() => props.value.zoomMode),
        emit,
        {
            beforeZoom: (interaction, packetAt, startsNewSession) => layoutLifecycle.capturePointerAnchor(
                interaction.event,
                packetAt,
                startsNewSession,
            ),
            onNonZoom: () => layoutLifecycle.cancelPendingRestore(),
            readSessionKey: () => transitions.loadGeneration.value,
        },
    );
    const cancelWheelInteraction = useDocumentWheelZoomSessionBoundaries({
        isInteractionActive: computed(() => props.value.isInteractionActive),
        reset: () => { handleWheelZoom.reset(); layoutLifecycle.cancelPendingRestore(); },
    });
    const pageHeights = computed(() => pageDisplayLayouts.value.map(layout => layout.height));
    const pageTops = computed(() => {
        let top = DOCUMENT_PAGE_GUTTER_PX;
        return pageHeights.value.map((height) => {
            const value = top;
            top += height + DOCUMENT_PAGE_GUTTER_PX;
            return value;
        });
    });
    const totalHeight = computed(() => Math.max(
        containerHeight.value,
        (pageTops.value.at(-1) ?? DOCUMENT_PAGE_GUTTER_PX)
            + (pageHeights.value.at(-1) ?? 0)
            + DOCUMENT_PAGE_GUTTER_PX,
        (pageTops.value[props.value.currentPage - 1] ?? DOCUMENT_PAGE_GUTTER_PX)
            + (pageHeights.value[props.value.currentPage - 1] ?? 0)
            + DOCUMENT_PAGE_GUTTER_PX,
    ));
    const pageLayouts = computed(() => pageDisplayLayouts.value.map((layout, index) => ({
        top: props.value.continuousScroll
            ? pageTops.value[index] ?? DOCUMENT_PAGE_GUTTER_PX
            : DOCUMENT_PAGE_GUTTER_PX,
        width: layout.width,
        height: layout.height,
    })));
    const mountedPages = computed(() => {
        const pageCount = source.value?.pageCount
            ?? chassisAuthority?.openSurface.snapshot.value.openingPageGeometry?.pageCount
            ?? pageMetrics.value.length;
        const viewportPages = props.value.continuousScroll
            ? resolveDocumentContinuousScrollWindow({
                currentPage: props.value.currentPage,
                geometry: {
                    pageHeights: pageHeights.value,
                    pageTops: pageTops.value,
                    totalHeight: totalHeight.value,
                },
                pageGapPx: DOCUMENT_PAGE_GUTTER_PX,
                pageHeights: pageHeights.value,
                renderMarginPages: DOCUMENT_SOURCE_CONTINUOUS_MOUNT_RADIUS,
                scrollTop: viewportScrollTop.value,
                totalPages: pageCount,
                viewportHeight: containerHeight.value,
                overscanViewports: 1,
            })?.pageNumbers ?? []
            : [];
        return renderSession?.resolveMountedPages({
            currentPage: props.value.currentPage,
            destinationPage: [
                'opening',
                'transitioning',
            ].includes(chassisAuthority?.openSurface.viewportSession.value.lifecycle ?? '')
                ? chassisAuthority?.openSurface.snapshot.value.openingPageFrame?.pageNumber
                : undefined,
            maxPages: DOCUMENT_SOURCE_MAX_MOUNTED_PAGES,
            pageCount,
            radius: props.value.continuousScroll ? DOCUMENT_SOURCE_CONTINUOUS_MOUNT_RADIUS : 3,
            viewportPages,
        }) ?? [];
    });
    const renderDemand = computed(() => resolveDocumentPageSourceRenderDemand({
        bufferRadius: props.value.continuousScroll && effectiveZoom.value < 1
            ? DOCUMENT_SOURCE_CONTINUOUS_MOUNT_RADIUS
            : rasterBufferProfile.pdfBufferPages,
        continuousScroll: props.value.continuousScroll,
        currentPage: props.value.currentPage,
        estimatePagePixels: (pageNumber) => {
            const layout = pageLayouts.value[pageNumber - 1];
            const pixelRatio = window.devicePixelRatio || 1;
            return layout ? layout.width * layout.height * pixelRatio * pixelRatio : 1;
        },
        maxBufferPixels: rasterBufferProfile.maxBufferCanvasPixels,
        maximumResidentPages: DOCUMENT_SOURCE_MAX_RESIDENT_PAGES,
        minimumBufferPages: props.value.continuousScroll && effectiveZoom.value < 1
            ? DOCUMENT_SOURCE_CONTINUOUS_MOUNT_RADIUS
            : 2,
        preferredDirection: viewportScrollDirection.value,
        mountedPages: mountedPages.value,
        pageCount: source.value?.pageCount ?? pageMetrics.value.length,
        pageHeights: pageHeights.value,
        pageTops: pageTops.value,
        scrollTop: viewportScrollTop.value,
        viewportHeight: containerHeight.value,
    }));
    const surfaceStyle = computed(() => ({height: props.value.continuousScroll ? `${Math.max(1, totalHeight.value)}px` : '100%'}));
    function resolvePageLeft(pageWidth: number) {
        return Math.max(DOCUMENT_PAGE_GUTTER_PX, (containerWidth.value - pageWidth) / 2);
    }
    const zoomAnchorPageLayouts = computed(() => pageLayouts.value.map(layout => ({
        ...layout,
        left: resolvePageLeft(layout.width),
    })));
    function getPageStyle(pageNumber: number) {
        const layout = pageLayouts.value[pageNumber - 1];
        if (!layout) {
            return {};
        }
        return {
            width: `${String(layout.width)}px`,
            height: `${String(layout.height)}px`,
            top: `${String(props.value.continuousScroll
                ? pageTops.value[pageNumber - 1] ?? DOCUMENT_PAGE_GUTTER_PX
                : DOCUMENT_PAGE_GUTTER_PX)}px`,
            left: `${String(resolvePageLeft(layout.width))}px`,
            display: !props.value.continuousScroll && pageNumber !== props.value.currentPage
                ? 'none'
                : undefined,
        };
    }
    function getChassisOpeningShellTarget(pageNumber: number) {
        const snapshot = chassisAuthority?.openSurface.snapshot.value;
        const frame = snapshot?.openingPageFrame;
        const target = chassisAuthority?.openingPageElement.value;
        return frame
            && frame.generation === snapshot?.generation
            && frame.pageNumber === pageNumber
            && frame.pageNumber === chassisAuthority?.currentPage.value
            && target?.isConnected
            && target.dataset.pageNumber === String(pageNumber)
            && target.dataset.openSurfaceGeneration === String(snapshot.generation)
            && target.dataset.openSurfaceFrameOwner === frame.ownerId
            ? target
            : null;
    }
    function setPageElement(pageNumber: number, element: TDocumentPageElement) {
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
    const metricPublication = createDocumentPageMetricPublication({
        readMetrics: () => pageMetrics.value,
        commitMetrics: metrics => layoutLifecycle.preserveLayoutMutation(() => {
            pageMetrics.value = metrics;
        }),
        onPublished: () => scheduleRender.schedule(),
    });
    function ensureExactPageMetric(
        activeSource: IDocumentPageSource,
        generation: number,
        pageNumber: number,
        signal: AbortSignal,
        isCurrent: () => boolean,
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
                if (
                    isCurrent()
                    && source.value === activeSource
                    && pageNumber >= 1
                    && pageNumber <= activeSource.pageCount
                ) {
                    metricPublication.enqueue(pageNumber, metric);
                    exactPageMetricNumbers.add(pageNumber);
                }
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
    const transitions = createDocumentPageSourceLifecycle({
        chassisAuthority,
        readIsActive: () => props.value.isActive,
        readRevisionToken: () => props.value.documentRevisionToken ?? null,
        readSrc: () => props.value.src,
    });
    const presentation = createDocumentPageSourcePresentation({
        chassisAuthority,
        emit,
        ensureExactPageMetric,
        flushMetricPublication: metricPublication.flush,
        getOpeningTarget: getChassisOpeningShellTarget,
        isFenceCurrent: transitions.isCurrent,
        openSurfaceRenderOwner,
        readContinuousScroll: () => props.value.continuousScroll,
        readCurrentPage: () => props.value.currentPage,
        readFence: transitions.readFence,
        readIsActive: () => props.value.isActive,
        readLoadSignal: () => loadController?.signal ?? null,
        readMetric: pageNumber => pageMetrics.value[pageNumber - 1],
        readPageScale: pageNumber => (
            pageDisplayLayouts.value[pageNumber - 1]?.scale ?? effectiveZoom.value
        ),
        readPixelRatio: () => window.devicePixelRatio || 1,
        readRenderDemand: () => renderDemand.value,
        readSource: () => source.value,
        readViewport: () => viewerContainer.value,
        readViewportScrollDirection: () => viewportScrollDirection.value,
        renderSession,
        scheduleRender: () => scheduleRender.schedule(),
    });
    const renderPage = presentation.renderPage;
    async function renderMountedPages() {
        if (props.value.isResizing) {
            return;
        }
        await nextTick();
        const renderQueue = resolveDocumentPageSourceRenderQueue({
            bufferPages: renderDemand.value.bufferPages,
            concurrency: DOCUMENT_SOURCE_RENDER_CONCURRENCY,
            currentPage: props.value.currentPage,
            guardRadius: DOCUMENT_SOURCE_CONTINUOUS_MOUNT_RADIUS,
            inFlightPages: [...presentation.renderControllers.keys()],
            mountedPages: mountedPages.value,
            needsRender: (pageNumber) => {
                const state = presentation.pageStates.get(pageNumber);
                const metric = pageMetrics.value[pageNumber - 1];
                return !state?.lease || !state.ready || !metric || state.widthPx !== resolveDocumentPageSourceRenderWidthPx(
                    metric,
                    pageDisplayLayouts.value[pageNumber - 1]?.scale ?? effectiveZoom.value,
                    window.devicePixelRatio || 1,
                );
            },
            preferredDirection: viewportScrollDirection.value,
            residentPages: renderDemand.value.residentPages,
            visiblePages: renderDemand.value.visiblePages,
        });
        renderQueue.pagesToAbort.forEach(pageNumber => presentation.renderControllers.get(pageNumber)?.abort());
        await Promise.all(renderQueue.pagesToRender.map(renderPage));
    }
    const scheduleRender = createRafCoalescedCallback(() => void renderMountedPages());
    const captureLayoutRestoreEpoch = () => `${String(chassisAuthority?.openSurface.snapshot.value.generation ?? null)}:${String(viewportWritePort.getInteractionEpoch())}`;
    const layoutLifecycle = useDocumentViewportLayoutLifecycle({
        viewerContainer,
        pageLayouts: zoomAnchorPageLayouts,
        capturePageIndex: () => props.value.continuousScroll
            ? null
            : Math.max(0, props.value.currentPage - 1),
        isResizing: computed(() => props.value.isResizing),
        captureRestoreEpoch: captureLayoutRestoreEpoch,
        canRestore: epoch => epoch === captureLayoutRestoreEpoch()
            && (!chassisAuthority || (
                props.value.isActive
                && shouldProjectDocumentViewportScroll(
                    chassisAuthority.openSurface.snapshot.value,
                    chassisAuthority.openSurface.viewportSession.value,
                )
            )),
        applyRestoredScroll: (restored) => {
            const container = viewerContainer.value;
            return container !== null && viewportWritePort.apply(container, {
                intent: viewportWritePort.beginIntent(
                    `page-source-zoom-anchor:${String(transitions.loadGeneration.value)}`,
                ),
                reason: 'zoom-anchor-restoration',
                ...restored,
            });
        },
        onResizeSettled: () => scheduleRender.schedule(),
    });
    function handleScroll(event?: Event) {
        if (!viewerContainer.value || props.value.isResizing) {
            return;
        }
        const nextScrollTop = viewerContainer.value.scrollTop;
        const scrollDelta = nextScrollTop - viewportScrollTop.value;
        if (Math.abs(scrollDelta) > 1) {
            viewportScrollDirection.value = scrollDelta > 0 ? 1 : -1;
        }
        viewportScrollTop.value = nextScrollTop;
        scheduleRender.schedule();
        if (viewportWritePort.consumeAuthorityScroll(viewerContainer.value)) {
            layoutLifecycle.refreshLayoutTransactionAnchor();
            syncCurrentPageFromViewport(false);
            return;
        }
        if (layoutLifecycle.hasPendingPointerRestore()) {
            return;
        }
        if (chassisAuthority && event?.isTrusted !== true) {
            return;
        }
        layoutLifecycle.cancelPendingRestore();
        viewportWritePort.observeUserScroll(viewerContainer.value);
        layoutLifecycle.refreshLayoutTransactionAnchor();
        syncCurrentPageFromViewport(true);
    }
    function syncCurrentPageFromViewport(supersedeNavigation: boolean) {
        const container = viewerContainer.value;
        if (!container || !props.value.continuousScroll) {
            return;
        }
        const nearestPage = resolveNearestDocumentPageToViewportCenter({
            geometry: {
                pageHeights: pageHeights.value,
                pageTops: pageTops.value,
                totalHeight: totalHeight.value,
            },
            scrollTop: container.scrollTop,
            totalPages: pageMetrics.value.length,
            viewportHeight: container.clientHeight,
        });
        if (nearestPage && nearestPage !== props.value.currentPage) {
            const observedPage = chassisAuthority?.observePage(nearestPage, {supersedeNavigation}) ?? nearestPage;
            emit('update:currentPage', observedPage);
        }
    }
    function handleWheel(interaction: IDocumentWheelInteraction) {
        if (handleWheelZoom(interaction) || interaction.intent === 'platform-scroll') {
            return;
        }
        const target = pagedWheelNavigation.handle(interaction.event, {
            container: viewerContainer.value,
            continuousScroll: props.value.continuousScroll,
            currentPage: props.value.currentPage,
            pageCount: source.value?.pageCount ?? 0,
            pageHeights: pageHeights.value,
            viewMode: props.value.viewMode,
        });
        if (target !== null) scrollToPage(target, 'wheel');
    }
    function scrollToPage(
        pageNumber: number,
        navigationSource: Parameters<IDocumentViewerExpose['scrollToPage']>[1] | 'wheel' = undefined,
    ) {
        if (navigationSource !== 'wheel') {
            pagedWheelNavigation.reset();
        }
        const normalized = chassisAuthority?.navigate(pageNumber)
            ?? Math.max(1, Math.min(source.value?.pageCount ?? 1, Math.trunc(pageNumber)));
        const readyState = presentation.pageStates.get(normalized);
        if (readyState?.ready) {
            void nextTick(() => presentation.commitReady(normalized, readyState));
        }
        emit('update:currentPage', normalized);
        const intent = chassisAuthority?.viewportWritePort.beginIntent(
            `page-source-navigation:${String(normalized)}:${String(transitions.loadGeneration.value)}`,
        );
        const activeSource = source.value;
        const signal = loadController?.signal;
        const metricFence = transitions.readFence();
        if (activeSource && signal && !exactPageMetricNumbers.has(normalized)) {
            void ensureExactPageMetric(
                activeSource,
                metricFence.loadGeneration,
                normalized,
                signal,
                () => transitions.isCurrent(metricFence),
            ).then(() => scheduleRender.schedule()).catch((error: unknown) => {
                if (
                    transitions.isCurrent(metricFence)
                    && props.value.isActive
                    && source.value === activeSource
                    && !signal.aborted
                    && !(error instanceof DOMException && error.name === 'AbortError')
                ) {
                    const message = presentation.commitTerminalError(normalized);
                    if (normalized === props.value.currentPage) {
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
                    top: props.value.continuousScroll
                        ? Math.max(
                            0,
                            (pageTops.value[normalized - 1] ?? DOCUMENT_PAGE_GUTTER_PX)
                                - DOCUMENT_PAGE_GUTTER_PX,
                        )
                        : 0,
                });
                layoutLifecycle.refreshLayoutTransactionAnchor();
            }
            scheduleRender.schedule();
        });
    }
    function releaseInactivePageStates() {
        if (inactiveLeaseReleaseTimer !== null) {
            clearTimeout(inactiveLeaseReleaseTimer);
            inactiveLeaseReleaseTimer = null;
        }
        const retainCurrentPage = shouldRetainInactiveDocumentPageSourceLease(
            resolveOpenPathSecondaryPerformancePolicy(rasterBufferProfile)
                .inactiveDjvuLeasePolicy === 'warm-grace',
            surfaceBudget.getSnapshot().pressureLevel,
        );
        const retainedPageNumber = retainCurrentPage ? props.value.currentPage : null;
        for (const pageNumber of [...presentation.pageStates.keys()]) {
            if (pageNumber === retainedPageNumber) {
                continue;
            }
            presentation.releasePage(pageNumber);
        }
        const retainedState = retainedPageNumber === null ? null : presentation.pageStates.get(retainedPageNumber);
        const retainedLease = retainedState?.lease;
        if (retainedPageNumber === null || !retainedState || !retainedLease) {
            return;
        }
        retainedLease.setPriority?.('prefetch');
        retainedState.priority = 'prefetch';
        inactiveLeaseReleaseTimer = setTimeout(() => {
            inactiveLeaseReleaseTimer = null;
            if (!props.value.isActive && presentation.pageStates.get(retainedPageNumber)?.lease === retainedLease) {
                presentation.releasePage(retainedPageNumber);
            }
        }, DOCUMENT_SOURCE_INACTIVE_LEASE_GRACE_MS);
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
        emit('update:totalPages', geometry.pageCount);
        return true;
    }
    function applyOpenTransition(transition: IDocumentPageSourceTransition) {
        const documentRef = transition.fence.src;
        pagedWheelNavigation.reset();
        loadController?.abort();
        const activeLoadController = new AbortController();
        loadController = activeLoadController;
        exactPageMetricNumbers.clear();
        exactPageMetricLoads.clear();
        metricPublication.clear();
        presentation.beginSourceGeneration();
        const previousSource = source.value;
        previousSource?.dispose();
        if (chassisAuthority?.source.value === previousSource) {
            chassisAuthority.bindSource(null);
        }
        source.value = null;
        emit('update:pageSource', null);
        if (!seedOpeningPageMetrics()) {
            pageMetrics.value = documentRef
                ? createColdOpenProvisionalDocumentPageMetrics(Math.max(1, Math.trunc(
                    chassisAuthority?.currentPage.value ?? props.value.currentPage,
                )))
                : [];
        }
        emit('loading', Boolean(documentRef));
        if (!documentRef) {
            emit('update:totalPages', 0);
            return;
        }
        emit('initial-visual-pending');
        loadSettled = openDocumentPageSource(transition, {
            chassisAuthority,
            commitPageTerminalError: presentation.commitTerminalError,
            emit,
            ensureExactPageMetric,
            getOpeningShellTarget: getChassisOpeningShellTarget,
            layoutLifecycle,
            loadController: activeLoadController,
            markExactPageMetric: pageNumber => exactPageMetricNumbers.add(pageNumber),
            measureViewport,
            openingPageFrameOwnerId,
            publishPageMetrics: (metrics) => {
                pageMetrics.value = metrics;
            },
            readCurrentPage: () => chassisAuthority?.currentPage.value ?? props.value.currentPage,
            readPageMetric: pageNumber => pageMetrics.value[pageNumber - 1],
            readPolicy: () => ({
                continuousScroll: props.value.continuousScroll,
                zoom: props.value.zoom,
                zoomMode: props.value.zoomMode,
            }),
            readViewport: () => viewerContainer.value,
            renderPage,
            resetMetricPublication: metricPublication.clear,
            scheduleRender: scheduleRender.schedule,
            scrollToPage,
            setSource: (nextSource) => {
                source.value = nextSource;
            },
            surfaceBudget,
        }).then((settled) => {
            if (settled && transition.isCurrent()) {
                return transitions.channel.publish({
                    kind: 'settle',
                    fence: transition.fence,
                });
            }
            return false;
        }).then(() => undefined);
    }
    function applySuspendTransition() {
        scheduleRender.cancel();
        presentation.renderControllers.forEach(controller => controller.abort());
        presentation.renderControllers.clear();
        releaseInactivePageStates();
    }
    function applyRestoreTransition(transition: IDocumentPageSourceTransition) {
        if (inactiveLeaseReleaseTimer !== null) {
            clearTimeout(inactiveLeaseReleaseTimer);
            inactiveLeaseReleaseTimer = null;
        }
        const retainedState = presentation.pageStates.get(props.value.currentPage);
        retainedState?.lease?.setPriority?.('navigation');
        if (retainedState?.lease) {
            retainedState.priority = 'navigation';
        }
        void presentation.restore(transition, {
            measureViewport,
            renderMountedPages,
        });
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
        },
        {immediate: true},
    );
    transitions.channel.subscribe((transition) => {
        switch (transition.kind) {
            case 'open':
                applyOpenTransition(transition);
                return;
            case 'invalidate':
                applySuspendTransition();
                return;
            case 'restore':
                applyRestoreTransition(transition);
                return;
            case 'settle':
                scheduleRender.schedule();
        }
    });
    transitions.start();
    watch(effectiveZoom, (value) => {
        emit('update:effectiveZoom', value);
        if (!props.value.isResizing) scheduleRender.schedule();
    });
    function retainOnlyPageStates(pages: readonly number[]) {
        const retainedPages = new Set(pages);
        for (const pageNumber of presentation.pageStates.keys()) {
            if (!retainedPages.has(pageNumber)) {
                presentation.releasePage(pageNumber);
            }
        }
        scheduleRender.schedule();
    }
    watch(() => renderDemand.value.residentPages, retainOnlyPageStates);
    onMounted(() => {
        viewerContainer.value = chassisAuthority?.viewportElement.value ?? null;
        measureViewport();
        releaseViewportFeature = chassisAuthority?.bindViewportFeature({
            getClass: () => 'document-viewer-viewport document-source-viewer app-scrollbar',
            getStyle: () => ({}),
            events: {
                mousedown: cancelWheelInteraction,
                scroll: event => handleScroll(event),
            },
            wheel: handleWheel,
        }) ?? null;
    });
    onBeforeUnmount(() => {
        transitions.dispose();
        if (inactiveLeaseReleaseTimer !== null) {
            clearTimeout(inactiveLeaseReleaseTimer);
        }
        releaseViewportFeature?.();
        scheduleRender.cancel();
        metricPublication.clear();
        renderSession?.dispose();
        if (chassisOpeningSlotPage !== null) {
            pageSlots?.markUnmounted(chassisOpeningSlotPage);
            chassisOpeningSlotPage = null;
        }
        loadController?.abort();
        const activeSource = source.value;
        emit('update:pageSource', null);
        activeSource?.dispose();
        if (chassisAuthority?.source.value === activeSource) {
            chassisAuthority.bindSource(null);
        }
        presentation.dispose();
    });
    return {
        activeOpenSurfaceGeneration: transitions.openSurfaceGeneration,
        getChassisOpeningShellTarget,
        getPageStyle,
        getRenderGeneration: presentation.getRenderGeneration,
        getSurface: presentation.getSurface,
        getVisual: presentation.getVisual,
        getVisualError: presentation.getVisualError,
        handleSurfaceError: presentation.handleSurfaceError,
        handleSurfaceLoad: presentation.handleSurfaceLoad,
        loadGeneration: transitions.loadGeneration,
        mountedPages,
        pageLayouts,
        setPageElement,
        surfaceStyle,
        viewerExpose: {
            getViewerContainer: () => viewerContainer.value,
            getCurrentPage: () => props.value.currentPage,
            waitForViewerLoadSettled: () => loadSettled,
            scrollToPage,
            invalidatePages: (pages: readonly number[]) => pages.forEach(page => void renderPage(page)),
            requestScrollToCurrentResult: () => scrollToPage(props.value.currentPage),
            captureScrollSnapshot: () => ({page: chassisAuthority?.currentPage.value ?? props.value.currentPage}),
            restoreScrollSnapshot: (snapshot: unknown, exposeOptions: {fallbackPage: number;}) => {
                const page = typeof snapshot === 'object' && snapshot !== null && 'page' in snapshot
                    ? Number(snapshot.page)
                    : exposeOptions.fallbackPage;
                scrollToPage(Number.isFinite(page) ? page : exposeOptions.fallbackPage);
            },
        },
    };
};
