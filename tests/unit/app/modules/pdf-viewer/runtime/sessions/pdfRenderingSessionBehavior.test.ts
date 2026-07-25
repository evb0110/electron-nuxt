// @vitest-environment happy-dom

import {
    computed,
    createApp,
    defineComponent,
    nextTick,
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

const rendererFixture = vi.hoisted(() => {
    const api = {
        applySearchHighlights: vi.fn(),
        cancelInFlightRenders: vi.fn(async () => undefined),
        cancelPendingSearchScroll: vi.fn(),
        cancelRasterDemand: vi.fn(async () => undefined),
        cleanupAllPages: vi.fn(async () => undefined),
        getPageRenderFailureToken: vi.fn(() => null),
        hideManagedAnnotationEditors: vi.fn(),
        invalidatePages: vi.fn(),
        isPageCanvasCommitted: vi.fn(() => false),
        isPageLayerReady: vi.fn(() => true),
        isPageQualityRefineEligible: vi.fn(() => false),
        isPageRendered: vi.fn(() => false),
        isPageRendering: vi.fn(() => false),
        reRenderAllVisiblePages: vi.fn(async () => undefined),
        renderAnnotationEditorLayerForPage: vi.fn(),
        renderVisiblePages: vi.fn(async () => undefined),
    };
    return {
        api,
        options: null as Record<string, unknown> | null,
    };
});

const initialCanvasFixture = vi.hoisted(() => ({
    begin: vi.fn(),
    resolveCanvas: vi.fn(),
    tryComplete: vi.fn((pageNumber: number, complete: (page: number) => boolean) => complete(pageNumber)),
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
vi.mock('@app/modules/pdf-viewer/runtime/lifecycle/usePdfInitialCanvasCommitCoordinator', () => ({usePdfInitialCanvasCommitCoordinator: vi.fn(() => ({
    ...initialCanvasFixture,
    isInitialCanvasCommitted: vi.fn(() => false),
    isInitialVisualCommitted: vi.fn(() => false),
}))}));
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

function createRenderingFixture() {
    const subscribers: Array<(transition: IPdfDocumentTransition) => void | Promise<void>> = [];
    const disposables: Array<() => void | Promise<void>> = [];
    const currentPage = ref(3);
    const demand = shallowRef({
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
        settleMandatoryRaster: vi.fn(),
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
    const documentSession = {
        pdfDocument: shallowRef({numPages: 5}),
        acceptedSource: shallowRef(new Blob(['pdf'], {type: 'application/pdf'})),
        isLoading: ref(false),
        numPages: ref(5),
        rasterScheduler: null,
        openSurfaceGeneration: 11,
        openSurfaceRevision: 'revision-7',
        getRenderVersion: () => 9,
        captureFence: () => createTransition('ready').fence,
        ensurePageMetricsInRange: vi.fn(async () => true),
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
    const viewerContainer = ref<HTMLElement | null>(document.createElement('div'));
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
                outputScale: ref(1),
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
        subscribers,
        viewerContainer,
        async emit(transition: IPdfDocumentTransition) {
            for (const subscriber of subscribers) {
                await subscriber(transition);
            }
        },
    };
}

describe('PdfRenderingSession behavior', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        rendererFixture.options = null;
        rendererFixture.api.isPageCanvasCommitted.mockReturnValue(false);
    });

    it('keeps a mounted committed visual during reload until fresh raster demand commits', async () => {
        const fixture = createRenderingFixture();
        try {
            await fixture.emit(createTransition('loading', {
                isReload: true,
                preserveVisibleContent: true,
                preservePageStructure: true,
            }));

            expect(rendererFixture.api.cleanupAllPages).not.toHaveBeenCalled();
            const pageRendererOptions = rendererFixture.options as {onPageCanvasMounted: (commit: {
                openSurfaceGeneration: number;
                documentRevision: string;
                renderVersion: number;
                requestId: number;
                pageNumber: number;
            }) => void;};
            pageRendererOptions.onPageCanvasMounted({
                openSurfaceGeneration: 11,
                documentRevision: 'revision-7',
                renderVersion: 9,
                requestId: 4,
                pageNumber: 3,
            });
            expect(fixture.rendering.renderedPageStateVersion.value).toBe(1);
        } finally {
            fixture.app.unmount();
        }
    });

    it('requires the exact current mounted canvas before consuming the initial-ready token', async () => {
        const fixture = createRenderingFixture();
        try {
            const createPage = (pageNumber: number, withCanvas: boolean) => {
                const page = document.createElement('div');
                page.className = 'page_container';
                page.dataset.page = String(pageNumber);
                const canvasHost = document.createElement('div');
                canvasHost.className = 'page_canvas';
                if (withCanvas) {
                    const canvas = document.createElement('canvas');
                    canvas.width = 100;
                    canvas.height = 100;
                    canvas.getBoundingClientRect = () => ({
                        bottom: 100,
                        height: 100,
                        left: 0,
                        right: 100,
                        top: 0,
                        width: 100,
                        x: 0,
                        y: 0,
                        toJSON: () => ({}),
                    });
                    canvasHost.append(canvas);
                }
                page.append(canvasHost);
                return {
                    canvasHost,
                    page,
                };
            };
            const wrongPage = createPage(2, true);
            const currentPage = createPage(3, false);
            const container = fixture.viewerContainer.value!;
            container.getBoundingClientRect = () => ({
                bottom: 800,
                height: 800,
                left: 0,
                right: 800,
                top: 0,
                width: 800,
                x: 0,
                y: 0,
                toJSON: () => ({}),
            });
            document.body.append(container);
            fixture.viewerContainer.value?.append(wrongPage.page, currentPage.page);

            await fixture.emit(createTransition('loading'));
            fixture.navigationCommittedSignal.value = {
                revision: 1,
                pageNumber: 2,
            };
            expect(fixture.emitInitialVisualReady).not.toHaveBeenCalled();

            fixture.navigationCommittedSignal.value = {
                revision: 2,
                pageNumber: 3,
            };
            expect(fixture.emitInitialVisualReady).not.toHaveBeenCalled();

            const canvas = document.createElement('canvas');
            canvas.width = 100;
            canvas.height = 100;
            canvas.getBoundingClientRect = () => ({
                bottom: 100,
                height: 100,
                left: 0,
                right: 100,
                top: 0,
                width: 100,
                x: 0,
                y: 0,
                toJSON: () => ({}),
            });
            currentPage.canvasHost.append(canvas);
            fixture.navigationCommittedSignal.value = {
                revision: 3,
                pageNumber: 3,
            };
            expect(fixture.emitInitialVisualReady).toHaveBeenCalledExactlyOnceWith({pageNumber: 3});
        } finally {
            fixture.app.unmount();
        }
    });

    it('executes mandatory first-canvas demand before settled background work', async () => {
        const fixture = createRenderingFixture();
        try {
            await vi.waitFor(() => {
                expect(rendererFixture.api.renderVisiblePages).toHaveBeenCalledWith(
                    {
                        start: 3,
                        end: 3,
                    },
                    expect.objectContaining({bufferOverride: 0}),
                );
            });
            const firstRasterOrder = rendererFixture.api.renderVisiblePages.mock.invocationCallOrder[0]!;

            await fixture.emit(createTransition('settled'));
            await nextTick();

            expect(rendererFixture.api.applySearchHighlights).toHaveBeenCalledOnce();
            expect(firstRasterOrder)
                .toBeLessThan(rendererFixture.api.applySearchHighlights.mock.invocationCallOrder[0]!);
        } finally {
            fixture.app.unmount();
        }
    });
});
