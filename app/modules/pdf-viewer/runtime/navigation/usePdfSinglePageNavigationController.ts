import {tryOnScopeDispose} from '@vueuse/core';
import {clamp} from 'es-toolkit/math';
import {createPdfNavigationMachineState} from '@app/modules/pdf-viewer/runtime/navigation/createPdfNavigationMachineState';
import type {IUsePdfSinglePageScrollOptions} from '@app/modules/pdf-viewer/runtime/navigation/pdfSinglePageScrollTypes';
import type {IScrollToPageOptions} from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/scrollToPageOptions';
import type {IPdfPageSlotRegistry} from '@app/modules/pdf-viewer/runtime/page-slots/pdfPageSlotRegistry';
import {
    createPdfViewportGeometryFromLayout,
    resolveAnchorFromScroll,
    resolveRetainedAnchorFromScroll,
    resolveScrollForAnchor,
    type IPdfSemanticAnchor,
    type IPdfViewportGeometry,
} from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportGeometry';
import {
    createViewportAuthority as createViewportAuthorityService,
    type IPdfViewportPositionCommit,
    type TPdfViewportIntentKind,
} from '@app/modules/pdf-viewer/runtime/viewport/createViewportAuthority';
import {
    createPageNavigationRequest,
    type IPdfNavigationRequest,
} from '@app/modules/pdf-viewer/engine/viewport/createPageNavigationRequest';
import {
    isPdfNavigationReady,
    resolvePdfNavigationAnchor,
    resolvePdfNavigationTarget,
    resolveTextAnchorRect,
    type IResolvedPdfNavigationTarget,
} from '@app/modules/pdf-viewer/runtime/viewport/pdfNavigationRequestResolver';
import {createWheelFlipGate} from '@app/utils/document-viewer/single-page-wheel/createWheelFlipGate';
import {
    canScrollWithinPageBounds,
    resolveWheelDirection,
    resolveWheelTargetPage,
} from '@app/utils/document-viewer/single-page-wheel/singlePageWheelNavigation';
import {getPageScrollBounds} from '@app/modules/pdf-viewer/runtime/navigation/singlePageScrollGeometry';
import {resolveRetainedPdfNavigationAnchor} from '@app/modules/pdf-viewer/engine/pdf-navigation-anchor-retention/resolveRetainedPdfNavigationAnchor';
import {logPdfRenderTrace} from '@app/utils/pdfRenderTrace';
import {runGuardedTask} from '@app/utils/asyncGuard';
import {createLatestWinsPdfMetricHydrator} from '@app/modules/pdf-viewer/runtime/navigation/createLatestWinsPdfMetricHydrator';
import {
    getRequestAnchor,
    getRequestPage,
} from '@app/modules/pdf-viewer/runtime/navigation/pdfNavigationRequestAnchors';

interface IUsePdfSinglePageNavigationControllerOptions extends IUsePdfSinglePageScrollOptions {
    requestedCurrentPage: Ref<number | undefined>;
    viewerContainer: Ref<HTMLElement | null>;
    cancelPendingSearchScroll: () => void;
    pageSlots: IPdfPageSlotRegistry;
    bindCurrentPageProjection?: ((projection: Readonly<Ref<number>>) => void) | undefined;
    getDocumentRevision: () => number;
    getGeometryRevision: () => number;
    onViewportPositionCommitted?: ((commit: IPdfViewportPositionCommit) => void) | undefined;
    onUserViewportPageObserved?: ((pageNumber: number) => void) | undefined;
    requestSurfacePageNavigation?: ((pageNumber: number) => number) | undefined;
    onPageVisualReady?: ((pageNumber: number) => void) | undefined;
}

interface IPdfSinglePageWheelEvent {
    deltaX: number;
    deltaY: number;
    timeStamp: number;
    preventDefault: () => void;
}

function getMountedPageElement(container: HTMLElement, pageNumber: number) {
    return container.querySelector<HTMLElement>(
        `.page_container[data-page="${String(Math.max(1, Math.trunc(pageNumber)))}"]`,
    );
}

function resolvePagedAnchorFromViewport(
    container: HTMLElement,
    pageNumber: number,
    viewportFraction = {
        x: 0.5,
        y: 0.5,
    },
): IPdfSemanticAnchor {
    const page = Math.max(1, Math.trunc(pageNumber));
    const element = getMountedPageElement(container, page);
    if (!element) {
        return getRequestAnchor(undefined, page);
    }
    const viewportRect = container.getBoundingClientRect();
    const pageRect = element.getBoundingClientRect();
    const x = viewportRect.left + container.clientWidth * viewportFraction.x;
    const y = viewportRect.top + container.clientHeight * viewportFraction.y;
    return {
        page,
        pageXFraction: clamp((x - pageRect.left) / Math.max(1, pageRect.width), 0, 1),
        pageYFraction: clamp((y - pageRect.top) / Math.max(1, pageRect.height), 0, 1),
        viewportXFraction: clamp(viewportFraction.x, 0, 1),
        viewportYFraction: clamp(viewportFraction.y, 0, 1),
        affinity: 'center',
    };
}

