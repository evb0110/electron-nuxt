import {tryOnScopeDispose} from '@vueuse/core';
import {clamp} from 'es-toolkit/math';
import {createPdfNavigationMachineState} from '@app/modules/pdf-viewer/runtime/navigation/navigationMachine';
import type {IUsePdfSinglePageScrollOptions} from '@app/modules/pdf-viewer/runtime/navigation/pdfSinglePageScrollTypes';
import type {IScrollToPageOptions} from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/scrollToPageOptions';
import type {IPdfPageSlotRegistry} from '@app/modules/pdf-viewer/runtime/page-slots/pdfPageSlotRegistry';
import {
    createPdfViewportGeometryFromLayout,
    resolveAnchorFromScroll,
    resolveScrollForAnchor,
    type IPdfSemanticAnchor,
    type IPdfViewportGeometry,
} from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportGeometry';
import {
    createViewportAuthority as createViewportAuthorityService,
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

interface IUsePdfSinglePageNavigationControllerOptions extends IUsePdfSinglePageScrollOptions {
    requestedCurrentPage: Ref<number | undefined>;
    viewerContainer: Ref<HTMLElement | null>;
    cancelPendingSearchScroll: () => void;
    pageSlots: IPdfPageSlotRegistry;
    bindCurrentPageProjection?: ((projection: Readonly<Ref<number>>) => void) | undefined;
    getDocumentRevision: () => number;
    getGeometryRevision: () => number;
}

function getRequestPage(request: IPdfNavigationRequest | undefined, fallback: number) {
    const target = request?.target;
    return target && 'page' in target ? target.page : fallback;
}

function getRequestAnchor(request: IPdfNavigationRequest | undefined, fallbackPage: number): IPdfSemanticAnchor {
    const target = request?.target;
    const page = getRequestPage(request, fallbackPage);
    if (target?.kind === 'rect') {
        return {
            page,
            pageXFraction: target.rect.left + target.rect.width / 2,
            pageYFraction: target.rect.top + target.rect.height / 2,
            viewportXFraction: 0.5,
            viewportYFraction: 0.5,
            affinity: 'center',
        };
    }
    return {
        page,
        pageXFraction: 0.5,
        pageYFraction: 0,
        viewportXFraction: 0.5,
        viewportYFraction: 0,
        affinity: 'start',
    };
}

export function shouldSubmitRequestedCurrentPage(
    requestedPage: number,
    committedPage: number,
    pendingPage: number | null,
) {
    return requestedPage !== committedPage
        || (pendingPage !== null && pendingPage !== requestedPage);
}

/**
 * Production viewport authority adapter. Every navigation/scroll commit is
 * resolved from an immutable layout snapshot and written once by the authority.
 */
export const usePdfSinglePageNavigationController = (options: IUsePdfSinglePageNavigationControllerOptions) => {
    let intentSequence = 0;
    const wheelFlipGate = createWheelFlipGate();
    let geometry: IPdfViewportGeometry | null = null;
    const resolvedTargets = new Map<string, IResolvedPdfNavigationTarget>();

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

    const viewportAuthority = createViewportAuthorityService({
        getDocumentRevision: options.getDocumentRevision,
        getGeometryRevision: options.getGeometryRevision,
        awaitMetrics: async (intent) => {
            const resolved = intent.navigation
                ? await resolvePdfNavigationTarget(intent.navigation.target, options.pdfDocument.value)
                : null;
            if (resolved) resolvedTargets.set(intent.id, resolved);
            const page = resolved?.page ?? getRequestPage(intent.navigation, options.currentPage.value);
            await options.ensurePageMetricsInRange?.(page, page);
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
                : resolveScrollForAnchor(snapshot, anchor);
            return Promise.resolve({
                anchor,
                ...scroll,
                ...(intent.zoom === undefined ? {} : {zoom: intent.zoom}),
                ...(intent.viewMode === undefined ? {} : {viewMode: intent.viewMode}),
            });
        },
        refine: (intent, commit) => {
            const container = options.viewerContainer.value;
            const snapshot = geometry ?? refreshGeometry();
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
            const scroll = resolveScrollForAnchor(snapshot, anchor);
            if (request.alignment === 'keep-visible') {
                const centerAnchor = resolvePdfNavigationAnchor({
                    ...request,
                    alignment: 'rect-center',
                }, resolved);
                const center = resolveScrollForAnchor(snapshot, centerAnchor);
                const visible = Math.abs(center.left - container.scrollLeft) <= container.clientWidth / 2
                    && Math.abs(center.top - container.scrollTop) <= container.clientHeight / 2;
                if (visible) {
                    return Promise.resolve({
                        ...commit,
                        anchor: resolveAnchorFromScroll(snapshot, {
                            left: container.scrollLeft,
                            top: container.scrollTop,
                        }),
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
                ?? getRequestPage(intent.navigation, options.currentPage.value);
            const row = geometry?.rows.find(candidate => page >= candidate.startPage && page <= candidate.endPage);
            const start = row?.startPage ?? page;
            const end = row?.endPage ?? page;
            await options.renderVisiblePages({
                start,
                end,
            });
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
            options.viewportWritePort.apply(container, {
                intent: options.viewportWritePort.beginIntent(intent.id),
                reason: `viewport-authority:${intent.kind}`,
                left: commit.left,
                top: commit.top,
            });
        },
        awaitVisual: async (intent) => {
            const page = resolvedTargets.get(intent.id)?.page
                ?? getRequestPage(intent.navigation, options.currentPage.value);
            const row = geometry?.rows.find(candidate => page >= candidate.startPage && page <= candidate.endPage);
            await options.renderVisiblePages({
                start: row?.startPage ?? page,
                end: row?.endPage ?? page,
            });
            const container = options.viewerContainer.value;
            const readiness = intent.navigation?.readiness ?? 'page-canvas';
            if (container && !isPdfNavigationReady(
                container,
                page,
                readiness,
                options.isPageFreshlyRenderedForNavigation ?? (() => true),
            )) {
                throw new DOMException(`PDF navigation readiness not reached: ${readiness}`, 'AbortError');
            }
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

    function submitPageNavigation(pageNumber: number, scrollOptions?: IScrollToPageOptions) {
        const container = options.viewerContainer.value;
        if (!container || options.numPages.value <= 0) {
            return false;
        }
        const page = clamp(Math.trunc(pageNumber), 1, options.numPages.value);
        intentSequence += 1;
        const request = requestFor(page, scrollOptions);
        refreshGeometry();
        void viewportAuthority.submit({
            id: `viewport-navigation-${intentSequence}`,
            kind: request.source === 'search' ? 'search' : request.source === 'wheel' ? 'wheel-page' : 'navigate',
            documentRevision: options.getDocumentRevision(),
            geometryRevision: options.getGeometryRevision(),
            priority: 10,
            supersessionKey: 'navigation',
            navigation: request,
        });
        return true;
    }

    function submitNavigationRequest(request: IPdfNavigationRequest) {
        const container = options.viewerContainer.value;
        if (!container || options.numPages.value <= 0) {
            return false;
        }
        intentSequence += 1;
        refreshGeometry();
        void viewportAuthority.submit({
            id: `viewport-navigation-${intentSequence}`,
            kind: request.source === 'search' ? 'search' : request.source === 'wheel' ? 'wheel-page' : 'navigate',
            documentRevision: options.getDocumentRevision(),
            geometryRevision: options.getGeometryRevision(),
            priority: 10,
            supersessionKey: 'navigation',
            navigation: request,
        });
        return true;
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
        intentSequence += 1;
        const container = options.viewerContainer.value;
        const snapshot = refreshGeometry();
        const anchor = state.anchor ?? (container && snapshot && state.viewportPoint
            ? resolveAnchorFromScroll(snapshot, {
                left: container.scrollLeft,
                top: container.scrollTop,
            }, {
                x: state.viewportPoint.x / Math.max(1, container.clientWidth),
                y: state.viewportPoint.y / Math.max(1, container.clientHeight),
            })
            : viewportAuthority.committedAnchor.value
            ?? (container && snapshot
                ? resolveAnchorFromScroll(snapshot, {
                    left: container.scrollLeft,
                    top: container.scrollTop,
                })
                : getRequestAnchor(undefined, options.currentPage.value)));
        return viewportAuthority.submit({
            id: `viewport-state-${intentSequence}`,
            kind,
            documentRevision: options.getDocumentRevision(),
            geometryRevision: options.getGeometryRevision(),
            priority: 5,
            supersessionKey: 'viewport-state',
            anchor,
            ...(state.zoom === undefined ? {} : {zoom: state.zoom}),
            ...(state.viewMode === undefined ? {} : {viewMode: state.viewMode}),
            ...(state.dpr === undefined ? {} : {dpr: state.dpr}),
        });
    }

    function observeNativeUserScroll() {
        const container = options.viewerContainer.value;
        const snapshot = refreshGeometry();
        const anchor = container && snapshot
            ? resolveAnchorFromScroll(snapshot, {
                left: container.scrollLeft,
                top: container.scrollTop,
            })
            : getRequestAnchor(undefined, options.currentPage.value);
        viewportAuthority.observeUserScroll(anchor);
        if (container) options.viewportWritePort.observeUserScroll(container);
    }

    function captureCurrentSemanticAnchor() {
        const container = options.viewerContainer.value;
        const snapshot = refreshGeometry();
        return container && snapshot
            ? resolveAnchorFromScroll(snapshot, {
                left: container.scrollLeft,
                top: container.scrollTop,
            })
            : viewportAuthority.committedAnchor.value;
    }

    function cancelProgrammaticNavigation() {
        wheelFlipGate.reset();
        observeNativeUserScroll();
    }

    function consumeAuthorityScroll() {
        const container = options.viewerContainer.value;
        return container ? options.viewportWritePort.consumeAuthorityScroll(container) : false;
    }

    function handleScroll(event?: Event) {
        const container = options.viewerContainer.value;
        if (!container) {
            return;
        }
        if (consumeAuthorityScroll()) {
            options.updateVisibleRange(container, options.numPages.value);
            options.emitCurrentPage(viewportAuthority.currentPage.value);
            return;
        }
        // Scripted/synthetic scroll events are not evidence of user intent.
        if (!event || !event.isTrusted) {
            options.updateVisibleRange(container, options.numPages.value);
            options.emitCurrentPage(viewportAuthority.currentPage.value);
            return;
        }
        observeNativeUserScroll();
        options.updateVisibleRange(container, options.numPages.value);
        options.emitCurrentPage(viewportAuthority.currentPage.value);
    }

    function handleWheel(event: WheelEvent) {
        if (event.ctrlKey || options.continuousScroll.value || Math.abs(event.deltaY) < Math.abs(event.deltaX)) {
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
        if (wheelFlipGate.shouldBlockFlip(direction, event.timeStamp, {
            delta: event.deltaY,
            requireGestureIdle: true,
        })) {
            event.preventDefault();
            return true;
        }
        const target = resolveWheelTargetPage(
            viewportAuthority.currentPage.value,
            options.viewMode.value,
            options.numPages.value,
            direction,
        );
        if (target === viewportAuthority.currentPage.value) {
            return false;
        }
        event.preventDefault();
        const submitted = submitPageNavigation(target, {navigationSource: 'wheel'});
        if (submitted) {
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
        ([requested]) => {
            if (typeof requested === 'number' && Number.isFinite(requested)) {
                const requestedPage = clamp(Math.trunc(requested), 1, Math.max(1, options.numPages.value));
                const pendingPage = viewportAuthority.pendingTargetPage.value;
                if (!shouldSubmitRequestedCurrentPage(
                    requestedPage,
                    viewportAuthority.currentPage.value,
                    pendingPage,
                )) {
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

    tryOnScopeDispose(() => viewportAuthority.dispose());

    const navigationAnchorPage = viewportAuthority.pendingTargetPage;
    const navigationState = computed(() => createPdfNavigationMachineState(
        intentSequence,
        viewportAuthority.currentPage.value,
    ));
    const searchNavigationTargetPage = computed(() => viewportAuthority.activeIntent.value?.kind === 'search'
        ? viewportAuthority.pendingTargetPage.value
        : null);
    const searchNavigationState = computed(() => searchNavigationTargetPage.value === null ? 'idle' : 'navigating');
    const currentPageAuthority = {
        canSyncFromViewport: () => viewportAuthority.activeIntent.value === null,
        commitViewportPage: (page: number) => {
            if (viewportAuthority.activeIntent.value !== null) {
                return false;
            }
            const container = options.viewerContainer.value;
            const snapshot = refreshGeometry();
            const anchor = container && snapshot
                ? resolveAnchorFromScroll(snapshot, {
                    left: container.scrollLeft,
                    top: container.scrollTop,
                })
                : getRequestAnchor(undefined, page);
            viewportAuthority.observeUserScroll({
                ...anchor,
                page,
            });
            if (container) options.viewportWritePort.observeUserScroll(container);
            return true;
        },
    };
    return {
        navigationState,
        currentPageAuthority,
        handleWheel,
        handleScroll,
        consumeAuthorityScroll,
        scrollToPage: submitPageNavigation,
        snapToPage: (page: number, _anchor?: unknown, scrollOptions?: IScrollToPageOptions) => submitPageNavigation(page, scrollOptions),
        beginSearchNavigation: (page: number) => submitPageNavigation(page, {navigationSource: 'search'}),
        revealSearchNavigationTarget: (page: number, scrollOptions?: IScrollToPageOptions) => submitPageNavigation(page, {
            ...scrollOptions,
            navigationSource: 'search',
        }),
        endSearchNavigation: () => undefined,
        cancelProgrammaticNavigation,
        resetContinuousScrollState: cancelProgrammaticNavigation,
        viewportAuthority,
        submitNavigationRequest,
        submitViewportStateIntent,
        captureCurrentSemanticAnchor,
        navigationAnchorPage,
        pagedNavigationTargetPage: navigationAnchorPage,
        continuousNavigationTargetPage: computed(() => null),
        searchNavigationTargetPage,
        searchNavigationState,
        isProgrammaticNavigationActive: computed(() => viewportAuthority.phase.value !== 'idle'
            && viewportAuthority.phase.value !== 'settled'
            && viewportAuthority.phase.value !== 'cancelled'),
        shouldCancelProgrammaticNavigationForViewportScroll: () => true,
    };
};
