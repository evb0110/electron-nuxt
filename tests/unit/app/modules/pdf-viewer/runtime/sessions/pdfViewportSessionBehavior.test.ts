// @vitest-environment happy-dom

import {
    computed,
    createApp,
    defineComponent,
    nextTick,
    ref,
    shallowRef,
} from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type {
    IPdfDocumentTransition,
    TPdfDocumentSession,
} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import { createPdfViewportSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import { resolvePdfRenderPerformancePolicy } from '@app/modules/pdf-viewer/engine/pdf-render-performance/resolvePdfRenderPerformancePolicy';
import { createTestPdfViewportWritePort } from '@tests/helpers/createTestPdfViewportWritePort';

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    diagnostic: vi.fn(),
    diagnosticThrottled: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    warnThrottled: vi.fn(),
    debug: vi.fn(),
}}));

const performancePolicy = resolvePdfRenderPerformancePolicy({
    lowCpu: false,
    lowMemory: false,
});

function defineDimension(element: HTMLElement, property: string, value: number) {
    Object.defineProperty(element, property, {
        configurable: true,
        value,
    });
}

function createDocumentFixture(pageCount = 100) {
    const subscribers: Array<(transition: IPdfDocumentTransition) => void | Promise<void>> = [];
    const pageMetrics = ref(Array.from({ length: pageCount }, () => ({
        width: 600,
        height: 900,
    })));
    const pageMetricsVersion = ref(0);
    const document = {numPages: pageCount} as PDFDocumentProxy;
    const fixture = {
        pdfDocument: shallowRef<PDFDocumentProxy | null>(document),
        numPages: ref(pageCount),
        isLoading: ref(false),
        basePageWidth: ref<number | null>(600),
        basePageHeight: ref<number | null>(900),
        pageMetrics,
        pageMetricsVersion,
        acceptedSource: computed(() => new Blob(['pdf'], {type: 'application/pdf'})),
        ensurePageMetricsInRange: vi.fn(async () => true),
        hasExactPageGeometry: vi.fn(() => true),
        captureFence: () => ({
            loadToken: 1,
            documentVersion: 1,
            documentRevision: 'revision-1',
            openSurfaceGeneration: 1,
        }),
        getRenderVersion: () => 1,
        subscribe(callback: (transition: IPdfDocumentTransition) => void | Promise<void>) {
            subscribers.push(callback);
            return () => {
                const index = subscribers.indexOf(callback);
                if (index >= 0) {
                    subscribers.splice(index, 1);
                }
            };
        },
        registerDisposable: vi.fn(),
        async emit(transition: IPdfDocumentTransition) {
            for (const subscriber of [...subscribers]) {
                await subscriber(transition);
            }
        },
    };
    return fixture as typeof fixture & TPdfDocumentSession;
}

function createViewportFixture(input: {
    bufferPages?: number;
    continuousScroll?: boolean;
    pageCount?: number;
    viewMode?: 'single' | 'facing' | 'facing-first-single';
    zoom?: Ref<number>;
    zoomMode?: 'custom' | 'fit-width' | 'fit-height';
} = {}) {
    const container = document.createElement('div');
    defineDimension(container, 'clientHeight', 800);
    defineDimension(container, 'clientWidth', 800);
    defineDimension(container, 'scrollHeight', 120_000);
    container.scrollTop = 0;
    const viewerContainer = ref<HTMLElement | null>(container);
    const documentSession = createDocumentFixture(input.pageCount);
    const zoom = input.zoom ?? ref(1);
    const zoomMode = ref(input.zoomMode ?? 'fit-width');
    const viewMode = ref(input.viewMode ?? 'single');
    const emittedPages: number[] = [];
    const {port} = createTestPdfViewportWritePort();
    let viewport: ReturnType<typeof createPdfViewportSession> | undefined;
    const root = document.createElement('div');
    const app = createApp(defineComponent({
        name: 'PdfViewportSessionBehaviorFixture',
        setup() {
            viewport = createPdfViewportSession({
                document: documentSession,
                chassisAuthority: null,
                performancePolicy,
                maxBufferCanvasPixels: 100,
                settledMaxCanvasPixels: 1_000_000,
                viewerContainer,
                viewportWritePort: port,
                zoom: computed(() => zoom.value),
                zoomMode: computed(() => zoomMode.value),
                fitMode: computed(() => 'width'),
                viewMode: computed(() => viewMode.value),
                continuousScroll: computed(() => input.continuousScroll ?? true),
                bufferPages: computed(() => input.bufferPages ?? 3),
                isActive: computed(() => true),
                isResizing: computed(() => false),
                requestedCurrentPage: ref(undefined),
                outputScale: ref(1),
                selectionMarkupStyle: computed(() => null),
                classState: {
                    isAnySaving: computed(() => false),
                    isDragging: ref(false),
                    isViewerPanDragModeActive: computed(() => false),
                    isPlacingComment: ref(false),
                    isSelectionMarkupToolActive: computed(() => false),
                    isTextSelectionModeActive: computed(() => false),
                    fitMode: computed(() => 'width'),
                    zoomMode: computed(() => zoomMode.value),
                    resizeTransitionVisible: ref(false),
                    zoomSnapSuppressed: ref(false),
                },
                emitCurrentPage: page => {
                    emittedPages.push(page);
                },
                emitNavigationFeedbackPage: vi.fn(),
                emitZoom: value => {
                    zoom.value = value;
                },
                emitEffectiveZoom: vi.fn(),
                summarizeViewerStateForLog: vi.fn(),
                clearPendingImagePlacement: vi.fn(),
            });
            return () => null;
        },
    }));
    app.mount(root);
    if (!viewport) {
        throw new Error('Failed to create PDF viewport session fixture');
    }
    return {
        app,
        container,
        documentSession,
        emittedPages,
        viewport,
        viewMode,
        zoom,
        zoomMode,
    };
}