function resolvePagedScrollForAnchor(
    container: HTMLElement,
    anchor: IPdfSemanticAnchor,
    scaledMargin: number,
) {
    const element = getMountedPageElement(container, anchor.page);
    if (!element) {
        return {
            left: container.scrollLeft,
            top: container.scrollTop,
        };
    }
    const viewportRect = container.getBoundingClientRect();
    const pageRect = element.getBoundingClientRect();
    const pageContentLeft = container.scrollLeft + pageRect.left - viewportRect.left;
    const pageContentTop = container.scrollTop + pageRect.top - viewportRect.top;
    return {
        left: clamp(
            pageContentLeft + clamp(anchor.pageXFraction, 0, 1) * pageRect.width
                - clamp(anchor.viewportXFraction, 0, 1) * container.clientWidth,
            0,
            Math.max(0, container.scrollWidth - container.clientWidth),
        ),
        top: clamp(
            pageContentTop + clamp(anchor.pageYFraction, 0, 1) * pageRect.height
                - clamp(anchor.viewportYFraction, 0, 1) * container.clientHeight
                - (anchor.affinity === 'start' ? scaledMargin : 0),
            0,
            Math.max(0, container.scrollHeight - container.clientHeight),
        ),
    };
}

export function shouldSubmitRequestedCurrentPage(
    requestedPage: number,
    committedPage: number,
    pendingPage: number | null,
) {
    // The outer page model is also the projection sink for committed viewer
    // pages. While navigation is pending it can therefore briefly contain an
    // older commit (for example page 2 after wheel intent has already advanced
    // to page 3). Explicit toolbar/search/thumbnail commands enter through
    // submitPageNavigation, so a prop echo must never supersede newer internal
    // intent. Once idle, the prop remains the initial/restore command channel.
    return pendingPage === null && requestedPage !== committedPage;
}

/**
 * Production viewport authority adapter. Every navigation/scroll commit is
 * resolved from an immutable layout snapshot and written once by the authority.
 */
