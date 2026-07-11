import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    nextTick,
    ref,
    shallowRef,
} from 'vue';
import { usePdfViewerRerenderCoordinator } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerRerenderCoordinator';
import { usePdfViewerTransactionController } from '@app/modules/pdf-viewer/runtime/transactions/usePdfViewerTransactionController';
import type { IResizeAnchorContext } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync';
import type { IBuildResizeAnchorContextOptions } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerResizeLifecycle';
import type { IPdfNavigationState } from '@app/modules/pdf-viewer/runtime/navigation/navigationMachine';
import { PDF_RERENDER_SOURCE } from '@app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import { cast } from '@tests/helpers/cast';

function createResizeAnchor(page: number): IResizeAnchorContext {
    return {
        page,
        capturedAtMs: Date.now(),
        transitionToken: 1,
        visibleRange: {
            start: page,
            end: page,
        },
        viewerMetrics: null,
    };
}

interface ITestPageRange {
    start: number;
    end: number;
}

type TReRenderAllVisiblePagesMock = (
    getVisibleRange: () => ITestPageRange,
    options?: Record<string, unknown>,
) => Promise<void>;

function createReRenderAllVisiblePagesMock() {
    return vi.fn<TReRenderAllVisiblePagesMock>(async () => {});
}

function createDeferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((resolver) => {
        resolve = resolver;
    });
    return {
        promise,
        resolve,
    };
}

function getRenderedRangeFromFirstCall(
    reRenderAllVisiblePages: ReturnType<typeof createReRenderAllVisiblePagesMock>,
) {
    const firstCall = reRenderAllVisiblePages.mock.calls[0];
    if (!firstCall) {
        throw new Error('Expected at least one visible rerender call');
    }
    return firstCall[0]();
}

async function flushCurrentPageFitRerender() {
    await nextTick();
    await vi.advanceTimersByTimeAsync(300);
    await nextTick();
    await Promise.resolve();
}

type TCoordinatorDeps = Parameters<typeof usePdfViewerRerenderCoordinator>[0];

function createDeps(overrides: Partial<TCoordinatorDeps> = {}): TCoordinatorDeps {
    const currentPage = ref(1);
    const visibleRange = ref({
        start: 1,
        end: 1,
    });

    const deps = {
        viewerContainer: ref(null),
        pdfDocument: shallowRef<PDFDocumentProxy | null>(cast({})),
        isLoading: ref(false),
        numPages: ref(10),
        currentPage,
        visibleRange,
        zoom: computed(() => 1),
        zoomMode: computed(() => 'custom' as const),
        fitMode: computed(() => 'width' as const),
        viewMode: computed(() => 'single' as const),
        isResizing: computed(() => false),
        continuousScroll: computed(() => false),
        getVisibleRange: () => visibleRange.value,
        reRenderAllVisiblePages: vi.fn(async () => {}),
        isPageRendered: vi.fn(() => true),
        summarizeViewerMetricsForLog: vi.fn(() => null),
        summarizeVisiblePageSnapshotForLog: vi.fn(() => null),
        syncCurrentPageFromViewport: vi.fn(async () => {}),
        markLowResZoomRerenderUsed: vi.fn(),
        buildResizeAnchorContext: vi.fn((options?: IBuildResizeAnchorContextOptions) => {
            return createResizeAnchor(options?.preferredAnchorPage ?? currentPage.value);
        }),
        scheduleEndResizeTransition: vi.fn(),
        enqueueZoomSync: vi.fn(),
        scheduleResizeAwareRerender: vi.fn(),
        cancelInFlightPageRenders: vi.fn(),
        computeFitWidthScale: vi.fn(() => false),
        syncHorizontalScrollForZoomMode: vi.fn(() => true),
        setupPagePlaceholders: vi.fn(),
        scrollToPage: vi.fn(),
        getMostVisiblePage: vi.fn(() => currentPage.value),
        resetContinuousScrollState: vi.fn(),
        resetZoomRerenderQueueState: vi.fn(),
        consumeZoomViewportAnchor: vi.fn(() => null),
        beginResizeTransition: vi.fn(() => 1),
        consumeSuppressedZoomRerender: vi.fn(() => false),
        ...overrides,
    };
    const navigationState = shallowRef<IPdfNavigationState>({
        anchor: 'top',
        currentPage: deps.currentPage.value,
        source: 'paged',
        status: 'idle',
        targetPage: null,
        txn: 1,
    });
    return {
        ...deps,
        transactionController: deps.transactionController ?? usePdfViewerTransactionController({
            navigationState,
            currentPage: deps.currentPage,
            visibleRange: deps.visibleRange,
            numPages: deps.numPages,
            viewMode: cast(deps.viewMode),
            pdfDocument: cast(deps.pdfDocument),
            userViewportInteractionEpoch: ref(0),
        }),
    };
}

