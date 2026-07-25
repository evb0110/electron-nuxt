// @vitest-environment happy-dom

import {
    computed,
    createApp,
    defineComponent,
    readonly,
    ref,
    shallowReadonly,
    shallowRef,
} from 'vue';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IPageRange } from '@app/types/pdfUi';
import type { IPdfDocumentTransition } from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import type { IPdfViewportDemand } from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import { createPdfPageRasterScheduler } from '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler';

const rendererFixture = vi.hoisted(() => {
    const api = {
        applySearchHighlights: vi.fn(),
        cancelPendingSearchScroll: vi.fn(),
        cleanupAllPages: vi.fn(async () => undefined),
        hideManagedAnnotationEditors: vi.fn(),
        releaseUnmountedPage: vi.fn(),
        renderAnnotationEditorLayerForPage: vi.fn(),
        renderCommittedPageLayers: vi.fn(async () => undefined),
        renderLayerPromotions: vi.fn(async () => undefined),
        resolveCanvasHiddenAnnotationIds: vi.fn(() => new Set<string>()),
        requestScrollToCurrentResult: vi.fn(),
    };
    return {
        api,
        options: null as Record<string, unknown> | null,
    };
});

const canvasFixture = vi.hoisted(() => ({
    prepare: vi.fn(),
    mount: vi.fn(),
    cleanup: vi.fn(),
    cleanupResult: vi.fn((result: {canvas: HTMLCanvasElement}) => result.canvas.remove()),
}));

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    diagnostic: vi.fn(),
    diagnosticThrottled: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    warnThrottled: vi.fn(),
    debug: vi.fn(),
}}));
vi.mock('@app/utils/startupMetrics', () => ({markStartupMetricOnce: vi.fn()}));
vi.mock('@app/utils/pdfRenderTrace', () => ({logPdfRenderTrace: vi.fn()}));
vi.mock('@app/modules/pdf-viewer/runtime/rendering/usePdfPageRenderer', () => ({usePdfPageRenderer: vi.fn((options: Record<string, unknown>) => {
    rendererFixture.options = options;
    return rendererFixture.api;
})}));
vi.mock('@app/modules/pdf-viewer/runtime/composables/pdf/usePdfCanvasRenderer', () => ({usePdfCanvasRenderer: () => ({
    prepareCanvasRender: canvasFixture.prepare,
    applyContainerUserUnit: vi.fn(),
    mountCanvas: canvasFixture.mount,
    cleanupCanvas: canvasFixture.cleanup,
    cleanupCanvasRenderResult: canvasFixture.cleanupResult,
})}));
vi.mock('@app/modules/pdf-viewer/runtime/composables/usePdfViewerRerenderCoordinator', () => ({usePdfViewerRerenderCoordinator: vi.fn(() => ({reRenderVisiblePagesAndSyncCurrentPage: vi.fn(async () => undefined)}))}));
vi.mock('@app/modules/pdf-viewer/runtime/composables/usePdfViewerResizeLifecycle', () => ({usePdfViewerResizeLifecycle: vi.fn(() => ({
    buildResizeAnchorContext: vi.fn(() => null),
    beginResizeTransition: vi.fn(),
    captureResizeVisualSnapshots: vi.fn(),
    scheduleEndResizeTransition: vi.fn(),
    cleanupResizeLifecycle: vi.fn(),
}))}));
vi.mock('@app/modules/pdf-viewer/runtime/composables/usePdfViewerZoomRerenderQueue', () => ({usePdfViewerZoomRerenderQueue: vi.fn(() => ({
    scheduleResizeAwareRerender: vi.fn(),
    enqueueZoomSync: vi.fn(),
    resetZoomRerenderQueueState: vi.fn(),
    cleanupZoomRerenderQueue: vi.fn(),
}))}));
vi.mock('@app/modules/pdf-viewer/runtime/composables/usePdfViewerRenderStallRecovery', () => ({usePdfViewerRenderStallRecovery: vi.fn(() => ({
    resetRenderStallRecoveryState: vi.fn(),
    invalidatePages: vi.fn(),
    consumePendingInvalidation: vi.fn(() => null),
    handlePageRenderStall: vi.fn(),
}))}));
vi.mock('@app/modules/pdf-viewer/runtime/composables/usePdfViewerInitialRenderRecovery', () => ({usePdfViewerInitialRenderRecovery: vi.fn(() => ({scheduleRecoverInitialRender: vi.fn()}))}));
vi.mock('@app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerActivationRestore', () => ({usePdfViewerActivationRestore: vi.fn(() => ({
    nextActivationRestoreRunId: vi.fn(() => 1),
    isActivationRunCurrent: vi.fn(() => true),
    renderActiveDocumentAfterActivation: vi.fn(async () => undefined),
}))}));