export const usePdfSinglePageNavigationController = (options: IUsePdfSinglePageNavigationControllerOptions) => {
    let intentSequence = 0;
    let navigationIntentSequence = 0;
    let resizePreviewWriteSequence = 0;
    let activeNavigationSequence: number | null = null;
    const retainedNavigationAnchorPage = ref<number | null>(null);
    const wheelNavigationCursorPage = ref<number | null>(null);
    let queuedNavigation: {
        request: IPdfNavigationRequest;
        sequence: number;
    } | null = null;
    const wheelFlipGate = createWheelFlipGate();
    let geometry: IPdfViewportGeometry | null = null;
    const resolvedTargets = new Map<string, IResolvedPdfNavigationTarget>();
    const metricHydrator = createLatestWinsPdfMetricHydrator(async page => (
        await options.ensurePageMetricsInRange?.(page, page) ?? false
    ));

    function refreshGeometry() {
        const container = options.viewerContainer.value;
        const metrics = options.getPageLayoutMetrics?.() ?? null;
        if (!container || !metrics) {
            geometry = null;
            return null;
        }
        const geometryRevision = options.getGeometryRevision();
        geometry = createPdfViewportGeometryFromLayout(metrics, {
            width: container.clientWidth,
            height: container.clientHeight,
        }, geometryRevision);
        return geometry;
    }

    function resolveAnchorForViewport(
        snapshot: IPdfViewportGeometry,
        pageNumber: number,
        viewportFraction?: {
            x: number;
            y: number;
        },
    ) {
        const container = options.viewerContainer.value;
        if (!options.continuousScroll.value && container) {
            return resolvePagedAnchorFromViewport(container, pageNumber, viewportFraction);
        }
        return resolveAnchorFromScroll(snapshot, {
            left: container?.scrollLeft ?? 0,
            top: container?.scrollTop ?? 0,
        }, viewportFraction);
    }

    function resolveScrollForViewport(snapshot: IPdfViewportGeometry, anchor: IPdfSemanticAnchor) {
        const container = options.viewerContainer.value;
        if (!options.continuousScroll.value && container) {
            return resolvePagedScrollForAnchor(container, anchor, options.scaledMargin.value);
        }
        return resolveScrollForAnchor(snapshot, anchor);
    }

    const viewportAuthority = createViewportAuthorityService({
        getDocumentRevision: options.getDocumentRevision,
        getGeometryRevision: options.getGeometryRevision,
        awaitMetrics: async (intent, signal) => {
            const resolved = intent.navigation
                ? await resolvePdfNavigationTarget(intent.navigation.target, options.pdfDocument.value)
                : null;
            if (resolved) resolvedTargets.set(intent.id, resolved);
            const page = resolved?.page ?? getRequestPage(
                intent.navigation,
                intent.anchor?.page ?? options.currentPage.value,
            );
            await metricHydrator.ensure(page, signal);
            if (!options.continuousScroll.value || intent.navigation) {
                await options.prepareNavigationLayout?.(page, signal);
            }
            refreshGeometry();
            return options.getGeometryRevision();
        },
        resolve: (intent) => {
            const container = options.viewerContainer.value;
            const snapshot = geometry ?? refreshGeometry();
            const resolved = resolvedTargets.get(intent.id);
            const anchor = intent.anchor
                ?? (intent.navigation && resolved
                    ? resolvePdfNavigationAnchor(intent.navigation, resolved)
                    : getRequestAnchor(intent.navigation, options.currentPage.value));
            if (!container || !snapshot) {
                throw new DOMException('PDF viewport geometry unavailable', 'AbortError');
            }
            const scroll = intent.kind === 'dpr'
                ? {
                    left: container.scrollLeft,
                    top: container.scrollTop,
                }
                : resolveScrollForViewport(snapshot, anchor);
            return Promise.resolve({
                anchor,
                ...scroll,
                ...(intent.zoom === undefined ? {} : {zoom: intent.zoom}),
                ...(intent.viewMode === undefined ? {} : {viewMode: intent.viewMode}),
            });
        },
        refine: (intent, commit) => {
            const container = options.viewerContainer.value;
            const snapshot = refreshGeometry();
            const request = intent.navigation;
            const resolved = resolvedTargets.get(intent.id);
            if (!container || !snapshot || !request || !resolved) {
                return Promise.resolve(commit);
            }
            if (request.target.kind === 'text-anchor') {
                const rect = resolveTextAnchorRect(container, request.target);
                if (rect) resolved.rect = rect;
            }
            const anchor = resolvePdfNavigationAnchor(request, resolved);
            const scroll = resolveScrollForViewport(snapshot, anchor);
            if (request.alignment === 'keep-visible') {
                const centerAnchor = resolvePdfNavigationAnchor({
                    ...request,
                    alignment: 'rect-center',
                }, resolved);
                const center = resolveScrollForViewport(snapshot, centerAnchor);
                const visible = Math.abs(center.left - container.scrollLeft) <= container.clientWidth / 2
                    && Math.abs(center.top - container.scrollTop) <= container.clientHeight / 2;
                if (visible) {
                    return Promise.resolve({
                        ...commit,
                        anchor: resolveAnchorForViewport(snapshot, anchor.page),
                        left: container.scrollLeft,
                        top: container.scrollTop,
                    });
                }
            }
            return Promise.resolve({
                ...commit,
                anchor,
                ...scroll,
            });
        },
        awaitSlots: async (intent, signal) => {
            const page = resolvedTargets.get(intent.id)?.page
                ?? getRequestPage(intent.navigation, intent.anchor?.page ?? options.currentPage.value);
            const row = geometry?.rows.find(candidate => page >= candidate.startPage && page <= candidate.endPage);
            const start = row?.startPage ?? page;
            const end = row?.endPage ?? page;
            await nextTick();
            await Promise.all(Array.from({length: end - start + 1}, (_, offset) => (
                options.pageSlots.whenMounted(start + offset, signal)
            )));
        },
        apply: (intent, commit) => {
            const container = options.viewerContainer.value;
            if (!container || intent.kind === 'dpr') {
                return;
            }
            const applied = options.viewportWritePort.apply(container, {
                intent: options.viewportWritePort.beginIntent(intent.id),
                reason: `viewport-authority:${intent.kind}`,
                left: commit.left,
                top: commit.top,
            });
            logPdfRenderTrace('navigation-viewport-authority-applied', {
                intentId: intent.id,
                kind: intent.kind,
                page: commit.anchor.page,
                requestedLeft: commit.left,
                requestedTop: commit.top,
                actualLeft: container.scrollLeft,
                actualTop: container.scrollTop,
                applied,
            });
            // The authority clears its pending target immediately after apply.
            // Project the just-written scroll position into visibleRange first so
            // virtualization transfers ownership to the target row instead of
            // collapsing back to the stale pre-navigation window for one frame.
            options.updateVisibleRange(container, options.numPages.value);
            void nextTick(() => logPdfRenderTrace('navigation-viewport-authority-after-range-update', {
                intentId: intent.id,
                page: commit.anchor.page,
                actualLeft: container.scrollLeft,
                actualTop: container.scrollTop,
            }));
            return {
                left: container.scrollLeft,
                top: container.scrollTop,
            };
        },
        onPositionCommitted: (commit) => {
            const sequence = activeNavigationSequence;
            if (sequence !== null && queuedNavigation?.sequence === sequence) {
                queuedNavigation = null;
            }
            options.onViewportPositionCommitted?.(commit);
        },
        awaitVisual: async (intent) => {
            const page = resolvedTargets.get(intent.id)?.page
                ?? getRequestPage(intent.navigation, intent.anchor?.page ?? options.currentPage.value);
            const row = geometry?.rows.find(candidate => page >= candidate.startPage && page <= candidate.endPage);
            const container = options.viewerContainer.value;
            const readiness = intent.navigation?.readiness ?? 'page-canvas';
            const range = {
                start: row?.startPage ?? page,
                end: row?.endPage ?? page,
            };
            logPdfRenderTrace('navigation-await-visual-enter', () => ({
                intentId: intent.id,
                kind: intent.kind,
                page,
                range,
                readiness,
                hasContainer: container !== null,
                currentPage: options.currentPage.value,
                visibleRange: options.visibleRange.value,
            }));
            if (container && isPdfNavigationReady(
                container,
                page,
                readiness,
                options.isPageFreshlyRenderedForNavigation ?? (() => true),
            )) {
                options.onPageVisualReady?.(page);
                logPdfRenderTrace('navigation-await-visual-exit', {
                    intentId: intent.id,
                    page,
                    readiness,
                    outcome: 'already-ready',
                });
                return;
            }
            await options.renderVisiblePages(range);
            if (container && !isPdfNavigationReady(
                container,
                page,
                readiness,
                options.isPageFreshlyRenderedForNavigation ?? (() => true),
            )) {
                logPdfRenderTrace('navigation-await-visual-exit', {
                    intentId: intent.id,
                    page,
                    readiness,
                    outcome: 'render-settled-not-ready',
                });
                throw new DOMException(`PDF navigation readiness not reached: ${readiness}`, 'AbortError');
            }
            if (container) {
                options.onPageVisualReady?.(page);
            }
            logPdfRenderTrace('navigation-await-visual-exit', {
                intentId: intent.id,
                page,
                readiness,
                outcome: container ? 'ready' : 'container-detached',
            });
        },
        postArrival: async (request, signal) => {
            if (signal.aborted) {
                return;
            }
            await options.onNavigationPostArrival?.(request, signal);
            if (signal.aborted) {
                return;
            }
            const container = options.viewerContainer.value;
            if (container && request.postArrival) {
                container.dispatchEvent(new CustomEvent('pdf-navigation-post-arrival', {detail: {
                    effect: request.postArrival,
                    request,
                }}));
            }
        },
        clearDemand: intentId => resolvedTargets.delete(intentId),
    });
    options.bindCurrentPageProjection?.(viewportAuthority.currentPage);

    function requestFor(page: number, scrollOptions?: IScrollToPageOptions) {
        if (scrollOptions?.navigationRequest) {
            return scrollOptions.navigationRequest;
        }
        const source = scrollOptions?.navigationSource
            ?? (scrollOptions?.markerRect ? 'annotation' : 'toolbar');
        const request = createPageNavigationRequest(page, source);
        if (scrollOptions?.markerRect) {
            request.target = {
                kind: 'rect',
                page,
                rect: scrollOptions.markerRect,
            };
            request.alignment = 'rect-center';
        } else if (typeof scrollOptions?.pageYRatio === 'number') {
            request.target = {
                kind: 'rect',
                page,
                rect: {
                    left: 0.5,
                    top: clamp(scrollOptions.pageYRatio, 0, 1),
                    width: 0,
                    height: 0,
                },
            };
            request.alignment = 'page-top';
        }
        if (source === 'search') {
            request.readiness = 'text-layer';
            request.postArrival = 'search-highlight';
        } else if (source === 'annotation') {
            request.readiness = 'annotation-editor';
            request.postArrival = 'annotation-pulse';
        } else if (source === 'bookmark') {
            request.readiness = 'page-canvas';
        } else if (source === 'thumbnail') {
            request.readiness = 'page-canvas';
        }
        return request;
    }

    async function submitNavigationIntent(request: IPdfNavigationRequest) {
        const submittedDocumentRevision = options.getDocumentRevision();
        const submittedGeometryRevision = options.getGeometryRevision();
        refreshGeometry();
        const result = await viewportAuthority.submit({
            // Replays retain queue ownership but require a fresh authority ID.
            id: `viewport-navigation-${String(++navigationIntentSequence)}`,
            kind: request.source === 'search' ? 'search' : request.source === 'wheel' ? 'wheel-page' : 'navigate',
            documentRevision: submittedDocumentRevision,
            geometryRevision: submittedGeometryRevision,
            priority: 10,
            supersessionKey: 'navigation',
            navigation: request,
        });
        return result;
    }

    function submitDetachedNavigationIntent(request: IPdfNavigationRequest, sequence: number) {
        activeNavigationSequence = sequence;
        runGuardedTask(async () => {
            try {
                await submitNavigationIntent(request);
            } finally {
                if (activeNavigationSequence === sequence) {
                    activeNavigationSequence = null;
                }
            }
            if (queuedNavigation !== null) {
                await nextTick();
                replayQueuedNavigation();
            }
        }, {
            category: 'background-diagnostic',
            scope: 'pdf-navigation',
            message: `PDF viewport navigation ${sequence} failed`,
        });
    }

    function getNavigationRequestPage(request: IPdfNavigationRequest) {
        return 'page' in request.target ? request.target.page : null;
    }

    function clampNavigationRequest(
        request: IPdfNavigationRequest,
        totalPages: number,
    ): IPdfNavigationRequest {
        if (!('page' in request.target)) {
            return request;
        }
        const page = clamp(Math.trunc(request.target.page), 1, totalPages);
        return {
            ...request,
            target: {
                ...request.target,
                page,
            },
        };
    }

    function canReplayQueuedNavigation() {
        return Boolean(
            queuedNavigation
            && activeNavigationSequence === null
            && isNavigationRuntimeReady(),
        );
    }

    function isNavigationRuntimeReady() {
        return Boolean(
            options.viewerContainer.value
            && !options.isLoading.value
            && options.pdfDocument.value
            && options.numPages.value > 0
            && options.getDocumentRevision() > 0
            && options.getGeometryRevision() > 0
            && options.getPageLayoutMetrics?.() !== null,
        );
    }
    const navigationRuntimeReady = computed(isNavigationRuntimeReady);

    function replayQueuedNavigation() {
        if (!canReplayQueuedNavigation()) {
            logPdfRenderTrace('navigation-queued-replay-deferred', () => ({
                hasQueuedNavigation: queuedNavigation !== null,
                activeNavigationSequence,
                hasContainer: options.viewerContainer.value !== null,
                isLoading: options.isLoading.value,
                hasDocument: options.pdfDocument.value !== null,
                numPages: options.numPages.value,
                documentRevision: options.getDocumentRevision(),
                geometryRevision: options.getGeometryRevision(),
                hasLayoutMetrics: options.getPageLayoutMetrics?.() !== null,
            }));
            return false;
        }
        const queued = queuedNavigation!;
        const request = clampNavigationRequest(queued.request, options.numPages.value);
        const page = getNavigationRequestPage(request);
        if (page !== null) {
            options.requestSurfacePageNavigation?.(page);
            retainedNavigationAnchorPage.value = page;
            options.emitNavigationFeedbackPage?.(page);
        }
        submitDetachedNavigationIntent(request, queued.sequence);
        logPdfRenderTrace('navigation-queued-replay-submitted', {
            sequence: queued.sequence,
            page,
        });
        return true;
    }

    function queueNavigationRequest(request: IPdfNavigationRequest) {
        if (request.source !== 'wheel') {
            wheelNavigationCursorPage.value = null;
        }
        intentSequence += 1;
        queuedNavigation = {
            request,
            sequence: intentSequence,
        };
        const page = getNavigationRequestPage(request);
        if (page !== null) {
            // Preserve the raw requested page until metadata supplies the only
            // authoritative clamp. This makes rapid commands durable during
            // Recent/open transitions without committing viewport state early.
            retainedNavigationAnchorPage.value = page;
            options.emitNavigationFeedbackPage?.(page);
        }
        if (activeNavigationSequence !== null) {
            viewportAuthority.suspend();
            activeNavigationSequence = null;
        }
        replayQueuedNavigation();
        return true;
    }

    function clearQueuedNavigation() {
        queuedNavigation = null;
        intentSequence += 1;
        retainedNavigationAnchorPage.value = null;
        wheelNavigationCursorPage.value = null;
        options.emitNavigationFeedbackPage?.(null);
    }

    function submitPageNavigation(pageNumber: number, scrollOptions?: IScrollToPageOptions) {
        if (!Number.isFinite(pageNumber)) {
            return false;
        }
        const page = Math.max(1, Math.trunc(pageNumber));
        const request = requestFor(page, scrollOptions);
        return queueNavigationRequest(request);
    }

    function submitNavigationRequest(request: IPdfNavigationRequest) {
        return queueNavigationRequest(request);
    }

    function submitViewportStateIntent(
        kind: Exclude<TPdfViewportIntentKind, 'navigate' | 'search' | 'wheel-page' | 'user-scroll'>,
        state: {
            zoom?: number;
            viewMode?: IUsePdfSinglePageScrollOptions['viewMode']['value'];
            dpr?: number;
            viewportPoint?: {
                x: number;
                y: number
            };
            anchor?: IPdfSemanticAnchor;
        } = {},
    ) {
        const documentRevision = options.getDocumentRevision();
        const geometryRevision = options.getGeometryRevision();
        if (documentRevision <= 0 || geometryRevision <= 0) {
            // ResizeObserver and reactive layout watchers can run while a PDF
            // surface is being mounted or torn down. At that boundary there
            // is deliberately no live document generation to own a viewport
            // write, so treat the transient intent as cancelled instead of
            // violating the viewport authority's revision invariant.
            logPdfRenderTrace('navigation-viewport-state-intent-cancelled', () => ({
                kind,
                documentRevision,
                geometryRevision,
                reason: 'inactive-revision',
            }));
            return Promise.resolve({
                outcome: 'cancelled' as const,
                intent: null,
                positionCommit: null,
            });
        }
        intentSequence += 1;
        const container = options.viewerContainer.value;
        const snapshot = refreshGeometry();
        const inheritedNavigation = queuedNavigation?.request
            ?? viewportAuthority.getActiveNavigationRequest();
        const absorbedNavigation = navigationRuntimeReady.value
            && state.anchor === undefined
            && state.viewportPoint === undefined
            ? inheritedNavigation
            : undefined;
        const inheritedNavigationPage = absorbedNavigation
            ? getNavigationRequestPage(absorbedNavigation)
            : null;
        const inheritedResolvedTarget = viewportAuthority.activeIntent.value
            ? resolvedTargets.get(viewportAuthority.activeIntent.value.id)
            : null;
        const anchor = state.anchor ?? (container && snapshot && state.viewportPoint
            ? resolveAnchorForViewport(snapshot, viewportAuthority.currentPage.value, {
                x: state.viewportPoint.x / Math.max(1, container.clientWidth),
                y: state.viewportPoint.y / Math.max(1, container.clientHeight),
            })
            : absorbedNavigation && inheritedResolvedTarget
                ? resolvePdfNavigationAnchor(absorbedNavigation, inheritedResolvedTarget)
                : absorbedNavigation
                    ? getRequestAnchor(
                        absorbedNavigation,
                        inheritedNavigationPage ?? options.currentPage.value,
                    )
                    : retainedNavigationAnchorPage.value !== null
                        ? getRequestAnchor(undefined, retainedNavigationAnchorPage.value)
                        : container && snapshot
                            ? resolveGeometryChangeAnchor(snapshot, kind)
                            : viewportAuthority.committedAnchor.value
                                ?? getRequestAnchor(undefined, options.currentPage.value));
        const absorbedNavigationSequence = queuedNavigation?.sequence ?? null;
        if (absorbedNavigation) {
            // A geometry-changing intent is the new owner of the pending
            // destination. The detached navigation task must not replay its
            // stale request and supersede this fit/zoom/view-mode transaction.
            queuedNavigation = null;
            activeNavigationSequence = null;
        }
        logPdfRenderTrace('navigation-viewport-state-intent-submitted', () => ({
            kind,
            inheritedNavigationPage,
            absorbedNavigationSequence,
            retainedPage: retainedNavigationAnchorPage.value,
            committedPage: viewportAuthority.currentPage.value,
            anchorPage: anchor.page,
        }));
        return viewportAuthority.submit({
            id: `viewport-state-${intentSequence}`,
            kind,
            documentRevision,
            geometryRevision,
            priority: 5,
            supersessionKey: 'viewport-state',
            anchor,
            ...(absorbedNavigation === undefined ? {} : {navigation: absorbedNavigation}),
            ...(state.zoom === undefined ? {} : {zoom: state.zoom}),
            ...(state.viewMode === undefined ? {} : {viewMode: state.viewMode}),
            ...(state.dpr === undefined ? {} : {dpr: state.dpr}),
        });
    }

    /**
     * The anchor a fit/zoom/view-mode change inherits when nothing else claims
     * one. The pre-change pixel offset is about to stop describing anything, so
     * the semantic page the viewport authority already committed is what the
     * new geometry has to be built around.
     */
    function resolveGeometryChangeAnchor(
        snapshot: IPdfViewportGeometry,
        kind: TPdfViewportIntentKind,
    ): IPdfSemanticAnchor {
        const semanticPage = clamp(
            Math.trunc(viewportAuthority.currentPage.value),
            1,
            Math.max(1, options.numPages.value),
        );
        if (kind === 'fit') {
            // Fit replaces every row's height, so the pre-fit offset - and the
            // point fractions read from it - describe nothing under the new
            // metrics. Land on the top of the page the user was on rather than
            // reinterpreting that offset and travelling hundreds of pages.
            return getRequestAnchor(undefined, semanticPage);
        }
        const liveAnchor = resolveAnchorForViewport(snapshot, viewportAuthority.currentPage.value);
        // A zoom ref and page layout can update before this watcher runs. Keep
        // the live point fractions, but do not reinterpret the old pixel scroll
        // against new-scale rows and jump to an earlier page. The viewport
        // authority's committed page is the semantic owner here; the outer
        // requested-page prop can briefly lag after a completed toolbar
        // navigation.
        return kind === 'zoom'
            ? {
                ...liveAnchor,
                page: semanticPage,
            }
            : liveAnchor;
    }

    function observeNativeUserScroll() {
        if (queuedNavigation !== null || retainedNavigationAnchorPage.value !== null) {
            clearQueuedNavigation();
        }
        const container = options.viewerContainer.value;
        const snapshot = refreshGeometry();
        const anchor = container && snapshot
            ? resolveAnchorForViewport(snapshot, viewportAuthority.currentPage.value)
            : getRequestAnchor(undefined, options.currentPage.value);
        viewportAuthority.observeUserScroll(anchor);
        if (container) options.viewportWritePort.observeUserScroll(container);
        return anchor.page;
    }

    function captureCurrentSemanticAnchor() {
        const container = options.viewerContainer.value;
        const snapshot = refreshGeometry();
        return container && snapshot
            ? options.continuousScroll.value
                ? resolveRetainedAnchorFromScroll(snapshot, {
                    left: container.scrollLeft,
                    top: container.scrollTop,
                }, viewportAuthority.committedAnchor.value)
                : resolvePagedAnchorFromViewport(container, viewportAuthority.currentPage.value)
            : viewportAuthority.committedAnchor.value;
    }

    function applyResizeAnchorPreview(anchor: IPdfSemanticAnchor | null | undefined) {
        const container = options.viewerContainer.value;
        const snapshot = refreshGeometry();
        if (!anchor || !container || !snapshot) {
            return false;
        }
        const scroll = resolveScrollForViewport(snapshot, anchor);
        const applied = options.viewportWritePort.apply(container, {
            intent: options.viewportWritePort.beginIntent(
                `pdf-resize-preview-${String(++resizePreviewWriteSequence)}`,
            ),
            reason: 'resize-anchor-preview',
            ...scroll,
        });
        options.updateVisibleRange(container, options.numPages.value);
        return applied;
    }

    function commitCurrentViewportPosition(
        pageNumber: number,
        intentId: string,
        intentKind: TPdfViewportIntentKind = 'document-restore',
    ) {
        const container = options.viewerContainer.value;
        const snapshot = refreshGeometry();
        if (!container || !snapshot || viewportAuthority.activeIntent.value !== null) {
            return false;
        }
        const page = clamp(Math.trunc(pageNumber), 1, Math.max(1, options.numPages.value));
        const anchor = {
            ...resolveAnchorForViewport(snapshot, page),
            page,
        };
        return viewportAuthority.commitSettledPosition({
            intentId,
            intentKind,
            documentRevision: options.getDocumentRevision(),
            geometryRevision: options.getGeometryRevision(),
            page,
            left: container.scrollLeft,
            top: container.scrollTop,
            anchor,
        }) !== null;
    }

    function commitCurrentViewportIfSettled(pageNumber: number) {
        const container = options.viewerContainer.value;
        const snapshot = refreshGeometry();
        if (!container || !snapshot || viewportAuthority.activeIntent.value !== null) {
            return false;
        }
        const page = clamp(Math.trunc(pageNumber), 1, Math.max(1, options.numPages.value));
        const expected = resolveScrollForViewport(snapshot, getRequestAnchor(undefined, page));
        if (
            Math.abs(container.scrollLeft - expected.left) > 1
            || Math.abs(container.scrollTop - expected.top) > 1
        ) {
            return false;
        }
        return commitCurrentViewportPosition(page, `viewport-observed-${String(++intentSequence)}`);
    }

    function captureViewportCommitDiagnostics(pageNumber: number) {
        const container = options.viewerContainer.value;
        const layout = options.getPageLayoutMetrics?.() ?? null;
        const snapshot = container && layout
            ? createPdfViewportGeometryFromLayout(layout, {
                width: container.clientWidth,
                height: container.clientHeight,
            }, options.getGeometryRevision())
            : null;
        const page = clamp(Math.trunc(pageNumber), 1, Math.max(1, options.numPages.value));
        const expected = snapshot
            ? resolveScrollForViewport(snapshot, getRequestAnchor(undefined, page))
            : null;
        return {
            hasContainer: container !== null,
            containerConnected: container?.isConnected ?? false,
            hasLayout: layout !== null,
            hasGeometry: snapshot !== null,
            actualLeft: container?.scrollLeft ?? null,
            actualTop: container?.scrollTop ?? null,
            expectedLeft: expected?.left ?? null,
            expectedTop: expected?.top ?? null,
            clientWidth: container?.clientWidth ?? null,
            clientHeight: container?.clientHeight ?? null,
            scrollWidth: container?.scrollWidth ?? null,
            scrollHeight: container?.scrollHeight ?? null,
            layoutTotalPages: layout?.base.totalPages ?? null,
            layoutScale: layout?.scale ?? null,
        };
    }

    function cancelProgrammaticNavigation(reason = 'explicit-cancel') {
        wheelFlipGate.reset();
        logPdfRenderTrace('navigation-retained-anchor-cleared', () => ({
            reason,
            retainedPage: retainedNavigationAnchorPage.value,
            pendingPage: viewportAuthority.pendingTargetPage.value,
            currentPage: viewportAuthority.currentPage.value,
        }));
        clearQueuedNavigation();
        const page = observeNativeUserScroll();
        // Physical input is authoritative even when the browser cannot move
        // the viewport (for example, while a programmatic scroll and canvas
        // commit are still settling). Publish the live anchor at the input
        // boundary so the shared session cannot remain transitioning merely
        // because no follow-up scroll event was emitted.
        options.onUserViewportPageObserved?.(page);
        return page;
    }

    function resetContinuousScrollState() {
        wheelFlipGate.reset();
        observeNativeUserScroll();
    }

    function cancelDestinationNavigationTarget() {
        wheelFlipGate.reset();
        const activeIntent = viewportAuthority.activeIntent.value;
        const hasDestinationDemand = queuedNavigation !== null || activeIntent?.navigation !== undefined;
        logPdfRenderTrace('navigation-destination-intent-cancelled', () => ({
            retainedPage: retainedNavigationAnchorPage.value,
            pendingPage: viewportAuthority.pendingTargetPage.value,
            currentPage: viewportAuthority.currentPage.value,
            activeIntentId: activeIntent?.id ?? null,
            activeIntentKind: activeIntent?.kind ?? null,
            activeIntentHasNavigation: activeIntent?.navigation !== undefined,
            hasDestinationDemand,
        }));
        if (!hasDestinationDemand) {
            return;
        }
        clearQueuedNavigation();
        // This boundary cancels a destination command, not the viewport
        // authority itself. Zoom/fit/resize intents own semantic anchors and
        // must survive reactive zoom-mode watchers; suspending one here leaves
        // the old pixel offset under new geometry and reinterprets page 7 as
        // page 1. Only an intent that actually carries navigation demand is a
        // destination eligible for cancellation.
        if (activeIntent?.navigation !== undefined) {
            viewportAuthority.suspend();
        }
    }
    function retireStaleViewportIntent(currentDocumentRevision: number) {
        const activeIntent = viewportAuthority.activeIntent.value;
        if (
            activeIntent === null
            || activeIntent.documentRevision === currentDocumentRevision
        ) {
            return false;
        }
        logPdfRenderTrace('navigation-stale-viewport-intent-retired', {
            intentId: activeIntent.id,
            kind: activeIntent.kind,
            intentDocumentRevision: activeIntent.documentRevision,
            currentDocumentRevision,
        });
        if (activeIntent.navigation !== undefined) {
            const staleNavigationSequence = activeNavigationSequence;
            if (
                staleNavigationSequence !== null
                && queuedNavigation?.sequence === staleNavigationSequence
            ) {
                clearQueuedNavigation();
            }
            // Preserve only a genuinely newer queued request for replay.
            activeNavigationSequence = null;
        }
        viewportAuthority.suspend();
        return true;
    }

    function handleWheel(event: IPdfSinglePageWheelEvent) {
        if (
            event.deltaY === 0
            || options.continuousScroll.value
            || Math.abs(event.deltaY) < Math.abs(event.deltaX)
        ) {
            return false;
        }
        const container = options.viewerContainer.value;
        if (!container) {
            return false;
        }
        const direction = resolveWheelDirection(event.deltaY);
        const bounds = getPageScrollBounds({
            container,
            pageNumber: viewportAuthority.currentPage.value,
            totalPages: options.numPages.value,
            viewMode: options.viewMode.value,
            scaledMargin: options.scaledMargin.value,
        });
        wheelFlipGate.recordWheelPacket(event.timeStamp, event.deltaY);
        if (bounds === null) {
            return false;
        }
        if (canScrollWithinPageBounds(container, bounds, direction)) {
            wheelFlipGate.recordInteriorScroll();
            return false;
        }
        if (wheelFlipGate.shouldBlockFlip(direction, event.timeStamp, {delta: event.deltaY})) {
            event.preventDefault();
            return true;
        }
        const desiredPage = wheelNavigationCursorPage.value
            ?? navigationAnchorPage.value
            ?? viewportAuthority.currentPage.value;
        const target = resolveWheelTargetPage(
            desiredPage,
            options.viewMode.value,
            options.numPages.value,
            direction,
        );
        if (target === desiredPage) {
            return false;
        }
        event.preventDefault();
        const submitted = submitPageNavigation(target, {navigationSource: 'wheel'});
        if (submitted) {
            wheelNavigationCursorPage.value = target;
            wheelFlipGate.recordFlip(direction, event.timeStamp, event.deltaY);
        }
        return submitted;
    }

    watch(viewportAuthority.currentPage, page => options.emitCurrentPage(page));
    watch(viewportAuthority.pendingTargetPage, page => options.emitNavigationFeedbackPage?.(page));

    watch(
        [
            options.requestedCurrentPage,
            options.numPages,
            options.viewerContainer,
        ],
        ([
            requested,
            ,
            ,
        ]) => {
            if (typeof requested === 'number' && Number.isFinite(requested)) {
                const requestedPage = options.numPages.value > 0
                    ? clamp(Math.trunc(requested), 1, options.numPages.value)
                    : Math.max(1, Math.trunc(requested));
                const pendingPage = queuedNavigation
                    ? getNavigationRequestPage(queuedNavigation.request)
                    : viewportAuthority.pendingAnchorPage.value;
                const shouldSubmit = navigationRuntimeReady.value
                    ? shouldSubmitRequestedCurrentPage(
                        requestedPage,
                        viewportAuthority.currentPage.value,
                        pendingPage,
                    )
                    // Pre-ready the prop carries the open surface's initial or
                    // restored page, but it is still an echo: explicit commands
                    // enter through submitPageNavigation, and the open's
                    // default page must never supersede a queued user command.
                    : pendingPage === null
                        && requestedPage !== viewportAuthority.currentPage.value;
                logPdfRenderTrace('navigation-requested-page-observed', () => ({
                    requested,
                    requestedPage,
                    currentPage: viewportAuthority.currentPage.value,
                    pendingPage,
                    shouldSubmit,
                    runtimeReady: navigationRuntimeReady.value,
                }));
                if (!shouldSubmit) {
                    return;
                }
                options.cancelPendingSearchScroll();
                submitPageNavigation(requestedPage);
            }
        },
        {
            flush: 'post',
            immediate: true,
        },
    );

    tryOnScopeDispose(() => {
        queuedNavigation = null;
        viewportAuthority.dispose();
        metricHydrator.dispose();
    });

    watch(navigationRuntimeReady, () => {
        // Metadata and the PDF document can become ready before layout
        // publishes its first geometry revision. Replay at the complete
        // operational boundary instead of waiting for unrelated state.
        replayQueuedNavigation();
    }, {
        flush: 'post',
        immediate: true,
    });
    watch(viewportAuthority.pendingTargetPage, (pendingTargetPage) => {
        retainedNavigationAnchorPage.value = resolveRetainedPdfNavigationAnchor({
            pendingTargetPage,
            retainedTargetPage: retainedNavigationAnchorPage.value,
            explicitCancel: false,
        });
    }, {
        flush: 'sync',
        immediate: true,
    });
    const navigationAnchorPage = computed(() => (
        viewportAuthority.pendingTargetPage.value
        ?? retainedNavigationAnchorPage.value
    ));
    const navigationState = computed(() => {
        const activeIntent = viewportAuthority.activeIntent.value;
        const targetPage = viewportAuthority.pendingTargetPage.value;
        if (!activeIntent || targetPage === null) {
            return createPdfNavigationMachineState(
                intentSequence,
                viewportAuthority.currentPage.value,
            );
        }
        const source = activeIntent.kind === 'search'
            ? 'search' as const
            : activeIntent.kind === 'wheel-page'
                ? 'wheel' as const
                : options.continuousScroll.value ? 'continuous' as const : 'paged' as const;
        const phase = viewportAuthority.phase.value;
        return {
            anchor: null,
            currentPage: viewportAuthority.currentPage.value,
            source,
            status: phase === 'applying' || phase === 'awaiting-visual'
                ? 'settling' as const
                : 'navigating' as const,
            targetPage,
            txn: intentSequence,
        };
    });
    const searchNavigationTargetPage = computed(() => viewportAuthority.activeIntent.value?.kind === 'search'
        ? viewportAuthority.pendingTargetPage.value
        : null);
    const searchNavigationState = computed(() => searchNavigationTargetPage.value === null ? 'idle' : 'navigating');
    const currentPageAuthority = {
        canSyncFromViewport: () => (
            viewportAuthority.activeIntent.value === null
            && options.isResizeTransitionActive?.value !== true
        ),
        commitViewportPage: (page: number) => {
            if (viewportAuthority.activeIntent.value !== null) {
                logPdfRenderTrace('viewport-current-page-commit-rejected', {
                    page,
                    activeIntentId: viewportAuthority.activeIntent.value.id,
                    activeIntentKind: viewportAuthority.activeIntent.value.kind,
                });
                return false;
            }
            const container = options.viewerContainer.value;
            const snapshot = refreshGeometry();
            const anchor = container && snapshot
                ? resolveAnchorForViewport(snapshot, page)
                : getRequestAnchor(undefined, page);
            viewportAuthority.observeUserScroll({
                ...anchor,
                page,
            });
            logPdfRenderTrace('viewport-current-page-commit-observed', () => ({
                page,
                anchorPage: anchor.page,
                scrollLeft: container?.scrollLeft ?? null,
                scrollTop: container?.scrollTop ?? null,
            }));
            if (container) options.viewportWritePort.observeUserScroll(container);
            return true;
        },
    };
    return {
        navigationState,
        currentPageAuthority,
        handleWheel,
        scrollToPage: submitPageNavigation,
        snapToPage: (page: number, _anchor?: unknown, scrollOptions?: IScrollToPageOptions) => submitPageNavigation(page, scrollOptions),
        beginSearchNavigation: (page: number) => submitPageNavigation(page, {navigationSource: 'search'}),
        revealSearchNavigationTarget: (page: number, scrollOptions?: IScrollToPageOptions) => submitPageNavigation(page, {
            ...scrollOptions,
            navigationSource: 'search',
        }),
        endSearchNavigation: () => undefined,
        cancelProgrammaticNavigation,
        cancelDestinationNavigationTarget,
        retireStaleViewportIntent,
        resetContinuousScrollState,
        viewportAuthority,
        submitNavigationRequest,
        submitViewportStateIntent,
        captureCurrentSemanticAnchor,
        applyResizeAnchorPreview,
        commitCurrentViewportPosition,
        commitCurrentViewportIfSettled,
        captureViewportCommitDiagnostics,
        navigationAnchorPage,
        pagedNavigationTargetPage: navigationAnchorPage,
        continuousNavigationTargetPage: computed(() => null),
        searchNavigationTargetPage,
        searchNavigationState,
        isProgrammaticNavigationActive: computed(() => viewportAuthority.phase.value !== 'idle'
            && viewportAuthority.phase.value !== 'settled'
            && viewportAuthority.phase.value !== 'cancelled'),
        shouldCancelProgrammaticNavigationForViewportScroll: () => (
            navigationAnchorPage.value === null
            && viewportAuthority.activeIntent.value === null
        ),
    };
};
