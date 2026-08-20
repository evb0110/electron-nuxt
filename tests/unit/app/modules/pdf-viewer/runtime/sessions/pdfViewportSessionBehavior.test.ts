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
import { createDocumentOpenSurfaceSession } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import type { IDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import { createTestPdfViewportWritePort } from '@tests/helpers/createTestPdfViewportWritePort';
import { cast } from '@tests/helpers/cast';

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

function appendPageBox(
    container: HTMLElement,
    page: number,
    box: {
        height: number;
        left?: number;
        top: number;
        width?: number;
    },
) {
    const element = document.createElement('div');
    element.className = 'page_container';
    element.dataset.page = String(page);
    defineDimension(element, 'offsetTop', box.top);
    defineDimension(element, 'offsetHeight', box.height);
    defineDimension(element, 'offsetLeft', box.left ?? 0);
    defineDimension(element, 'offsetWidth', box.width ?? 600);
    container.append(element);
    return element;
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
    chassisAuthority?: IDocumentViewerChassisAuthority;
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
    const outputScale = ref(1);
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
                chassisAuthority: input.chassisAuthority ?? null,
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
                outputScale,
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
        outputScale,
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
    it('does not duplicate an anchored wheel-zoom viewport intent', () => {
        const fixture = createViewportFixture({zoomMode: 'custom'});
        try {
            const submitViewportStateIntent = vi.spyOn(
                fixture.viewport.singlePageScroll,
                'submitViewportStateIntent',
            );

            fixture.viewport.markAnchoredZoomSubmitted(1.5);
            fixture.viewport.submitZoomViewportStateIntent(1.5);

            expect(submitViewportStateIntent).not.toHaveBeenCalled();
        } finally {
            fixture.app.unmount();
        }
    });

    it('publishes visible raster demand synchronously for effective zoom and DPR changes', () => {
        const fixture = createViewportFixture({
            bufferPages: 0,
            continuousScroll: true,
            pageCount: 10,
            zoomMode: 'custom',
        });
        try {
            appendPageBox(fixture.container, 1, {
                height: 900,
                top: 0,
            });
            fixture.viewport.markPageMounted(1);
            const initialRevision = fixture.viewport.demand.value.revision;

            fixture.zoom.value = 3.02;
            const zoomRevision = fixture.viewport.demand.value.revision;
            expect(zoomRevision).toBeGreaterThan(initialRevision);
            expect(fixture.viewport.demand.value.requiredPages).toEqual([1]);

            fixture.outputScale.value = 2;
            expect(fixture.viewport.demand.value.revision).toBeGreaterThan(zoomRevision);
            expect(fixture.viewport.demand.value.requiredPages).toEqual([1]);
        } finally {
            fixture.app.unmount();
        }
    });

    it('remeasures continuous facing visibility as newly mounted rows settle without user scroll', async () => {
        const fixture = createViewportFixture({
            bufferPages: 0,
            continuousScroll: true,
            pageCount: 30,
            viewMode: 'facing',
            zoomMode: 'custom',
        });
        try {
            setCurrentPage(fixture.viewport, 9);
            fixture.viewport.visibleRange.value = {
                start: 9,
                end: 10,
            };
            await nextTick();

            const settlingRow: HTMLElement[] = [];
            for (const [
                page,
                top,
            ] of [
                    [
                        9,
                        0,
                    ],
                    [
                        10,
                        0,
                    ],
                    [
                        11,
                        400,
                    ],
                    [
                        12,
                        400,
                    ],
                    [
                        13,
                        810,
                    ],
                    [
                        14,
                        810,
                    ],
                ] as const) {
                const element = appendPageBox(fixture.container, page, {
                    height: 390,
                    top,
                });
                if (page >= 13) {
                    settlingRow.push(element);
                }
                fixture.viewport.markPageMounted(page);
            }
            expect(fixture.viewport.visibleRange.value).toEqual({
                start: 9,
                end: 12,
            });
            settlingRow.forEach(element => defineDimension(element, 'offsetTop', 790));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

            expect(fixture.viewport.visibleRange.value).toEqual({
                start: 9,
                end: 14,
            });
            expect(fixture.viewport.demand.value.visibleRange).toEqual({
                start: 9,
                end: 14,
            });
            expect(fixture.viewport.demand.value.requiredPages).toEqual([
                9,
                10,
                11,
                12,
                13,
                14,
            ]);
        } finally {
            fixture.app.unmount();
        }
    });

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
                    expect(mandatory?.options.suppressResidentRasterDemand).toBe(true);
                    rasterId = mandatory!.id;
                });
                fixture.viewport.settleMandatoryRaster(rasterId);
                await vi.waitFor(() => {
                    const mandatory = fixture.viewport.demand.value.mandatoryRaster;
                    expect(mandatory?.id).toBeGreaterThan(rasterId);
                    expect(mandatory?.options.suppressResidentRasterDemand).toBe(true);
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

    it('reconciles a staged opening canvas when viewport layout publishes later', async () => {
        const surface = createDocumentOpenSurfaceSession();
        const generation = surface.begin({
            documentId: 'warm-open.pdf',
            documentRevision: 'revision-1',
        });
        surface.metadataReady(10);
        expect(surface.commitGeometry(generation, {
            width: 600,
            height: 900,
            margin: 20,
        })).toBe(true);
        const fixture = createViewportFixture({
            chassisAuthority: cast<IDocumentViewerChassisAuthority>({openSurface: surface}),
            pageCount: 0,
        });
        try {
            const renderFence = surface.createRenderFence({
                generation,
                documentRevision: 'revision-1',
                renderVersion: 1,
                requestId: 3,
                pageNumber: 1,
            });
            expect(renderFence).not.toBeNull();
            expect(surface.commitCanvas(renderFence!)).toBe(true);
            await nextTick();
            expect(surface.snapshot.value.committedViewport).toBeNull();

            fixture.container.scrollTop = 4_000;
            fixture.documentSession.numPages.value = 10;
            fixture.documentSession.pageMetrics.value = Array.from({length: 10}, () => ({
                width: 600,
                height: 900,
            }));
            fixture.documentSession.pageMetricsVersion.value += 1;

            await vi.waitFor(() => expect(surface.snapshot.value.committedViewport).toMatchObject({
                documentRevision: 'revision-1',
                pageNumber: 1,
                viewportIntentId: renderFence!.viewportIntentId,
            }));
            expect(fixture.container.scrollTop).toBe(0);
        } finally {
            fixture.app.unmount();
        }
    });

    it('does not restore a staged opening page after navigation supersedes it', async () => {
        const surface = createDocumentOpenSurfaceSession();
        const generation = surface.begin({
            documentId: 'superseded-open.pdf',
            documentRevision: 'revision-1',
        });
        surface.metadataReady(10);
        expect(surface.commitGeometry(generation, {
            width: 600,
            height: 900,
            margin: 20,
        })).toBe(true);
        const fixture = createViewportFixture({
            chassisAuthority: cast<IDocumentViewerChassisAuthority>({openSurface: surface}),
            pageCount: 0,
        });
        try {
            const renderFence = surface.createRenderFence({
                generation,
                documentRevision: 'revision-1',
                renderVersion: 1,
                requestId: 4,
                pageNumber: 1,
            });
            expect(renderFence).not.toBeNull();
            expect(surface.commitCanvas(renderFence!)).toBe(true);
            await nextTick();
            expect(surface.snapshot.value.committedViewport).toBeNull();

            fixture.container.scrollTop = 4_000;
            expect(surface.requestNavigation(2, 0)).toBe(2);
            expect(surface.viewportSession.value.requestedPage).toBe(2);
            fixture.documentSession.numPages.value = 10;
            fixture.documentSession.pageMetrics.value = Array.from({length: 10}, () => ({
                width: 600,
                height: 900,
            }));
            fixture.documentSession.pageMetricsVersion.value += 1;
            await nextTick();

            expect(surface.snapshot.value.committedViewport).toBeNull();
            expect(surface.viewportSession.value.requestedPage).toBe(2);
            expect(fixture.container.scrollTop).toBe(4_000);
        } finally {
            fixture.app.unmount();
        }
    });

    it('leaves staged opening authority with the active viewport intent until it settles', async () => {
        const surface = createDocumentOpenSurfaceSession();
        const generation = surface.begin({
            documentId: 'intent-owned-open.pdf',
            documentRevision: 'revision-1',
        });
        surface.metadataReady(10);
        expect(surface.commitGeometry(generation, {
            width: 600,
            height: 900,
            margin: 20,
        })).toBe(true);
        const fixture = createViewportFixture({
            chassisAuthority: cast<IDocumentViewerChassisAuthority>({openSurface: surface}),
            pageCount: 10,
        });
        const metrics = Promise.withResolvers<boolean>();
        try {
            fixture.viewport.markPageMounted(1);
            fixture.documentSession.ensurePageMetricsInRange.mockReturnValueOnce(metrics.promise);
            const intent = fixture.viewport.singlePageScroll.submitViewportStateIntent('fit');
            await vi.waitFor(() => expect(
                fixture.viewport.singlePageScroll.viewportAuthority.activeIntent.value,
            ).not.toBeNull());
            const renderFence = surface.createRenderFence({
                generation,
                documentRevision: 'revision-1',
                renderVersion: 1,
                requestId: 4,
                pageNumber: 1,
            });
            expect(renderFence).not.toBeNull();
            expect(surface.commitCanvas(renderFence!)).toBe(true);
            await nextTick();
            expect(surface.snapshot.value.committedViewport).toBeNull();

            metrics.resolve(true);
            await intent;
            await vi.waitFor(() => expect(surface.snapshot.value.committedViewport?.pageNumber).toBe(1));
        } finally {
            metrics.resolve(true);
            fixture.app.unmount();
        }
    });
});