const {createPdfRenderingSession} = await import(
    '@app/modules/pdf-viewer/runtime/sessions/createPdfRenderingSession'
);

function createTransition(
    phase: IPdfDocumentTransition['phase'],
    plan: Partial<IPdfDocumentTransition['plan']> = {},
): IPdfDocumentTransition {
    return {
        phase,
        fence: {
            loadToken: 7,
            documentVersion: 9,
            documentRevision: 'revision-7',
            openSurfaceGeneration: 11,
        },
        plan: {
            isReload: false,
            isSelectiveReload: false,
            pagesToInvalidate: null,
            preserveVisibleContent: false,
            preservePageStructure: false,
            ...plan,
        },
        reason: 'test',
        isCurrent: () => true,
    };
}

function createRenderingFixture(fixtureOptions: {autoResolve?: boolean} = {}) {
    const subscribers: Array<(transition: IPdfDocumentTransition) => void | Promise<void>> = [];
    const disposables: Array<() => void | Promise<void>> = [];
    const currentPage = ref(3);
    const demand = shallowRef<IPdfViewportDemand>({
        revision: 1,
        visibleRange: {
            start: 3,
            end: 3,
        },
        requiredPages: [3],
        nearbyPages: [],
        residentPages: [3],
        mountedPages: [3],
        currentPage: 3,
        destinationPage: null,
        operational: true,
        mandatoryRaster: {
            id: 1,
            range: {
                start: 3,
                end: 3,
            },
            options: {bufferOverride: 0},
        },
    });
    const cancelRasterRevision = ref(0);
    const cancelPendingSearchRevision = ref(0);
    const visualReadySignal = shallowRef({
        revision: 0,
        pageNumber: 0,
    });
    const navigationCommittedSignal = shallowRef({
        revision: 0,
        pageNumber: 0,
    });
    const settleMandatoryRaster = vi.fn();
    const viewport = {
        currentPage,
        visibleRange: ref<IPageRange>({
            start: 3,
            end: 3,
        }),
        demand: shallowReadonly(demand),
        cancelRasterRevision: readonly(cancelRasterRevision),
        cancelPendingSearchRevision: readonly(cancelPendingSearchRevision),
        visualReadySignal: shallowReadonly(visualReadySignal),
        navigationCommittedSignal: shallowReadonly(navigationCommittedSignal),
        userViewportInteractionEpoch: ref(0),
        pageSlots: {isMounted: vi.fn((page: number) => page === 3)},
        settleMandatoryRaster,
        notifyRenderStateChanged: vi.fn(),
        scale: {
            effectiveScale: ref(1),
            computeFitWidthScale: vi.fn(),
        },
        transactionController: {
            activeTransaction: ref(null),
            beginTransaction: vi.fn(() => ({id: 1})),
            isTransactionCurrent: vi.fn(() => true),
            advanceTransaction: vi.fn(),
            cancelActiveTransaction: vi.fn(),
        },
        scroll: {
            getVisiblePageRange: vi.fn(() => ({
                start: 3,
                end: 3,
            })),
            updateVisibleRange: vi.fn(),
            getMostVisiblePage: vi.fn(() => 3),
        },
        singlePageScroll: {
            scrollToPage: vi.fn(),
            beginSearchNavigation: vi.fn(),
            revealSearchNavigationTarget: vi.fn(),
            endSearchNavigation: vi.fn(),
            navigationAnchorPage: ref(null),
            pagedNavigationTargetPage: ref(null),
            resetContinuousScrollState: vi.fn(),
            cancelDestinationNavigationTarget: vi.fn(),
            submitViewportStateIntent: vi.fn(),
        },
        summarizeViewerMetricsForLog: vi.fn(),
        summarizeVisiblePageSnapshotForLog: vi.fn(),
        syncCurrentPageFromViewport: vi.fn(async () => undefined),
        getVisibleRange: vi.fn(() => ({
            start: 3,
            end: 3,
        })),
        commitVisibleRange: vi.fn(),
        setupPagePlaceholders: vi.fn(),
        viewModel: {syncHorizontalScrollForZoomMode: vi.fn()},
        viewportWritePort: {},
        handleResizeTransitionSignal: vi.fn(),
        isVisibleRenderRangeCurrent: vi.fn(() => true),
        getProtectedVisibleRange: vi.fn(() => ({
            start: 3,
            end: 3,
        })),
    };
    const renderTasks: Array<{
        cancel: ReturnType<typeof vi.fn>;
        resolve: () => void;
        reject: (error: unknown) => void;
    }> = [];
    const pdfPage = {
        pageNumber: 3,
        getViewport: vi.fn(({scale}: {scale: number}) => ({
            width: 100 * scale,
            height: 120 * scale,
            userUnit: 1,
            rawDims: {
                pageWidth: 100,
                pageHeight: 120,
            },
        })),
        render: vi.fn(() => {
            const deferred = Promise.withResolvers<undefined>();
            const cancel = vi.fn(() => deferred.reject(Object.assign(
                new Error('cancelled'),
                {name: 'RenderingCancelledException'},
            )));
            renderTasks.push({
                cancel,
                resolve: () => deferred.resolve(undefined),
                reject: deferred.reject,
            });
            if (fixtureOptions.autoResolve !== false) {
                deferred.resolve(undefined);
            }
            return {
                cancel,
                promise: deferred.promise,
            };
        }),
    };
    const pdfDocument = {numPages: 5};
    const leasePage = vi.fn(async () => ({
        page: pdfPage,
        release: vi.fn(),
    }));
    const rasterScheduler = createPdfPageRasterScheduler({
        documentFence: {
            loadToken: 7,
            documentVersion: 9,
            documentRevision: 'revision-7',
        },
        leasePage: leasePage as never,
    });
    const documentSession = {
        pdfDocument: shallowRef(pdfDocument),
        acceptedSource: shallowRef(new Blob(['pdf'], {type: 'application/pdf'})),
        isLoading: ref(false),
        numPages: ref(5),
        basePageWidth: ref(100),
        basePageHeight: ref(120),
        pageMetrics: ref(Array.from({length: 5}, () => ({
            width: 100,
            height: 120,
            rotation: 0,
            userUnit: 1,
        }))),
        rasterScheduler,
        openSurfaceGeneration: 11,
        openSurfaceRevision: 'revision-7',
        getRenderVersion: () => 9,
        captureFence: () => createTransition('ready').fence,
        ensurePageMetricsInRange: vi.fn(async () => true),
        leasePage,
        evictPage: vi.fn(),
        cleanupPageCache: vi.fn(),
        invalidatePagesOnNextReload: vi.fn(),
        scheduleLoad: vi.fn(),
        subscribe(callback: (transition: IPdfDocumentTransition) => void | Promise<void>) {
            subscribers.push(callback);
            return () => undefined;
        },
        registerDisposable(dispose: () => void | Promise<void>) {
            disposables.push(dispose);
        },
    };
    const viewerElement = document.createElement('div');
    const viewerContainer = ref<HTMLElement | null>(viewerElement);
    const outputScale = ref(1);
    const page = document.createElement('div');
    page.className = 'page_container';
    page.dataset.page = '3';
    const canvasSurface = document.createElement('div');
    canvasSurface.className = 'page_canvas';
    const canvasHost = document.createElement('div');
    canvasHost.className = 'page_canvas__render-layer';
    canvasSurface.append(canvasHost);
    page.append(
        canvasSurface,
        Object.assign(document.createElement('div'), {className: 'text-layer'}),
        Object.assign(document.createElement('div'), {className: 'annotation-layer'}),
        Object.assign(document.createElement('div'), {className: 'annotation-editor-layer'}),
    );
    viewerElement.append(page);
    document.body.append(viewerElement);
    canvasFixture.prepare.mockImplementation(async (pageProxy: typeof pdfPage, scale: number) => {
        const canvas = document.createElement('canvas');
        canvas.width = 100;
        canvas.height = 120;
        return {
            canvas,
            viewport: pageProxy.getViewport({scale}),
            annotationCanvasMap: new Map(),
            scaleX: 1,
            scaleY: 1,
            rawDims: {
                pageWidth: 100,
                pageHeight: 120,
            },
            requestedPixels: 12_000,
            grantedPixels: 12_000,
            pixelScaleFactor: 1,
            wasClamped: false,
            userUnit: 1,
            totalScaleFactor: scale,
            startRender: () => pageProxy.render(),
        };
    });
    const emitInitialVisualReady = vi.fn();
    let rendering: ReturnType<typeof createPdfRenderingSession> | undefined;
    const root = document.createElement('div');
    const app = createApp(defineComponent({
        name: 'PdfRenderingSessionBehaviorFixture',
        setup() {
            rendering = createPdfRenderingSession({
                document: documentSession as never,
                viewport: viewport as never,
                chassisAuthority: null,
                openSurfaceRenderOwner: undefined,
                performancePolicy: {clampedVisibleRefineMode: 'immediate'} as never,
                viewerContainer,
                isActive: computed(() => true),
                isResizing: computed(() => false),
                isAnySaving: computed(() => false),
                zoom: computed(() => 1),
                zoomMode: computed(() => 'fit-width'),
                fitMode: computed(() => 'width'),
                viewMode: computed(() => 'single'),
                continuousScroll: computed(() => true),
                outputScale,
                rasterDisplayProfile: computed(() => null),
                bufferPages: computed(() => 0),
                showAnnotations: computed(() => true),
                searchPageMatches: computed(() => new Map()),
                currentSearchMatch: computed(() => null),
                currentSearchMatchNavigationId: computed(() => 0),
                workingCopyPath: computed(() => null),
                documentRevisionToken: computed(() => null),
                maxBufferCanvasPixels: 1_000,
                consumeZoomViewportAnchor: () => null,
                isZoomInteractionLocked: () => false,
                setZoomRerenderBusy: vi.fn(),
                markDelayedSkeletonPageRendered: vi.fn(),
                emitInitialVisualReady,
                emitLoadError: vi.fn(),
            });
            return () => null;
        },
    }));
    app.mount(root);
    if (!rendering) {
        throw new Error('Failed to create PDF rendering session fixture');
    }
    return {
        app,
        demand,
        disposables,
        emitInitialVisualReady,
        navigationCommittedSignal,
        rendering,
        renderTasks,
        rasterScheduler,
        documentSession,
        pdfPage,
        canvasHost,
        outputScale,
        settleMandatoryRaster,
        subscribers,
        viewerContainer,
        async emit(transition: IPdfDocumentTransition) {
            for (const subscriber of subscribers) {
                await subscriber(transition);
            }
        },
        async dispose() {
            for (const dispose of disposables.reverse()) {
                await dispose();
            }
            await rasterScheduler.dispose();
            app.unmount();
            viewerContainer.value?.remove();
        },
    };
}