describe('usePdfViewerRerenderCoordinator', () => {
    it('does not overwrite view-mode snapshot restoration with a bare page snap', async () => {
        const viewMode = ref<'single' | 'facing'>('single');
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
        const scrollToPage = vi.fn();
        const syncHorizontalScrollForZoomMode = vi.fn(() => true);

        usePdfViewerRerenderCoordinator(createDeps({
            currentPage: ref(4),
            visibleRange: ref({
                start: 4,
                end: 4,
            }),
            viewMode: computed(() => viewMode.value),
            getVisibleRange: () => ({
                start: 4,
                end: 4,
            }),
            reRenderAllVisiblePages,
            scrollToPage,
            getMostVisiblePage: vi.fn(() => 4),
            syncHorizontalScrollForZoomMode,
        }));

        viewMode.value = 'facing';
        await nextTick();
        await Promise.resolve();
        await nextTick();

        expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({rerenderSource: 'view-mode'}),
        );
        expect(scrollToPage).not.toHaveBeenCalled();
        expect(syncHorizontalScrollForZoomMode).toHaveBeenCalled();
    });

    it('skips scheduling a zoom rerender when the zoom change was already handled by reload recovery', async () => {
        const zoom = ref(1);
        const consumeSuppressedZoomRerender = vi.fn(() => true);
        const enqueueZoomSync = vi.fn();
        const cancelInFlightPageRenders = vi.fn();

        usePdfViewerRerenderCoordinator(createDeps({
            numPages: ref(10),
            zoom: computed(() => zoom.value),
            fitMode: computed(() => 'width' as const),
            getVisibleRange: () => ({
                start: 1,
                end: 1,
            }),
            enqueueZoomSync,
            cancelInFlightPageRenders,
            consumeSuppressedZoomRerender,
        }));

        zoom.value = 1.94;
        await nextTick();

        expect(consumeSuppressedZoomRerender).toHaveBeenCalledWith(1.94);
        expect(cancelInFlightPageRenders).not.toHaveBeenCalled();
        expect(enqueueZoomSync).not.toHaveBeenCalled();
    });

    it('uses the visible current page as a trusted toolbar zoom anchor', async () => {
        const zoom = ref(1);
        const pdfDocument = shallowRef<PDFDocumentProxy | null>(cast({}));
        const currentPage = ref(157);
        const visibleRange = ref({
            start: 156,
            end: 158,
        });
        const buildResizeAnchorContext = vi.fn(() => createResizeAnchor(157));
        const enqueueZoomSync = vi.fn();

        usePdfViewerRerenderCoordinator(createDeps({
            pdfDocument,
            numPages: ref(348),
            currentPage,
            visibleRange,
            zoom: computed(() => zoom.value),
            fitMode: computed(() => 'width' as const),
            getVisibleRange: () => visibleRange.value,
            buildResizeAnchorContext,
            enqueueZoomSync,
            getMostVisiblePage: vi.fn(() => 157),
        }));

        zoom.value = 1.43;
        await nextTick();

        expect(buildResizeAnchorContext).toHaveBeenCalledWith({
            preferredAnchorPage: 157,
            trustPreferredAnchorPage: true,
        });
        expect(enqueueZoomSync).toHaveBeenCalledWith(expect.objectContaining({
            source: 'zoom-change',
            stabilize: true,
            resizeAnchor: expect.objectContaining({ page: 157 }),
        }));
    });

    it('uses a viewport-anchored source for gesture zoom rerenders', async () => {
        const zoom = ref(1);
        const pdfDocument = shallowRef<PDFDocumentProxy | null>(cast({}));
        const currentPage = ref(157);
        const visibleRange = ref({
            start: 156,
            end: 158,
        });
        const buildResizeAnchorContext = vi.fn(() => createResizeAnchor(157));
        const enqueueZoomSync = vi.fn();

        usePdfViewerRerenderCoordinator(createDeps({
            pdfDocument,
            numPages: ref(348),
            currentPage,
            visibleRange,
            zoom: computed(() => zoom.value),
            fitMode: computed(() => 'width' as const),
            getVisibleRange: () => visibleRange.value,
            buildResizeAnchorContext,
            enqueueZoomSync,
            consumeZoomViewportAnchor: vi.fn(() => ({
                x: 80,
                y: 120,
                capturedAtMs: 1_000,
            })),
            getMostVisiblePage: vi.fn(() => 157),
        }));

        zoom.value = 1.43;
        await nextTick();

        expect(buildResizeAnchorContext).toHaveBeenCalledWith({
            preferredAnchorPage: 157,
            trustPreferredAnchorPage: false,
        });
        expect(enqueueZoomSync).toHaveBeenCalledWith(expect.objectContaining({
            source: 'zoom-gesture-change',
            stabilize: true,
            resizeAnchor: expect.objectContaining({ page: 157 }),
        }));
    });

    it('does not rerender continuous fit-width when passive scrolling changes the current page', async () => {
        const currentPage = ref(1);
        const computeFitWidthScale = vi.fn(() => true);
        const cancelInFlightPageRenders = vi.fn();
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
        const syncCurrentPageFromViewport = vi.fn(async () => {});
        const syncHorizontalScrollForZoomMode = vi.fn(() => true);
        const buildResizeAnchorContext = vi.fn(() => createResizeAnchor(currentPage.value));

        usePdfViewerRerenderCoordinator(createDeps({
            currentPage,
            visibleRange: ref({
                start: 1,
                end: 2,
            }),
            zoomMode: computed(() => 'fit-width' as const),
            continuousScroll: computed(() => true),
            getVisibleRange: () => ({
                start: 1,
                end: 2,
            }),
            reRenderAllVisiblePages,
            syncCurrentPageFromViewport,
            buildResizeAnchorContext,
            cancelInFlightPageRenders,
            computeFitWidthScale,
            syncHorizontalScrollForZoomMode,
            getMostVisiblePage: vi.fn(() => 2),
        }));

        currentPage.value = 2;
        await nextTick();
        await nextTick();

        expect(computeFitWidthScale).not.toHaveBeenCalled();
        expect(buildResizeAnchorContext).not.toHaveBeenCalled();
        expect(cancelInFlightPageRenders).not.toHaveBeenCalled();
        expect(reRenderAllVisiblePages).not.toHaveBeenCalled();
        expect(syncCurrentPageFromViewport).not.toHaveBeenCalled();
        expect(syncHorizontalScrollForZoomMode).not.toHaveBeenCalled();
    });

    it('rerenders paged fit-width when the current page changes', async () => {
        vi.useFakeTimers();
        try {
            const currentPage = ref(1);
            const computeFitWidthScale = vi.fn(() => true);
            const cancelInFlightPageRenders = vi.fn();
            const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
            const syncCurrentPageFromViewport = vi.fn(async () => {});
            const buildResizeAnchorContext = vi.fn(() => createResizeAnchor(currentPage.value));

            usePdfViewerRerenderCoordinator(createDeps({
                currentPage,
                zoomMode: computed(() => 'fit-width' as const),
                getVisibleRange: () => ({
                    start: 2,
                    end: 2,
                }),
                reRenderAllVisiblePages,
                syncCurrentPageFromViewport,
                buildResizeAnchorContext,
                cancelInFlightPageRenders,
                computeFitWidthScale,
                getMostVisiblePage: vi.fn(() => 2),
            }));

            currentPage.value = 2;
            await flushCurrentPageFitRerender();

            expect(computeFitWidthScale).toHaveBeenCalledWith(null, { page: 2 });
            expect(buildResizeAnchorContext).toHaveBeenCalledWith({
                preferredAnchorPage: 2,
                trustPreferredAnchorPage: true,
            });
            expect(cancelInFlightPageRenders).toHaveBeenCalled();
            expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({
                    preserveExistingPages: true,
                    renderBufferOverride: 0,
                    rerenderSource: 'fit-width-current-page',
                }),
            );
            expect(syncCurrentPageFromViewport).toHaveBeenCalledWith(
                expect.objectContaining({ source: 'fit-width-current-page' }),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('snaps paged fit-height to the target after placeholder sizing and before rendering', async () => {
        vi.useFakeTimers();
        try {
            const currentPage = ref(1);
            const computeFitWidthScale = vi.fn(() => true);
            const cancelInFlightPageRenders = vi.fn();
            const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
            const scrollToPage = vi.fn(() => true);
            const syncCurrentPageFromViewport = vi.fn(async () => {});
            const buildResizeAnchorContext = vi.fn(() => createResizeAnchor(currentPage.value));
            const ensurePageMetricsInRange = vi.fn(async () => true);
            const setupPagePlaceholders = vi.fn();

            usePdfViewerRerenderCoordinator(createDeps({
                currentPage,
                zoomMode: computed(() => 'fit-height' as const),
                fitMode: computed(() => 'height' as const),
                viewMode: computed(() => 'facing-first-single' as const),
                getVisibleRange: () => ({
                    start: 2,
                    end: 3,
                }),
                reRenderAllVisiblePages,
                syncCurrentPageFromViewport,
                buildResizeAnchorContext,
                cancelInFlightPageRenders,
                ensurePageMetricsInRange,
                computeFitWidthScale,
                setupPagePlaceholders,
                scrollToPage,
                getMostVisiblePage: vi.fn(() => 2),
            }));

            currentPage.value = 2;
            await flushCurrentPageFitRerender();

            expect(computeFitWidthScale).toHaveBeenCalledWith(null, { page: 2 });
            expect(ensurePageMetricsInRange).toHaveBeenCalledWith(2, 3);
            expect(setupPagePlaceholders).toHaveBeenCalled();
            expect(ensurePageMetricsInRange.mock.invocationCallOrder[0]!).toBeLessThan(
                computeFitWidthScale.mock.invocationCallOrder[0]!,
            );
            expect(setupPagePlaceholders.mock.invocationCallOrder[0]!).toBeLessThan(
                scrollToPage.mock.invocationCallOrder[0]!,
            );
            expect(scrollToPage.mock.invocationCallOrder[0]!).toBeLessThan(
                reRenderAllVisiblePages.mock.invocationCallOrder[0]!,
            );
            expect(buildResizeAnchorContext).not.toHaveBeenCalled();
            expect(cancelInFlightPageRenders).toHaveBeenCalled();
            expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({
                    rerenderSource: 'fit-height-current-page',
                    renderBufferOverride: 0,
                }),
            );
            expect(syncCurrentPageFromViewport).not.toHaveBeenCalled();
            expect(scrollToPage).toHaveBeenCalledWith(2, {
                preferExactDom: true,
                suppressRenderAfterSnap: true,
            });
            expect(scrollToPage).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('still renders paged fit-height when the hydrated fit scale is unchanged', async () => {
        vi.useFakeTimers();
        try {
            const currentPage = ref(1);
            const computeFitWidthScale = vi.fn(() => false);
            const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();

            usePdfViewerRerenderCoordinator(createDeps({
                currentPage,
                zoomMode: computed(() => 'fit-height' as const),
                fitMode: computed(() => 'height' as const),
                getVisibleRange: () => ({
                    start: 2,
                    end: 2,
                }),
                reRenderAllVisiblePages,
                buildResizeAnchorContext: vi.fn(() => createResizeAnchor(currentPage.value)),
                ensurePageMetricsInRange: vi.fn(async () => false),
                computeFitWidthScale,
                getMostVisiblePage: vi.fn(() => 2),
            }));

            currentPage.value = 2;
            await flushCurrentPageFitRerender();

            expect(computeFitWidthScale).toHaveBeenCalledWith(null, { page: 2 });
            expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({
                    rerenderSource: 'fit-height-current-page',
                    renderBufferOverride: 0,
                }),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('abandons delayed fit-height current-page rerender and renders the newer paged target', async () => {
        vi.useFakeTimers();
        try {
            const currentPage = ref(1);
            const pagedNavigationTargetPage = ref<number | null>(null);
            const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
            const scrollToPage = vi.fn();
            const computeFitWidthScale = vi.fn(() => false);

            usePdfViewerRerenderCoordinator(createDeps({
                currentPage,
                pagedNavigationTargetPage,
                zoomMode: computed(() => 'fit-height' as const),
                fitMode: computed(() => 'height' as const),
                getVisibleRange: () => ({
                    start: 4,
                    end: 4,
                }),
                reRenderAllVisiblePages,
                scrollToPage,
                ensurePageMetricsInRange: vi.fn(async () => true),
                computeFitWidthScale,
            }));

            currentPage.value = 4;
            await nextTick();
            pagedNavigationTargetPage.value = 6;
            await flushCurrentPageFitRerender();

            expect(scrollToPage).toHaveBeenCalledWith(6, {
                preferExactDom: true,
                suppressRenderAfterSnap: true,
            });
            expect(computeFitWidthScale).toHaveBeenCalledWith(null, { page: 6 });
            expect(getRenderedRangeFromFirstCall(reRenderAllVisiblePages)).toEqual({
                start: 6,
                end: 6,
            });
            expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({
                    rerenderSource: 'fit-height-paged-target',
                    renderBufferOverride: 0,
                }),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('rerenders fit-height after a settled paged target loses transaction authority', async () => {
        vi.useFakeTimers();
        try {
            const currentPage = ref(1);
            const pagedNavigationTargetPage = ref<number | null>(null);
            const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
            const computeFitWidthScale = vi.fn(() => false);
            const scrollToPage = vi.fn();

            usePdfViewerRerenderCoordinator(createDeps({
                currentPage,
                pagedNavigationTargetPage,
                zoomMode: computed(() => 'fit-height' as const),
                fitMode: computed(() => 'height' as const),
                reRenderAllVisiblePages,
                scrollToPage,
                ensurePageMetricsInRange: vi.fn(async () => true),
                computeFitWidthScale,
            }));

            pagedNavigationTargetPage.value = 4;
            await flushCurrentPageFitRerender();

            expect(reRenderAllVisiblePages).toHaveBeenCalledOnce();
            expect(reRenderAllVisiblePages).toHaveBeenLastCalledWith(
                expect.any(Function),
                expect.objectContaining({ rerenderSource: 'fit-height-paged-target' }),
            );

            pagedNavigationTargetPage.value = null;
            currentPage.value = 4;
            await flushCurrentPageFitRerender();

            expect(reRenderAllVisiblePages).toHaveBeenCalledTimes(2);
            expect(reRenderAllVisiblePages).toHaveBeenLastCalledWith(
                expect.any(Function),
                expect.objectContaining({rerenderSource: 'fit-height-current-page'}),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('consumes a pending fit-height paged target render when the target commits before render unwinds', async () => {
        vi.useFakeTimers();
        try {
            const currentPage = ref(1);
            const pagedNavigationTargetPage = ref<number | null>(null);
            const renderBlocker = createDeferred();
            const reRenderAllVisiblePages = vi.fn<TReRenderAllVisiblePagesMock>(async () => {
                await renderBlocker.promise;
            });

            usePdfViewerRerenderCoordinator(createDeps({
                currentPage,
                pagedNavigationTargetPage,
                zoomMode: computed(() => 'fit-height' as const),
                fitMode: computed(() => 'height' as const),
                reRenderAllVisiblePages,
                ensurePageMetricsInRange: vi.fn(async () => true),
                computeFitWidthScale: vi.fn(() => false),
            }));

            pagedNavigationTargetPage.value = 4;
            await nextTick();
            await vi.advanceTimersByTimeAsync(300);
            await nextTick();
            await Promise.resolve();

            expect(reRenderAllVisiblePages).toHaveBeenCalledOnce();
            expect(reRenderAllVisiblePages).toHaveBeenLastCalledWith(
                expect.any(Function),
                expect.objectContaining({ rerenderSource: 'fit-height-paged-target' }),
            );

            currentPage.value = 4;
            pagedNavigationTargetPage.value = null;
            await nextTick();
            await vi.advanceTimersByTimeAsync(300);
            await nextTick();
            await Promise.resolve();

            expect(reRenderAllVisiblePages).toHaveBeenCalledOnce();
            expect(reRenderAllVisiblePages.mock.calls.some(([
                , options,
            ]) => (
                options?.rerenderSource === 'fit-height-current-page'
            ))).toBe(false);

            renderBlocker.resolve();
            await Promise.resolve();
            await nextTick();
        } finally {
            vi.useRealTimers();
        }
    });

    it('rerenders fit-width after a settled paged target loses transaction authority', async () => {
        vi.useFakeTimers();
        try {
            const currentPage = ref(1);
            const pagedNavigationTargetPage = ref<number | null>(null);
            const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
            const computeFitWidthScale = vi.fn(() => false);
            const syncCurrentPageFromViewport = vi.fn(async () => {});

            usePdfViewerRerenderCoordinator(createDeps({
                currentPage,
                pagedNavigationTargetPage,
                zoomMode: computed(() => 'fit-width' as const),
                fitMode: computed(() => 'width' as const),
                reRenderAllVisiblePages,
                syncCurrentPageFromViewport,
                ensurePageMetricsInRange: vi.fn(async () => true),
                computeFitWidthScale,
            }));

            pagedNavigationTargetPage.value = 4;
            await flushCurrentPageFitRerender();

            expect(reRenderAllVisiblePages).toHaveBeenCalledOnce();
            expect(reRenderAllVisiblePages).toHaveBeenLastCalledWith(
                expect.any(Function),
                expect.objectContaining({ rerenderSource: 'fit-width-paged-target' }),
            );

            pagedNavigationTargetPage.value = null;
            currentPage.value = 4;
            await flushCurrentPageFitRerender();

            expect(reRenderAllVisiblePages).toHaveBeenCalledTimes(2);
            expect(reRenderAllVisiblePages).toHaveBeenLastCalledWith(
                expect.any(Function),
                expect.objectContaining({rerenderSource: 'fit-width-current-page'}),
            );
            expect(syncCurrentPageFromViewport).toHaveBeenCalledWith(
                expect.objectContaining({source: 'fit-width-current-page'}),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps fit-rerender suppression active until an overlapping paged target finishes', async () => {
        vi.useFakeTimers();
        try {
            const currentPage = ref(1);
            const pagedNavigationTargetPage = ref<number | null>(null);
            const renderBlocker = createDeferred();
            const reRenderAllVisiblePages = vi.fn<TReRenderAllVisiblePagesMock>(async () => {
                await renderBlocker.promise;
            });

            usePdfViewerRerenderCoordinator(createDeps({
                currentPage,
                pagedNavigationTargetPage,
                zoomMode: computed(() => 'fit-height' as const),
                fitMode: computed(() => 'height' as const),
                reRenderAllVisiblePages,
                scrollToPage: vi.fn(() => true),
                ensurePageMetricsInRange: vi.fn(async () => true),
                computeFitWidthScale: vi.fn(() => true),
            }));

            currentPage.value = 4;
            await nextTick();
            pagedNavigationTargetPage.value = 6;
            await vi.advanceTimersByTimeAsync(300);
            await nextTick();

            expect(reRenderAllVisiblePages).toHaveBeenCalledOnce();

            renderBlocker.resolve();
            await Promise.resolve();
            await nextTick();

        } finally {
            vi.useRealTimers();
        }
    });

    it('does not apply a second fit-height snap when the user scrolls during rerender', async () => {
        vi.useFakeTimers();
        try {
            let userInteractionEpoch = 0;
            const currentPage = ref(1);
            const reRenderAllVisiblePages = vi.fn<TReRenderAllVisiblePagesMock>(async () => {
                userInteractionEpoch += 1;
            });
            const scrollToPage = vi.fn(() => true);

            usePdfViewerRerenderCoordinator(createDeps({
                currentPage,
                zoomMode: computed(() => 'fit-height' as const),
                fitMode: computed(() => 'height' as const),
                getVisibleRange: () => ({
                    start: 2,
                    end: 2,
                }),
                reRenderAllVisiblePages,
                buildResizeAnchorContext: vi.fn(() => createResizeAnchor(currentPage.value)),
                ensurePageMetricsInRange: vi.fn(async () => true),
                computeFitWidthScale: vi.fn(() => true),
                scrollToPage,
                getMostVisiblePage: vi.fn(() => 2),
                getUserViewportInteractionEpoch: () => userInteractionEpoch,
            }));

            currentPage.value = 2;
            await flushCurrentPageFitRerender();

            expect(reRenderAllVisiblePages).toHaveBeenCalledOnce();
            expect(scrollToPage).toHaveBeenCalledOnce();
            expect(scrollToPage.mock.invocationCallOrder[0]!).toBeLessThan(
                reRenderAllVisiblePages.mock.invocationCallOrder[0]!,
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('snaps fit-mode height changes before rerender restoration can reuse the old viewport', async () => {
        const fitMode = ref<'width' | 'height'>('width');
        const computeFitWidthScale = vi.fn(() => true);
        const setupPagePlaceholders = vi.fn();
        const scrollToPage = vi.fn(() => true);
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();

        usePdfViewerRerenderCoordinator(createDeps({
            currentPage: ref(4),
            visibleRange: ref({
                start: 4,
                end: 4,
            }),
            zoomMode: computed(() => fitMode.value === 'height' ? 'fit-height' as const : 'fit-width' as const),
            fitMode: computed(() => fitMode.value),
            getVisibleRange: () => ({
                start: 4,
                end: 4,
            }),
            reRenderAllVisiblePages,
            buildResizeAnchorContext: vi.fn(() => createResizeAnchor(4)),
            computeFitWidthScale,
            setupPagePlaceholders,
            scrollToPage,
            getMostVisiblePage: vi.fn(() => 4),
        }));

        fitMode.value = 'height';
        await nextTick();
        await Promise.resolve();
        await nextTick();

        expect(computeFitWidthScale).toHaveBeenCalled();
        expect(computeFitWidthScale).toHaveBeenCalledWith(null, { page: 4 });
        expect(setupPagePlaceholders.mock.invocationCallOrder[0]!).toBeLessThan(
            scrollToPage.mock.invocationCallOrder[0]!,
        );
        expect(scrollToPage.mock.invocationCallOrder[0]!).toBeLessThan(
            reRenderAllVisiblePages.mock.invocationCallOrder[0]!,
        );
        expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({
                rerenderSource: 'zoom-mode',
                renderBufferOverride: 0,
            }),
        );
        expect(scrollToPage).toHaveBeenCalledWith(4, {
            preferExactDom: true,
            suppressRenderAfterSnap: true,
        });
    });

    it('rerenders when zoom mode switches from custom 100% to fit-height without zoom or fit-mode changes', async () => {
        const zoomMode = ref<'custom' | 'fit-height'>('custom');
        const computeFitWidthScale = vi.fn(() => false);
        const setupPagePlaceholders = vi.fn();
        const scrollToPage = vi.fn(() => true);
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
        const cancelInFlightPageRenders = vi.fn();

        usePdfViewerRerenderCoordinator(createDeps({
            currentPage: ref(4),
            visibleRange: ref({
                start: 4,
                end: 4,
            }),
            zoomMode: computed(() => zoomMode.value),
            fitMode: computed(() => 'height' as const),
            getVisibleRange: () => ({
                start: 4,
                end: 4,
            }),
            reRenderAllVisiblePages,
            cancelInFlightPageRenders,
            computeFitWidthScale,
            setupPagePlaceholders,
            scrollToPage,
            getMostVisiblePage: vi.fn(() => 4),
        }));

        zoomMode.value = 'fit-height';
        await nextTick();
        await Promise.resolve();
        await nextTick();

        expect(computeFitWidthScale).toHaveBeenCalledWith(null, { page: 4 });
        expect(setupPagePlaceholders.mock.invocationCallOrder[0]!).toBeLessThan(
            scrollToPage.mock.invocationCallOrder[0]!,
        );
        expect(scrollToPage.mock.invocationCallOrder[0]!).toBeLessThan(
            reRenderAllVisiblePages.mock.invocationCallOrder[0]!,
        );
        expect(cancelInFlightPageRenders).toHaveBeenCalledOnce();
        expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({
                rerenderSource: 'zoom-mode',
                renderBufferOverride: 0,
            }),
        );
    });

    it('coalesces rapid paged fit-height current-page rerenders so only the latest page can render', async () => {
        vi.useFakeTimers();
        try {
            const currentPage = ref(1);
            const computeFitWidthScale = vi.fn(() => true);
            const cancelInFlightPageRenders = vi.fn();
            const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
            const scrollToPage = vi.fn();
            const ensurePageMetricsInRange = vi.fn(async () => true);

            usePdfViewerRerenderCoordinator(createDeps({
                numPages: ref(1_000),
                currentPage,
                zoomMode: computed(() => 'fit-height' as const),
                fitMode: computed(() => 'height' as const),
                getVisibleRange: () => ({
                    start: currentPage.value,
                    end: currentPage.value,
                }),
                reRenderAllVisiblePages,
                buildResizeAnchorContext: vi.fn(() => createResizeAnchor(currentPage.value)),
                cancelInFlightPageRenders,
                ensurePageMetricsInRange,
                computeFitWidthScale,
                scrollToPage,
                getMostVisiblePage: vi.fn(() => currentPage.value),
            }));

            currentPage.value = 30;
            await nextTick();
            currentPage.value = 928;
            await flushCurrentPageFitRerender();

            expect(computeFitWidthScale).toHaveBeenCalledTimes(1);
            expect(computeFitWidthScale).toHaveBeenCalledWith(null, { page: 928 });
            expect(cancelInFlightPageRenders).toHaveBeenCalledTimes(1);
            expect(reRenderAllVisiblePages).toHaveBeenCalledTimes(1);
            expect(getRenderedRangeFromFirstCall(reRenderAllVisiblePages)).toEqual({
                start: 928,
                end: 928,
            });
            expect(ensurePageMetricsInRange.mock.calls).toEqual([[
                928,
                928,
            ]]);
            expect(scrollToPage).toHaveBeenCalledOnce();
            expect(scrollToPage).toHaveBeenCalledWith(928, {
                preferExactDom: true,
                suppressRenderAfterSnap: true,
            });
            expect(scrollToPage).not.toHaveBeenCalledWith(30, expect.anything());
        } finally {
            vi.useRealTimers();
        }
    });

    it('coalesces rapid paged fit-width current-page rerenders so intermediate pages cannot cancel the last page', async () => {
        vi.useFakeTimers();
        try {
            const currentPage = ref(1);
            const computeFitWidthScale = vi.fn(() => true);
            const cancelInFlightPageRenders = vi.fn();
            const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
            const syncCurrentPageFromViewport = vi.fn(async () => {});
            const buildResizeAnchorContext = vi.fn((options?: IBuildResizeAnchorContextOptions) => {
                return createResizeAnchor(options?.preferredAnchorPage ?? currentPage.value);
            });
            const ensurePageMetricsInRange = vi.fn(async () => true);

            usePdfViewerRerenderCoordinator(createDeps({
                numPages: ref(1_000),
                currentPage,
                zoomMode: computed(() => 'fit-width' as const),
                getVisibleRange: () => ({
                    start: currentPage.value,
                    end: currentPage.value,
                }),
                reRenderAllVisiblePages,
                syncCurrentPageFromViewport,
                buildResizeAnchorContext,
                cancelInFlightPageRenders,
                ensurePageMetricsInRange,
                computeFitWidthScale,
                getMostVisiblePage: vi.fn(() => currentPage.value),
            }));

            currentPage.value = 30;
            await nextTick();
            currentPage.value = 928;
            await flushCurrentPageFitRerender();

            expect(computeFitWidthScale).toHaveBeenCalledTimes(1);
            expect(computeFitWidthScale).toHaveBeenCalledWith(null, { page: 928 });
            expect(buildResizeAnchorContext).toHaveBeenCalledOnce();
            expect(buildResizeAnchorContext).toHaveBeenCalledWith({
                preferredAnchorPage: 928,
                trustPreferredAnchorPage: true,
            });
            expect(cancelInFlightPageRenders).toHaveBeenCalledTimes(1);
            expect(reRenderAllVisiblePages).toHaveBeenCalledTimes(1);
            expect(getRenderedRangeFromFirstCall(reRenderAllVisiblePages)).toEqual({
                start: 928,
                end: 928,
            });
            expect(ensurePageMetricsInRange.mock.calls).toEqual([[
                928,
                928,
            ]]);
            expect(syncCurrentPageFromViewport).toHaveBeenCalledWith(
                expect.objectContaining({ source: 'fit-width-current-page' }),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('waits for cancelled fit-width renders to settle before starting the replacement render', async () => {
        vi.useFakeTimers();
        try {
            const currentPage = ref(1);
            const cancellationSettled = createDeferred();
            const cancelInFlightPageRenders = vi.fn(() => cancellationSettled.promise);
            const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
            const syncCurrentPageFromViewport = vi.fn(async () => {});

            usePdfViewerRerenderCoordinator(createDeps({
                currentPage,
                zoomMode: computed(() => 'fit-width' as const),
                getVisibleRange: () => ({
                    start: 2,
                    end: 2,
                }),
                reRenderAllVisiblePages,
                syncCurrentPageFromViewport,
                cancelInFlightPageRenders,
                ensurePageMetricsInRange: vi.fn(async () => true),
                computeFitWidthScale: vi.fn(() => true),
                buildResizeAnchorContext: vi.fn(() => createResizeAnchor(2)),
                getMostVisiblePage: vi.fn(() => 2),
            }));

            currentPage.value = 2;
            await nextTick();
            await vi.advanceTimersByTimeAsync(80);
            await nextTick();
            await Promise.resolve();

            expect(cancelInFlightPageRenders).toHaveBeenCalledOnce();
            expect(reRenderAllVisiblePages).not.toHaveBeenCalled();

            cancellationSettled.resolve();
            await Promise.resolve();
            await nextTick();
            await Promise.resolve();
            await nextTick();

            expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({
                    rerenderSource: 'fit-width-current-page',
                    renderBufferOverride: 0,
                }),
            );
            expect(syncCurrentPageFromViewport).toHaveBeenCalledWith(
                expect.objectContaining({ source: 'fit-width-current-page' }),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not rerender custom zoom when fit mode is width and the current page changes', async () => {
        const currentPage = ref(1);
        const computeFitWidthScale = vi.fn(() => true);
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
        const syncCurrentPageFromViewport = vi.fn(async () => {});

        usePdfViewerRerenderCoordinator(createDeps({
            currentPage,
            visibleRange: ref({
                start: 1,
                end: 2,
            }),
            continuousScroll: computed(() => true),
            getVisibleRange: () => ({
                start: 1,
                end: 2,
            }),
            reRenderAllVisiblePages,
            syncCurrentPageFromViewport,
            buildResizeAnchorContext: vi.fn(() => createResizeAnchor(currentPage.value)),
            computeFitWidthScale,
            getMostVisiblePage: vi.fn(() => 2),
        }));

        currentPage.value = 2;
        await nextTick();
        await nextTick();

        expect(computeFitWidthScale).not.toHaveBeenCalled();
        expect(reRenderAllVisiblePages).not.toHaveBeenCalled();
        expect(syncCurrentPageFromViewport).not.toHaveBeenCalled();
    });

    it('renders gesture zoom frames through the low-resolution settle path', async () => {
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
        const markLowResZoomRerenderUsed = vi.fn();

        const {reRenderVisiblePagesAndSyncCurrentPage} = usePdfViewerRerenderCoordinator(createDeps({
            numPages: ref(348),
            currentPage: ref(157),
            visibleRange: ref({
                start: 157,
                end: 157,
            }),
            getVisibleRange: () => ({
                start: 157,
                end: 157,
            }),
            reRenderAllVisiblePages,
            markLowResZoomRerenderUsed,
            buildResizeAnchorContext: vi.fn(() => createResizeAnchor(157)),
            getMostVisiblePage: vi.fn(() => 157),
        }));

        await reRenderVisiblePagesAndSyncCurrentPage({
            source: 'zoom-gesture-change',
            stabilize: true,
            resizeAnchor: createResizeAnchor(157),
        });

        expect(markLowResZoomRerenderUsed).toHaveBeenCalled();
        expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({
                rerenderSource: 'zoom-gesture-change',
                renderBufferOverride: 0,
                maxCanvasPixelsOverride: 14_000_000,
            }),
        );
    });

    it('renders toolbar zoom-change frames without the low-resolution canvas cap', async () => {
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
        const markLowResZoomRerenderUsed = vi.fn();

        const {reRenderVisiblePagesAndSyncCurrentPage} = usePdfViewerRerenderCoordinator(createDeps({
            numPages: ref(348),
            currentPage: ref(157),
            visibleRange: ref({
                start: 157,
                end: 157,
            }),
            getVisibleRange: () => ({
                start: 157,
                end: 157,
            }),
            reRenderAllVisiblePages,
            markLowResZoomRerenderUsed,
            buildResizeAnchorContext: vi.fn(() => createResizeAnchor(157)),
            getMostVisiblePage: vi.fn(() => 157),
        }));

        await reRenderVisiblePagesAndSyncCurrentPage({
            source: 'zoom-change',
            stabilize: true,
            resizeAnchor: createResizeAnchor(157),
        });

        expect(markLowResZoomRerenderUsed).not.toHaveBeenCalled();
        expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({
                rerenderSource: 'zoom-change',
                renderBufferOverride: 0,
            }),
        );
        expect(reRenderAllVisiblePages.mock.calls[0]?.[1]).not.toHaveProperty('maxCanvasPixelsOverride');
    });

    it('treats custom zoom-mode changes as zoom-like rerenders without gesture caps', async () => {
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
        const markLowResZoomRerenderUsed = vi.fn();
        const syncCurrentPageFromViewport = vi.fn(async () => {});
        const resizeAnchor = createResizeAnchor(157);

        const {reRenderVisiblePagesAndSyncCurrentPage} = usePdfViewerRerenderCoordinator(createDeps({
            numPages: ref(348),
            currentPage: ref(157),
            visibleRange: ref({
                start: 157,
                end: 157,
            }),
            getVisibleRange: () => ({
                start: 157,
                end: 157,
            }),
            reRenderAllVisiblePages,
            markLowResZoomRerenderUsed,
            syncCurrentPageFromViewport,
            buildResizeAnchorContext: vi.fn(() => resizeAnchor),
            getMostVisiblePage: vi.fn(() => 157),
        }));

        await reRenderVisiblePagesAndSyncCurrentPage({
            source: PDF_RERENDER_SOURCE.ZoomModeChange,
            stabilize: true,
            resizeAnchor,
        });

        expect(markLowResZoomRerenderUsed).not.toHaveBeenCalled();
        expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({
                preserveExistingPages: true,
                rerenderSource: PDF_RERENDER_SOURCE.ZoomModeChange,
                renderBufferOverride: 0,
            }),
        );
        expect(reRenderAllVisiblePages.mock.calls[0]?.[1]).not.toHaveProperty('maxCanvasPixelsOverride');
        expect(syncCurrentPageFromViewport).toHaveBeenCalledWith(
            expect.objectContaining({
                source: PDF_RERENDER_SOURCE.ZoomModeChange,
                resizeAnchor,
            }),
        );
    });

    it('clamps horizontal scroll after fit-width rerenders', async () => {
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
        const syncHorizontalScrollForZoomMode = vi.fn(() => true);

        const {reRenderVisiblePagesAndSyncCurrentPage} = usePdfViewerRerenderCoordinator(createDeps({
            numPages: ref(348),
            currentPage: ref(157),
            visibleRange: ref({
                start: 157,
                end: 157,
            }),
            zoomMode: computed(() => 'fit-width' as const),
            continuousScroll: computed(() => true),
            getVisibleRange: () => ({
                start: 157,
                end: 157,
            }),
            reRenderAllVisiblePages,
            buildResizeAnchorContext: vi.fn(() => createResizeAnchor(157)),
            syncHorizontalScrollForZoomMode,
            getMostVisiblePage: vi.fn(() => 157),
        }));

        await reRenderVisiblePagesAndSyncCurrentPage({
            source: 'resize-settle',
            stabilize: true,
            resizeAnchor: createResizeAnchor(157),
        });

        expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({rerenderSource: 'resize-settle'}),
        );
        expect(syncHorizontalScrollForZoomMode).toHaveBeenCalled();
    });

    it('still completes fit-width rerenders when horizontal clamping reports no change', async () => {
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
        const syncHorizontalScrollForZoomMode = vi.fn(() => false);

        const {reRenderVisiblePagesAndSyncCurrentPage} = usePdfViewerRerenderCoordinator(createDeps({
            numPages: ref(348),
            currentPage: ref(157),
            visibleRange: ref({
                start: 157,
                end: 157,
            }),
            zoomMode: computed(() => 'fit-width' as const),
            continuousScroll: computed(() => true),
            getVisibleRange: () => ({
                start: 157,
                end: 157,
            }),
            reRenderAllVisiblePages,
            buildResizeAnchorContext: vi.fn(() => createResizeAnchor(157)),
            syncHorizontalScrollForZoomMode,
            getMostVisiblePage: vi.fn(() => 157),
        }));

        await reRenderVisiblePagesAndSyncCurrentPage({
            source: 'resize-settle',
            stabilize: true,
            resizeAnchor: createResizeAnchor(157),
        });

        expect(reRenderAllVisiblePages).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({rerenderSource: 'resize-settle'}),
        );
        expect(syncHorizontalScrollForZoomMode).toHaveBeenCalled();
    });

    it('advances resize rerender transactions through render and settle', async () => {
        const reRenderAllVisiblePages = createReRenderAllVisiblePagesMock();
        const syncCurrentPageFromViewport = vi.fn(async () => {});
        const transactionController = {
            beginTransaction: vi.fn(() => cast({ id: 31 })),
            advanceTransaction: vi.fn(() => true),
            isTransactionCurrent: vi.fn(() => true),
        };
        const { reRenderVisiblePagesAndSyncCurrentPage } = usePdfViewerRerenderCoordinator(createDeps({
            reRenderAllVisiblePages,
            syncCurrentPageFromViewport,
            transactionController,
        }));

        await reRenderVisiblePagesAndSyncCurrentPage({
            source: 'resize-settle',
            stabilize: true,
            resizeAnchor: createResizeAnchor(3),
            transactionId: 31,
        });

        expect(transactionController.advanceTransaction).toHaveBeenCalledWith(31, 'render-requested');
        expect(transactionController.advanceTransaction).toHaveBeenCalledWith(31, 'settled');
        expect(reRenderAllVisiblePages).toHaveBeenCalledOnce();
        expect(syncCurrentPageFromViewport).toHaveBeenCalledWith(expect.objectContaining({transactionId: 31}));
    });
});