function setCurrentPage(
    viewport: ReturnType<typeof createPdfViewportSession>,
    page: number,
) {
    viewport.singlePageScroll.viewportAuthority.observeUserScroll({
        affinity: 'start',
        page,
        pageXFraction: 0,
        pageYFraction: 0,
        viewportXFraction: 0,
        viewportYFraction: 0,
    });
}

function transition(
    phase: IPdfDocumentTransition['phase'],
    plan: IPdfDocumentTransition['plan'],
): IPdfDocumentTransition {
    return {
        phase,
        fence: {
            loadToken: 2,
            documentVersion: 2,
            documentRevision: 'revision-2',
            openSurfaceGeneration: 2,
        },
        plan,
        reason: 'test',
        isCurrent: () => true,
    };
}

describe('PdfViewportSession behavior', () => {
    it('orders required and nearby mounted demand within the shared pixel budget', async () => {
        const fixture = createViewportFixture({
            bufferPages: 4,
            continuousScroll: false,
            pageCount: 100,
        });
        try {
            fixture.documentSession.basePageWidth.value = 2;
            fixture.documentSession.basePageHeight.value = 20;
            fixture.documentSession.pageMetrics.value = Array.from({length: 100}, (_, index) => ({
                width: 2,
                height: index === 42 ? 500 : 20,
            }));
            fixture.documentSession.pageMetricsVersion.value += 1;
            setCurrentPage(fixture.viewport, 43);
            fixture.viewport.visibleRange.value = {
                start: 43,
                end: 43,
            };
            for (let page = 39; page <= 47; page += 1) {
                fixture.viewport.markPageMounted(page);
            }
            await nextTick();

            expect(fixture.viewport.demand.value.requiredPages).toEqual([43]);
            expect(fixture.viewport.demand.value.nearbyPages).toEqual([
                44,
                42,
            ]);
            expect(fixture.viewport.demand.value.residentPages).toEqual([
                43,
                44,
                42,
            ]);

            fixture.viewport.markPageUnmounted(44);
            expect(fixture.viewport.demand.value.residentPages).toEqual([
                43,
                42,
                45,
            ]);
            expect(fixture.viewport.demand.value.residentPages).not.toContain(44);
        } finally {
            fixture.app.unmount();
        }
    });

    it('recomputes the mounted geometry window from the active scroll offset', async () => {
        const fixture = createViewportFixture({
            bufferPages: 0,
            pageCount: 100,
        });
        try {
            fixture.container.scrollTop = 10_000;
            fixture.viewport.visibleRange.value = {
                start: 1,
                end: 1,
            };
            fixture.documentSession.pageMetricsVersion.value += 1;
            await nextTick();
            const provisionalStart = fixture.viewport.visibleRange.value.start;
            expect(provisionalStart).toBeGreaterThan(1);
            expect(fixture.viewport.viewModel.pagesToRender.value).toContain(provisionalStart);

            fixture.documentSession.basePageHeight.value = 100;
            fixture.documentSession.pageMetrics.value = Array.from({length: 100}, () => ({
                width: 600,
                height: 100,
            }));
            fixture.documentSession.pageMetricsVersion.value += 1;
            await nextTick();

            expect(fixture.viewport.visibleRange.value.start).toBeGreaterThan(provisionalStart);
            expect(fixture.viewport.viewModel.pagesToRender.value)
                .toContain(fixture.viewport.visibleRange.value.start);
            expect(fixture.viewport.viewModel.pagesToRender.value).not.toContain(provisionalStart);
        } finally {
            fixture.app.unmount();
        }
    });

    it('owns trusted native scroll projection without the navigation or wheel adapters', async () => {
        const fixture = createViewportFixture({
            bufferPages: 0,
            pageCount: 100,
        });
        try {
            fixture.documentSession.basePageHeight.value = 100;
            fixture.documentSession.pageMetrics.value = Array.from({length: 100}, () => ({
                width: 600,
                height: 100,
            }));
            fixture.documentSession.pageMetricsVersion.value += 1;
            await nextTick();
            const epoch = fixture.viewport.userViewportInteractionEpoch.value;
            const legacyRangeUpdate = vi.spyOn(fixture.viewport.scroll, 'updateVisibleRange');
            const legacyVisibility = vi.spyOn(fixture.viewport.scroll, 'getViewportVisibility');

            fixture.container.scrollTop = 10_000;
            fixture.viewport.handleTrustedScroll({isTrusted: true} as Event);

            expect(legacyRangeUpdate).not.toHaveBeenCalled();
            expect(legacyVisibility).not.toHaveBeenCalled();
            expect(fixture.viewport.userViewportInteractionEpoch.value).toBe(epoch + 1);
            expect(fixture.viewport.currentPage.value).toBeGreaterThan(1);
            expect(fixture.viewport.visibleRange.value.start).toBeGreaterThan(1);
            expect(fixture.emittedPages.at(-1)).toBe(fixture.viewport.currentPage.value);
        } finally {
            fixture.app.unmount();
        }
    });

    it('releases a retained navigation row when a direct scroll moves the viewport', async () => {
        const fixture = createViewportFixture({
            bufferPages: 0,
            pageCount: 100,
        });
        try {
            fixture.documentSession.basePageHeight.value = 100;
            fixture.documentSession.pageMetrics.value = Array.from({length: 100}, () => ({
                width: 600,
                height: 100,
            }));
            fixture.documentSession.pageMetricsVersion.value += 1;
            await nextTick();

            fixture.viewport.singlePageScroll.scrollToPage(1);
            await vi.waitFor(() => {
                expect(fixture.viewport.singlePageScroll.navigationAnchorPage.value).toBe(1);
            });

            fixture.container.scrollTop = 10_000;
            fixture.viewport.handleTrustedScroll({isTrusted: true} as Event);

            expect(fixture.viewport.singlePageScroll.navigationAnchorPage.value).toBeNull();
            expect(fixture.viewport.currentPage.value).toBeGreaterThan(1);
            expect(fixture.viewport.visibleRange.value.start).toBeGreaterThan(1);
            expect(fixture.viewport.viewModel.pagesToRender.value)
                .toContain(fixture.viewport.visibleRange.value.start);
            expect(fixture.viewport.viewModel.pagesToRender.value).not.toContain(1);
        } finally {
            fixture.app.unmount();
        }
    });

    it('keeps authority and wheel-zoom scroll passive until their fences clear', async () => {
        const fixture = createViewportFixture({
            bufferPages: 0,
            pageCount: 100,
        });
        try {
            fixture.documentSession.basePageHeight.value = 100;
            fixture.documentSession.pageMetrics.value = Array.from({length: 100}, () => ({
                width: 600,
                height: 100,
            }));
            fixture.documentSession.pageMetricsVersion.value += 1;
            await nextTick();
            const observeUserScroll = vi.spyOn(
                fixture.viewport.singlePageScroll.viewportAuthority,
                'observeUserScroll',
            );
            const consumeAuthorityScroll = vi.spyOn(
                fixture.viewport.viewportWritePort,
                'consumeAuthorityScroll',
            ).mockReturnValueOnce(true).mockReturnValue(false);
            const epoch = fixture.viewport.userViewportInteractionEpoch.value;

            fixture.container.scrollTop = 5_000;
            fixture.viewport.handleTrustedScroll({isTrusted: true} as Event);
            expect(consumeAuthorityScroll).toHaveBeenCalledOnce();
            expect(observeUserScroll).not.toHaveBeenCalled();
            expect(fixture.viewport.userViewportInteractionEpoch.value).toBe(epoch);
            expect(fixture.viewport.visibleRange.value.start).toBeGreaterThan(1);

            fixture.viewport.zoomSnapSuppressedForClass.value = true;
            fixture.container.scrollTop = 7_500;
            fixture.viewport.handleTrustedScroll({isTrusted: true} as Event);
            expect(observeUserScroll).not.toHaveBeenCalled();
            expect(fixture.viewport.userViewportInteractionEpoch.value).toBe(epoch);

            fixture.viewport.zoomSnapSuppressedForClass.value = false;
            fixture.viewport.handleTrustedScroll({isTrusted: true} as Event);
            expect(observeUserScroll).toHaveBeenCalledOnce();
            expect(fixture.viewport.userViewportInteractionEpoch.value).toBe(epoch + 1);
        } finally {
            fixture.app.unmount();
        }
    });

    it('protects the complete facing-page target row and stops layout writes after cancellation', async () => {
        const fixture = createViewportFixture({
            continuousScroll: false,
            pageCount: 10,
            viewMode: 'facing',
            zoomMode: 'fit-height',
        });
        try {
            setCurrentPage(fixture.viewport, 4);
            fixture.viewport.visibleRange.value = {
                start: 1,
                end: 2,
            };
            const metrics = Promise.withResolvers<boolean>();
            fixture.documentSession.ensurePageMetricsInRange
                .mockResolvedValueOnce(true)
                .mockReturnValueOnce(metrics.promise);
            expect(fixture.viewport.singlePageScroll.scrollToPage(4)).toBe(true);

            expect(fixture.viewport.getProtectedVisibleRange()).toEqual({
                start: 3,
                end: 4,
            });
            expect(fixture.viewport.isVisibleRenderRangeCurrent({
                start: 3,
                end: 4,
            })).toBe(true);

            await vi.waitFor(() => {
                expect(fixture.documentSession.ensurePageMetricsInRange).toHaveBeenCalledWith(3, 4);
            });
            fixture.viewport.singlePageScroll.cancelProgrammaticNavigation('test-cancel');
            metrics.resolve(true);
            await nextTick();

            expect(fixture.viewport.singlePageScroll.navigationAnchorPage.value).toBeNull();
            expect(fixture.viewport.singlePageScroll.isProgrammaticNavigationActive.value).toBe(false);
        } finally {
            fixture.app.unmount();
        }
    });

    it('keeps reload target and custom display zoom while fit reloads retain their fit mode', async () => {
        const customZoom = ref(1.94);
        const fixture = createViewportFixture({
            continuousScroll: false,
            pageCount: 300,
            zoom: customZoom,
            zoomMode: 'custom',
        });
        try {
            const settleReadyPlacement = async () => {
                const ready = fixture.documentSession.emit(transition('ready', reloadPlan));
                let rasterId = 0;
                await vi.waitFor(() => {
                    const mandatory = fixture.viewport.demand.value.mandatoryRaster;
                    expect(mandatory).not.toBeNull();
                    rasterId = mandatory!.id;
                });
                fixture.viewport.settleMandatoryRaster(rasterId);
                await vi.waitFor(() => {
                    const mandatory = fixture.viewport.demand.value.mandatoryRaster;
                    expect(mandatory?.id).toBeGreaterThan(rasterId);
                    rasterId = mandatory!.id;
                });
                fixture.viewport.settleMandatoryRaster(rasterId);
                await ready;
            };
            setCurrentPage(fixture.viewport, 200);
            const reloadPlan = {
                isReload: true,
                isSelectiveReload: false,
                pagesToInvalidate: null,
                preserveVisibleContent: false,
                preservePageStructure: false,
            };
            await fixture.documentSession.emit(transition('loading', reloadPlan));
            await settleReadyPlacement();

            expect(fixture.zoom.value).toBe(1.94);
            expect(fixture.emittedPages.at(-1)).toBe(200);

            fixture.zoomMode.value = 'fit-width';
            await fixture.documentSession.emit(transition('loading', reloadPlan));
            await settleReadyPlacement();
            expect(fixture.zoomMode.value).toBe('fit-width');
            expect(fixture.emittedPages.at(-1)).toBe(200);
        } finally {
            fixture.app.unmount();
        }
    });
});