describe('PdfRenderingSession behavior', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        rendererFixture.options = null;
        canvasFixture.mount.mockImplementation((
            host: HTMLElement,
            canvas: HTMLCanvasElement,
            previous?: HTMLCanvasElement,
        ) => {
            if (previous?.parentElement === host) {
                previous.replaceWith(canvas);
            } else {
                host.prepend(canvas);
            }
        });
        canvasFixture.cleanup.mockImplementation((canvas: HTMLCanvasElement) => {
            canvas.width = 0;
            canvas.height = 0;
            canvas.remove();
        });
    });

    it('publishes queued work once, starts the actual RenderTask, and commits canvas before layers', async () => {
        const fixture = createRenderingFixture({autoResolve: false});
        try {
            await vi.waitFor(() => expect(fixture.pdfPage.render).toHaveBeenCalledOnce());
            expect(fixture.canvasHost.querySelector('canvas')).toBeNull();
            expect(rendererFixture.api.renderCommittedPageLayers).not.toHaveBeenCalled();

            fixture.renderTasks[0]!.resolve();
            await vi.waitFor(() => expect(fixture.canvasHost.querySelector('canvas')).not.toBeNull());

            expect(fixture.canvasHost.querySelector('canvas')).not.toBeNull();
            expect(rendererFixture.api.renderCommittedPageLayers).toHaveBeenCalledOnce();
        } finally {
            await fixture.dispose();
        }
    });

    it('does not restart or invalidate matching in-flight demand', async () => {
        const fixture = createRenderingFixture({autoResolve: false});
        const invalidate = vi.spyOn(fixture.rasterScheduler, 'invalidate');
        try {
            await vi.waitFor(() => expect(fixture.pdfPage.render).toHaveBeenCalledOnce());
            fixture.demand.value = {
                ...fixture.demand.value,
                revision: 2,
                mandatoryRaster: null,
            };
            await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));

            expect(fixture.pdfPage.render).toHaveBeenCalledOnce();
            expect(invalidate).not.toHaveBeenCalled();
            fixture.renderTasks[0]!.resolve();
        } finally {
            await fixture.dispose();
        }
    });

    it('keeps the resident canvas visible until a stale-scale replacement swaps atomically', async () => {
        const fixture = createRenderingFixture({autoResolve: false});
        try {
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(1));
            fixture.renderTasks[0]!.resolve();
            await vi.waitFor(() => expect(fixture.canvasHost.querySelector('canvas')).not.toBeNull());
            const resident = fixture.canvasHost.querySelector('canvas');

            fixture.outputScale.value = 2;
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(2));
            expect(fixture.canvasHost.querySelector('canvas')).toBe(resident);

            fixture.renderTasks[1]!.resolve();
            await vi.waitFor(() => expect(fixture.canvasHost.querySelector('canvas')).not.toBe(resident));
            expect(resident?.isConnected).toBe(false);
        } finally {
            await fixture.dispose();
        }
    });

    it('keeps failed work terminal until an explicit repair', async () => {
        const fixture = createRenderingFixture({autoResolve: false});
        try {
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(1));
            fixture.renderTasks[0]!.reject(new Error('paint failed'));
            await vi.waitFor(() => expect(canvasFixture.cleanupResult).toHaveBeenCalled());
            fixture.demand.value = {
                ...fixture.demand.value,
                revision: 2,
                mandatoryRaster: null,
            };
            await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
            expect(fixture.renderTasks).toHaveLength(1);

            const repair = fixture.rendering.renderVisiblePages({
                start: 3,
                end: 3,
            }, {
                forceRerender: true,
                rasterDemandPages: [3],
            });
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(2));
            fixture.renderTasks[1]!.resolve();
            await repair;
            expect(fixture.canvasHost.querySelector('canvas')).not.toBeNull();
        } finally {
            await fixture.dispose();
        }
    });

    it('rejects a stale container commit without exposing its detached canvas', async () => {
        const fixture = createRenderingFixture({autoResolve: false});
        try {
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(1));
            const stalePage = fixture.canvasHost.closest('.page_container')!;
            stalePage.remove();
            fixture.renderTasks[0]!.resolve();
            await vi.waitFor(() => expect(canvasFixture.cleanupResult).toHaveBeenCalled());

            expect(fixture.canvasHost.querySelector('canvas')).toBeNull();
            expect(rendererFixture.api.renderCommittedPageLayers).not.toHaveBeenCalled();
        } finally {
            await fixture.dispose();
        }
    });

    it('rejects a commit when the document scheduler fence is no longer current', async () => {
        const fixture = createRenderingFixture({autoResolve: false});
        const replacementScheduler = createPdfPageRasterScheduler({
            documentFence: {
                loadToken: 8,
                documentVersion: 10,
                documentRevision: 'revision-8',
            },
            leasePage: fixture.documentSession.leasePage as never,
        });
        try {
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(1));
            fixture.documentSession.rasterScheduler = replacementScheduler;
            fixture.renderTasks[0]!.resolve();
            await vi.waitFor(() => expect(canvasFixture.cleanupResult).toHaveBeenCalled());

            expect(fixture.canvasHost.querySelector('canvas')).toBeNull();
            expect(rendererFixture.api.renderCommittedPageLayers).not.toHaveBeenCalled();
        } finally {
            await replacementScheduler.dispose();
            await fixture.dispose();
        }
    });

    it('settles mandatory raster only after the first canvas attempt completes', async () => {
        const fixture = createRenderingFixture({autoResolve: false});
        try {
            await vi.waitFor(() => expect(fixture.renderTasks).toHaveLength(1));
            const pageRendererOptions = rendererFixture.options as {requestRaster: () => Promise<void>};
            expect(pageRendererOptions.requestRaster).toBeTypeOf('function');
            expect(fixture.settleMandatoryRaster).not.toHaveBeenCalled();

            fixture.renderTasks[0]!.resolve();
            await vi.waitFor(() => expect(fixture.canvasHost.querySelector('canvas')).not.toBeNull());
            await vi.waitFor(() => expect(fixture.settleMandatoryRaster).toHaveBeenCalledWith(1));
        } finally {
            await fixture.dispose();
        }
    });
});
