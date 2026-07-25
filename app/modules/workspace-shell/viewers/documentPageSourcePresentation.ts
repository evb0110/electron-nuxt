import type {
    IDocumentPageMetrics,
    IDocumentSurfaceLease,
    TDocumentRenderPriority,
    IDocumentPageSource,
} from '@app/utils/document-viewer/source/documentPageSource';
import type {
    IDocumentPageSourceTransition,
    IDocumentPageSourceFence,
    IDocumentPageSourceFeaturePackEmit,
} from '@app/modules/workspace-shell/viewers/documentPageSourceFeaturePackState';
import type { IDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import type { IDocumentViewerRenderSession } from '@app/utils/document-viewer/chassis/createDocumentViewerRenderCoordinator';
import type { IDocumentOpenSurfaceRenderOwner } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import {
    runDocumentViewerActivationPresentation,
    waitForDocumentViewerVisibleLayout,
} from '@app/utils/document-viewer/lifecycle/documentViewerActivationPresentation';
const DOCUMENT_RENDER_PRIORITY_RANK: Record<TDocumentRenderPriority, number> = {
    navigation: 5,
    visible: 4,
    nearby: 3,
    thumbnail: 2,
    prefetch: 1,
};
export interface IDocumentPageSourceVisualState {
    generation: number;
    error: string | null;
    ready: boolean;
    lease: IDocumentSurfaceLease | null;
    priority: TDocumentRenderPriority;
    retryCount: number;
    widthPx: number;
    unsubscribeInvalidation: (() => void) | null;
}
export const DOCUMENT_PAGE_SKELETON_PADDING = Object.freeze({
    bottom: 56,
    left: 56,
    right: 56,
    top: 56,
});
export type TDocumentPageSourceVisual = 'none' | 'skeleton' | 'fresh' | 'error';
export const isDocumentPageSourceSurfaceFresh = (ready: boolean, connected: boolean) => (
    ready && connected
);
export function resolveDocumentPageSourceRenderWidthPx(
    metrics: IDocumentPageMetrics,
    effectiveZoom: number,
    pixelRatio: number,
) {
    return Math.max(1, Math.round(metrics.widthPoints * effectiveZoom * pixelRatio));
}
export function isOwnedConnectedDocumentPageImage(
    image: HTMLImageElement,
    pageNumber: number,
    openingTarget: HTMLElement | null,
) {
    if (openingTarget) {
        return image.parentElement === openingTarget && openingTarget.isConnected;
    }
    const page = image.closest<HTMLElement>('[data-testid="document-page-source-page"]');
    return Boolean(page?.isConnected && page.dataset.pageNumber === String(pageNumber));
}
export function waitForDocumentPageImagePaint(image: HTMLImageElement, signal: AbortSignal) {
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
export function createDocumentPageSourcePresentation(options: {
    chassisAuthority: IDocumentViewerChassisAuthority | null;
    emit: IDocumentPageSourceFeaturePackEmit;
    ensureExactPageMetric: (
        source: IDocumentPageSource, generation: number, pageNumber: number,
        signal: AbortSignal, isCurrent: () => boolean,
    ) => Promise<IDocumentPageMetrics>;
    flushMetricPublication: () => void;
    hasPendingMetric: (pageNumber: number) => boolean;
    getOpeningTarget: (pageNumber: number) => HTMLElement | null;
    isFenceCurrent: (fence: IDocumentPageSourceFence) => boolean;
    openSurfaceRenderOwner: IDocumentOpenSurfaceRenderOwner | undefined;
    readContinuousScroll: () => boolean;
    readCurrentPage: () => number;
    readFence: () => IDocumentPageSourceFence;
    readIsActive: () => boolean;
    readLoadSignal: () => AbortSignal | null;
    readMetric: (pageNumber: number) => IDocumentPageMetrics | undefined;
    readPageScale: (pageNumber: number) => number;
    readPixelRatio: () => number;
    readRenderDemand: () => {
        bufferPages: readonly number[];
        residentPages: readonly number[];
        visiblePages: readonly number[];
    };
    readSource: () => IDocumentPageSource | null;
    readViewport: () => HTMLElement | null;
    readViewportScrollDirection: () => -1 | 0 | 1;
    renderSession: IDocumentViewerRenderSession | undefined;
    scheduleRender: () => void;
}) {
    const pageStates = shallowReactive(new Map<number, IDocumentPageSourceVisualState>());
    const renderControllers = new Map<number, AbortController>();
    let nextViewportRenderRequestId = 0;
    const beginPending = (_pageNumber: number, state: IDocumentPageSourceVisualState) => {
        state.error = null;
        state.ready = false;
    };
    const getSurface = (pageNumber: number) => {
        const surface = pageStates.get(pageNumber)?.lease?.surface;
        return typeof surface === 'string' ? surface : null;
    };
    const getRenderGeneration = (pageNumber: number) => pageStates.get(pageNumber)?.generation ?? '';
    const getConnectedImage = (pageNumber: number, state: IDocumentPageSourceVisualState) => {
        const openingTarget = options.getOpeningTarget(pageNumber);
        const candidates = openingTarget
            ? openingTarget.querySelectorAll<HTMLImageElement>('[data-testid="document-page-source-image"]')
            : options.readViewport()?.querySelectorAll<HTMLImageElement>('[data-testid="document-page-source-image"]');
        return [...(candidates ?? [])].find(image => (
            image.dataset.pageRenderGeneration === String(state.generation)
            && image.dataset.documentLoadGeneration === String(options.readFence().loadGeneration)
            && isOwnedConnectedDocumentPageImage(image, pageNumber, openingTarget)
            && image.complete
            && image.naturalWidth > 0
        )) ?? null;
    };
    const getVisual = (pageNumber: number) => {
        const state = pageStates.get(pageNumber);
        const connected = Boolean(state && getConnectedImage(pageNumber, state));
        const pending: TDocumentPageSourceVisual = options.readFence().src === null ? 'none' : 'skeleton';
        if (state?.error) {
            return 'error';
        }
        const visual = options.chassisAuthority?.openSurface.viewportSession.value.visual;
        if (visual?.kind === 'page' && visual.pageNumber === pageNumber) {
            if (visual.presentation === 'error') {
                return 'error';
            }
            if (visual.presentation === 'canvas' && connected) {
                return 'fresh';
            }
            return visual.presentation === 'skeleton' ? 'skeleton' : pending;
        }
        return isDocumentPageSourceSurfaceFresh(Boolean(state?.ready), connected) ? 'fresh' : pending;
    };
    const getVisualError = (pageNumber: number) => {
        const viewportVisual = options.chassisAuthority?.openSurface.viewportSession.value.visual;
        return pageStates.get(pageNumber)?.error
            ?? (viewportVisual?.kind === 'page' && viewportVisual.pageNumber === pageNumber
                ? viewportVisual.error
                : null)
            ?? `Unable to display page ${String(pageNumber)}`;
    };
    function commitTerminalError(pageNumber: number) {
        const lifecycleFence = options.readFence();
        let state = pageStates.get(pageNumber);
        if (!state) {
            state = shallowReactive<IDocumentPageSourceVisualState>({
                generation: lifecycleFence.loadGeneration,
                error: null,
                ready: false,
                lease: null,
                priority: 'navigation',
                retryCount: 0,
                widthPx: 0,
                unsubscribeInvalidation: null,
            });
            pageStates.set(pageNumber, state);
        }
        state.unsubscribeInvalidation?.();
        state.lease?.release();
        state.unsubscribeInvalidation = null;
        state.lease = null;
        const message = `Unable to display page ${String(pageNumber)}`;
        state.error = message;
        state.ready = false;
        const openSurface = options.chassisAuthority?.openSurface;
        const snapshot = openSurface?.snapshot.value;
        const viewportState = openSurface?.viewportSession.value;
        const surfaceGeneration = lifecycleFence.openSurfaceGeneration;
        if (
            openSurface
            && snapshot
            && viewportState?.requestedPage === pageNumber
            && surfaceGeneration !== null
            && snapshot.generation === surfaceGeneration
        ) {
            if (viewportState.lifecycle === 'transitioning') {
                const navigationFence = options.openSurfaceRenderOwner
                    && openSurface.createOwnedRenderFence(options.openSurfaceRenderOwner, {
                        generation: surfaceGeneration,
                        documentRevision: snapshot.identity?.documentRevision ?? '',
                        rendererVersion: lifecycleFence.loadGeneration,
                        rendererRequestId: ++nextViewportRenderRequestId,
                        pageNumber,
                    });
                if (navigationFence) {
                    openSurface.reject(navigationFence, message);
                }
            } else if (snapshot.committedRender?.pageNumber === pageNumber) {
                openSurface.reject(snapshot.committedRender, message);
            } else {
                openSurface.fail(surfaceGeneration, message);
            }
        }
        return message;
    }
    function commitReady(pageNumber: number, state: IDocumentPageSourceVisualState) {
        const lifecycleFence = options.readFence();
        const openSurface = options.chassisAuthority?.openSurface;
        const snapshot = openSurface?.snapshot.value;
        const viewportState = openSurface?.viewportSession.value;
        const image = getConnectedImage(pageNumber, state);
        if (
            !state.ready
            || !image
            || pageStates.get(pageNumber) !== state
            || !openSurface
            || !snapshot
            || !viewportState
            || lifecycleFence.openSurfaceGeneration === null
            || snapshot.generation !== lifecycleFence.openSurfaceGeneration
            || viewportState.requestedPage !== pageNumber
            || viewportState.viewportIntent?.pageNumber !== pageNumber
            || ![
                'opening',
                'transitioning',
            ].includes(viewportState.lifecycle)
        ) {
            return false;
        }
        const fence = options.openSurfaceRenderOwner
            && openSurface.createOwnedRenderFence(options.openSurfaceRenderOwner, {
                generation: lifecycleFence.openSurfaceGeneration,
                documentRevision: snapshot.identity?.documentRevision ?? '',
                rendererVersion: lifecycleFence.loadGeneration,
                rendererRequestId: ++nextViewportRenderRequestId,
                pageNumber,
            });
        const viewport = options.readViewport();
        return Boolean(
            fence
            && openSurface.commitCanvas(fence)
            && viewport
            && openSurface.commitViewport({
                generation: lifecycleFence.openSurfaceGeneration,
                documentRevision: fence.documentRevision,
                viewportIntentId: viewportState.viewportIntent.id,
                documentGeometryRevision: lifecycleFence.loadGeneration,
                interactionEpoch: 0,
                pageNumber,
                left: viewport.scrollLeft,
                top: viewport.scrollTop,
            })
            && openSurface.markReady(fence),
        );
    }
    function markReady(pageNumber: number, state: IDocumentPageSourceVisualState) {
        const initialOpen = options.chassisAuthority?.openSurface.viewportSession.value.lifecycle === 'opening';
        state.ready = true;
        state.error = null;
        state.retryCount = 0;
        const committed = commitReady(pageNumber, state);
        if (committed && initialOpen) {
            options.emit('initial-visual-ready', {pageNumber});
        }
        return committed;
    }
    async function renderPage(pageNumber: number) {
        const activeSource = options.readSource();
        const fence = options.readFence();
        const loadSignal = options.readLoadSignal();
        const currentPage = options.readCurrentPage();
        const isCurrent = () => (
            options.isFenceCurrent(fence)
            && options.readIsActive()
            && options.readSource() === activeSource
            && loadSignal?.aborted === false
        );
        if (!activeSource || !loadSignal || !options.readIsActive()) {
            return;
        }
        const demand = options.readRenderDemand();
        const direction = options.readViewportScrollDirection();
        const leading = options.readContinuousScroll()
            && direction !== 0
            && demand.bufferPages.includes(pageNumber)
            && Math.sign(pageNumber - currentPage) === direction;
        const priority: TDocumentRenderPriority = pageNumber === (
            options.chassisAuthority?.openSurface.viewportSession.value.requestedPage ?? currentPage
        )
            ? 'navigation'
            : demand.visiblePages.includes(pageNumber) || leading ? 'visible' : 'nearby';
        try {
            await options.ensureExactPageMetric(
                activeSource,
                fence.loadGeneration,
                pageNumber,
                loadSignal,
                isCurrent,
            );
            if (!isCurrent()) {
                return;
            }
            options.flushMetricPublication();
            await nextTick();
            if (!isCurrent()) {
                return;
            }
        } catch (error) {
            if (!(error instanceof DOMException && error.name === 'AbortError') && isCurrent()) {
                const message = commitTerminalError(pageNumber);
                if (pageNumber === options.readCurrentPage()) {
                    options.emit('loadError', error instanceof Error ? error : new Error(message));
                }
            }
            return;
        }
        if (options.hasPendingMetric(pageNumber)) {
            options.flushMetricPublication();
        }
        const metric = options.readMetric(pageNumber);
        if (!metric || !isCurrent()) {
            return;
        }
        const widthPx = resolveDocumentPageSourceRenderWidthPx(
            metric,
            options.readPageScale(pageNumber),
            options.readPixelRatio(),
        );
        const previous = pageStates.get(pageNumber);
        const activeController = renderControllers.get(pageNumber);
        if (previous?.widthPx === widthPx && previous.lease) {
            if (DOCUMENT_RENDER_PRIORITY_RANK[priority] > DOCUMENT_RENDER_PRIORITY_RANK[previous.priority]) {
                previous.lease.promotePriority?.(priority);
                previous.priority = priority;
            }
            if (!previous.ready && getConnectedImage(pageNumber, previous)) {
                markReady(pageNumber, previous);
            }
            if (previous.ready && priority === 'navigation') {
                void nextTick(() => commitReady(pageNumber, previous));
            }
            return;
        }
        if (previous?.widthPx === widthPx && activeController) {
            return;
        }
        activeController?.abort();
        const preserveExistingVisual = Boolean(previous?.lease && getConnectedImage(pageNumber, previous));
        if (previous && preserveExistingVisual && priority === 'navigation') {
            commitReady(pageNumber, previous);
        }
        if (previous && !preserveExistingVisual) {
            previous.unsubscribeInvalidation?.();
            previous.lease?.release();
            previous.unsubscribeInvalidation = null;
            previous.lease = null;
            beginPending(pageNumber, previous);
        }
        const renderController = new AbortController();
        renderControllers.set(pageNumber, renderController);
        let attemptGeneration: number | null = null;
        try {
            const outcome = await options.renderSession?.runPageRender(pageNumber, async (renderGeneration) => {
                attemptGeneration = renderGeneration;
                const nextState = previous && preserveExistingVisual
                    ? previous
                    : shallowReactive<IDocumentPageSourceVisualState>({
                        generation: renderGeneration,
                        error: null,
                        ready: false,
                        lease: null,
                        priority,
                        retryCount: 0,
                        widthPx,
                        unsubscribeInvalidation: null,
                    });
                if (!preserveExistingVisual) {
                    pageStates.set(pageNumber, nextState);
                    beginPending(pageNumber, nextState);
                }
                await nextTick();
                if (!isCurrent() || renderController.signal.aborted) {
                    throw new DOMException('Superseded page render', 'AbortError');
                }
                return activeSource.renderPage({
                    pageNumber,
                    widthPx,
                    priority,
                    signal: renderController.signal,
                });
            });
            if (!outcome) {
                return;
            }
            if (!isCurrent()) {
                outcome.value.release();
                return;
            }
            const {
                generation: renderGeneration,
                value: lease,
            } = outcome;
            try {
                renderController.signal.throwIfAborted();
                if (typeof lease.surface === 'string') {
                    const image = new Image();
                    image.decoding = 'async';
                    image.src = lease.surface;
                    await image.decode().catch((error: unknown) => {
                        if (!image.complete || image.naturalWidth <= 0) {
                            throw error;
                        }
                    });
                }
                renderController.signal.throwIfAborted();
            } catch (error) {
                lease.release();
                throw error;
            }
            const current = pageStates.get(pageNumber);
            if (
                !outcome.committed
                || !isCurrent()
                || renderControllers.get(pageNumber) !== renderController
                || !current
                || (preserveExistingVisual
                    ? current !== previous
                    : current.generation !== renderGeneration)
            ) {
                lease.release();
                return;
            }
            const previousLease = current.lease;
            current.unsubscribeInvalidation?.();
            current.generation = renderGeneration;
            current.error = null;
            current.lease = lease;
            current.priority = priority;
            current.widthPx = widthPx;
            current.unsubscribeInvalidation = lease.onInvalidated?.(() => {
                const invalidated = pageStates.get(pageNumber);
                if (invalidated !== current) {
                    return;
                }
                invalidated.unsubscribeInvalidation?.();
                invalidated.unsubscribeInvalidation = null;
                invalidated.lease = null;
                beginPending(pageNumber, invalidated);
                if (invalidated.priority !== 'nearby') {
                    options.scheduleRender();
                }
            }) ?? null;
            previousLease?.release();
        } catch (error) {
            const current = pageStates.get(pageNumber);
            if (
                renderControllers.get(pageNumber) === renderController
                && options.readSource() === activeSource
                && (preserveExistingVisual
                    ? current === previous
                    : current?.generation === attemptGeneration)
                && !(error instanceof DOMException && error.name === 'AbortError')
            ) {
                if (current && current.retryCount < 2) {
                    current.retryCount += 1;
                    if (!preserveExistingVisual) {
                        beginPending(pageNumber, current);
                    }
                    options.scheduleRender();
                } else if (!preserveExistingVisual) {
                    commitTerminalError(pageNumber);
                    if (pageNumber === options.readCurrentPage()) {
                        options.emit('loadError', error);
                    }
                } else if (pageNumber === options.readCurrentPage()) {
                    options.emit('loadError', error);
                }
            }
        } finally {
            if (renderControllers.get(pageNumber) === renderController) {
                renderControllers.delete(pageNumber);
                options.scheduleRender();
            }
        }
    }
    async function handleSurfaceLoad(pageNumber: number, surface: string, event: Event) {
        let state = pageStates.get(pageNumber);
        const image = event.currentTarget;
        const fence = options.readFence();
        const expectedRenderGeneration = state?.generation ?? null;
        if (
            !(image instanceof HTMLImageElement)
            || state?.lease?.surface !== surface
            || image.dataset.pageRenderGeneration !== String(expectedRenderGeneration)
            || image.dataset.documentLoadGeneration !== String(fence.loadGeneration)
            || image.dataset.openSurfaceGeneration !== String(fence.openSurfaceGeneration ?? '')
            || !isOwnedConnectedDocumentPageImage(image, pageNumber, options.getOpeningTarget(pageNumber))
        ) {
            return;
        }
        const controller = renderControllers.get(pageNumber) ?? new AbortController();
        if (!await waitForDocumentPageImagePaint(image, controller.signal)) {
            return;
        }
        state = pageStates.get(pageNumber);
        if (
            !options.isFenceCurrent(fence)
            || !options.readIsActive()
            || state?.generation !== expectedRenderGeneration
            || state.lease?.surface !== surface
            || !image.isConnected
            || !isOwnedConnectedDocumentPageImage(image, pageNumber, options.getOpeningTarget(pageNumber))
        ) {
            return;
        }
        markReady(pageNumber, state);
    }
    function handleSurfaceError(pageNumber: number, surface: string, event: Event) {
        const state = pageStates.get(pageNumber);
        const image = event.currentTarget;
        const fence = options.readFence();
        if (
            !(image instanceof HTMLImageElement)
            || state?.lease?.surface !== surface
            || image.dataset.pageRenderGeneration !== String(state.generation)
            || image.dataset.documentLoadGeneration !== String(fence.loadGeneration)
            || image.dataset.openSurfaceGeneration !== String(fence.openSurfaceGeneration ?? '')
            || !isOwnedConnectedDocumentPageImage(image, pageNumber, options.getOpeningTarget(pageNumber))
        ) {
            return;
        }
        state.unsubscribeInvalidation?.();
        state.lease.release();
        state.unsubscribeInvalidation = null;
        state.lease = null;
        if (state.retryCount >= 2) {
            const message = commitTerminalError(pageNumber);
            if (pageNumber === options.readCurrentPage()) {
                options.emit('loadError', new Error(message));
            }
            return;
        }
        state.retryCount += 1;
        beginPending(pageNumber, state);
        void renderPage(pageNumber);
    }
    function releasePage(pageNumber: number) {
        renderControllers.get(pageNumber)?.abort();
        renderControllers.delete(pageNumber);
        const state = pageStates.get(pageNumber);
        state?.unsubscribeInvalidation?.();
        state?.lease?.release();
        pageStates.delete(pageNumber);
        options.renderSession?.releasePage(pageNumber);
    }
    async function restore(
        transition: IDocumentPageSourceTransition,
        restoreOptions: {
            measureViewport: () => void;
            renderMountedPages: () => Promise<void>;
        },
    ) {
        const isCurrent = transition.isCurrent;
        await runDocumentViewerActivationPresentation({
            isCurrent,
            waitForVisibleLayout: () => waitForDocumentViewerVisibleLayout(
                options.readViewport,
                {isCurrent},
            ),
            measure: restoreOptions.measureViewport,
            reconcile: async () => {
                const currentPage = options.readCurrentPage();
                for (const pageNumber of new Set([
                    currentPage,
                    ...options.readRenderDemand().residentPages,
                ])) {
                    if (!isCurrent()) {
                        return;
                    }
                    const state = pageStates.get(pageNumber);
                    if (!state?.lease) {
                        continue;
                    }
                    const image = getConnectedImage(pageNumber, state);
                    const metric = options.readMetric(pageNumber);
                    if (image?.complete && image.naturalWidth > 0) {
                        if (metric && state.widthPx === resolveDocumentPageSourceRenderWidthPx(
                            metric,
                            options.readPageScale(pageNumber),
                            options.readPixelRatio(),
                        )) {
                            markReady(pageNumber, state);
                        }
                        continue;
                    }
                    if (!isCurrent()) {
                        return;
                    }
                    state.unsubscribeInvalidation?.();
                    state.lease.release();
                    state.unsubscribeInvalidation = null;
                    state.lease = null;
                    beginPending(pageNumber, state);
                }
                if (!isCurrent()) {
                    return;
                }
                await renderPage(currentPage);
                if (isCurrent()) {
                    await restoreOptions.renderMountedPages();
                }
            },
        });
    }
    return {
        beginSourceGeneration() {
            renderControllers.forEach(controller => controller.abort());
            renderControllers.clear();
            for (const pageNumber of [...pageStates.keys()]) {
                releasePage(pageNumber);
            }
        },
        commitReady,
        commitTerminalError,
        dispose() {
            for (const pageNumber of [...pageStates.keys()]) {
                releasePage(pageNumber);
            }
        },
        getConnectedImage,
        getRenderGeneration,
        getState: (pageNumber: number) => pageStates.get(pageNumber),
        getSurface,
        getVisual,
        getVisualError,
        handleSurfaceError,
        handleSurfaceLoad,
        markReady,
        pageStates,
        releasePage,
        renderControllers,
        renderPage,
        restore,
    };
}
