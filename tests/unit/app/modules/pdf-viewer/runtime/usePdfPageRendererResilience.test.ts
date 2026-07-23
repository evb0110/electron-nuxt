import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import {
    ref,
    shallowRef,
} from 'vue';
import type { Ref } from 'vue';
import type { IPdfSearchMatch } from '@app/types/pdfUi';
import { cast } from '@tests/helpers/cast';
import { createTestPdfViewportWritePort } from '@tests/helpers/createTestPdfViewportWritePort';
import {
    createTestPageContainer as createPageContainer,
    createTestPageContainerRoot as createContainerRoot,
    createTestPageLease as createPageLease,
    createTestPageRenderResult as createRenderResult,
    type ITestNode as INodeLike,
} from '@tests/helpers/domGeometryTestHarness';

const loggerError = vi.fn();
const loggerWarn = vi.fn();

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    diagnostic: vi.fn(),
    diagnosticThrottled: vi.fn(),
    error: loggerError,
    warn: loggerWarn,
    warnThrottled: vi.fn(),
    debug: vi.fn(),
}}));

interface IRenderContext {
    canvasContext: unknown;
    canvas?: unknown;
    transform?: unknown;
    viewport: {
        width: number;
        height: number;
    };
}

const canvasRendererMock = {
    cleanupCanvas: vi.fn(),
    estimateRequestedPixels: vi.fn(() => 100_000_000),
    renderCanvas: vi.fn(),
    prepareCanvasRender: vi.fn(async (...args: unknown[]) => {
        const renderResult = await canvasRendererMock.renderCanvas(...args);
        if (!renderResult) {
            return null;
        }

        return {
            ...renderResult,
            startRender: () => ({
                cancel: vi.fn(),
                promise: Promise.resolve(),
            }),
        };
    }),
    applyContainerUserUnit: vi.fn(),
    mountCanvas: vi.fn(),
};

const textLayerRendererMock = {
    renderTextLayer: vi.fn(),
    setupTextLayerInteraction: vi.fn(),
    applyPageSearchHighlights: vi.fn(),
    applyAllSearchHighlights: vi.fn(),
    scrollToCurrentMatch: vi.fn(() => false),
    cleanupTextLayerDom: vi.fn(),
    clearOcrDebug: vi.fn(),
    isOcrDebugEnabled: vi.fn(() => false),
    renderOcrDebugBoxes: vi.fn(async () => {}),
    getCurrentMatchRanges: vi.fn(() => []),
};

const annotationLayerRendererMock = {
    renderAnnotationLayer: vi.fn(),
    renderAnnotationEditorLayer: vi.fn(async () => ({
        ok: true,
        rendered: true,
    })),
    cleanupEditorLayer: vi.fn(),
    clearAllLayers: vi.fn(),
};

vi.mock('@app/modules/pdf-viewer/runtime/composables/pdf/usePdfCanvasRenderer', () => ({usePdfCanvasRenderer: () => canvasRendererMock}));

vi.mock('@app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer', () => ({usePdfTextLayerRenderer: () => textLayerRendererMock}));

vi.mock('@app/modules/pdf-viewer/runtime/rendering/usePdfAnnotationLayerRenderer', () => ({usePdfAnnotationLayerRenderer: () => annotationLayerRendererMock}));

const { usePdfPageRenderer: usePdfPageRendererProduction } = await import('@app/modules/pdf-viewer/runtime/rendering/usePdfPageRenderer');
type TPdfPageRendererOptions = Omit<
    Parameters<typeof usePdfPageRendererProduction>[0],
    'viewportWritePort'
>;
const usePdfPageRenderer = (
    options: Pick<TPdfPageRendererOptions, 'container' | 'document'>
        & Partial<TPdfPageRendererOptions>,
) => usePdfPageRendererProduction({
    currentPage: ref(1),
    effectiveScale: ref(1),
    bufferPages: ref(0),
    showAnnotations: ref(true),
    annotationUiManager: ref(null),
    annotationL10n: ref(null),
    searchPageMatches: ref(new Map()),
    currentSearchMatch: ref(null),
    workingCopyPath: ref(null),
    viewportWritePort: createTestPdfViewportWritePort().port,
    ...options,
});
const {
    PDF_PAGE_RENDER_TIMEOUT_MS,
    PDF_PAGE_TEXT_LAYER_TIMEOUT_MS,
} = await import('@app/constants/timeouts');

function createDocumentState<TOverrides extends object>(
    overrides: TOverrides = {} as TOverrides,
) {
    return {
        pdfDocument: shallowRef({} as object),
        numPages: ref(1),
        basePageWidth: ref(100),
        basePageHeight: ref(100),
        isLoading: ref(false),
        ensurePageMetricsInRange: vi.fn(async () => false),
        leasePage: vi.fn(async () => createPageLease({render: vi.fn(() => ({promise: Promise.resolve()}))})),
        evictPage: vi.fn(),
        cleanupPageCache: vi.fn(),
        ...overrides,
    };
}

describe('usePdfPageRenderer resilience', () => {
    beforeEach(() => {
        canvasRendererMock.mountCanvas.mockImplementation((host: INodeLike, canvas: unknown) => {
            host.appendChild?.(canvas);
        });
        canvasRendererMock.renderCanvas.mockResolvedValue(createRenderResult());
        textLayerRendererMock.renderTextLayer.mockResolvedValue(undefined);
        annotationLayerRendererMock.renderAnnotationLayer.mockResolvedValue(null);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('does not issue authoritative viewport demand from an offscreen renderer request', async () => {
        const { pageContainer: visiblePageContainer } = createPageContainer({ pageNumber: 1 });
        const { pageContainer: offscreenPageContainer } = createPageContainer({ pageNumber: 2 });
        const containerRoot = createContainerRoot([
            visiblePageContainer,
            offscreenPageContainer,
        ]);
        const leasedPages: number[] = [];
        const documentState = {
            ...createDocumentState(),
            numPages: ref(2),
            leasePage: vi.fn(async (pageNumber: number) => {
                leasedPages.push(pageNumber);
                return createPageLease({render: vi.fn(() => ({ promise: Promise.resolve() }))});
            }),
        };

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            getProtectedVisibleRange: () => ({
                start: 1,
                end: 1,
            }),
        });

        await renderer.renderVisiblePages({
            start: 2,
            end: 2,
        });
        expect(leasedPages).toEqual([2]);
        expect(renderer.isPageRendered(1)).toBe(false);
    });

    it('leaves missing-canvas retries to the shared render-demand coordinator', async () => {
        vi.useFakeTimers();
        const firstPage = createPageContainer({pageNumber: 1});
        const secondPage = createPageContainer({pageNumber: 2});
        const containerRoot = createContainerRoot([
            firstPage.pageContainer,
            secondPage.pageContainer,
        ]);
        const leasedPages: number[] = [];
        const documentState = {
            ...createDocumentState(),
            numPages: ref(2),
            leasePage: vi.fn(async (pageNumber: number) => {
                leasedPages.push(pageNumber);
                return createPageLease({render: vi.fn(() => ({promise: Promise.resolve()}))});
            }),
        };
        canvasRendererMock.mountCanvas
            .mockImplementationOnce(() => {})
            .mockImplementationOnce(() => {})
            .mockImplementation((host: INodeLike, canvas: unknown) => {
                host.appendChild?.(canvas);
            });

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            getProtectedVisibleRange: () => ({
                start: 1,
                end: 2,
            }),
        });

        await renderer.renderVisiblePages({
            start: 1,
            end: 2,
        });
        expect(firstPage.pageContainer.querySelector?.('.page_canvas canvas')).toBeNull();
        expect(secondPage.pageContainer.querySelector?.('.page_canvas canvas')).toBeNull();

        await vi.advanceTimersByTimeAsync(0);
        expect(firstPage.pageContainer.querySelector?.('.page_canvas canvas')).toBeNull();
        expect(secondPage.pageContainer.querySelector?.('.page_canvas canvas')).toBeNull();

        expect(leasedPages).toEqual([
            1,
            2,
        ]);
        expect(canvasRendererMock.renderCanvas.mock.calls).toHaveLength(2);
    });

    it('does not let postcondition recovery supersede an active required-page render', async () => {
        vi.useFakeTimers();
        const {pageContainer} = createPageContainer();
        let resolveFirstMetrics!: (value: boolean) => void;
        const firstMetrics = new Promise<boolean>((resolve) => {
            resolveFirstMetrics = resolve;
        });
        let resolveCanvas!: (value: ReturnType<typeof createRenderResult>) => void;
        const canvasResult = new Promise<ReturnType<typeof createRenderResult>>((resolve) => {
            resolveCanvas = resolve;
        });
        const leasePage = vi.fn(async () => createPageLease({render: vi.fn(() => ({promise: Promise.resolve()}))}));
        const ensurePageMetricsInRange = vi.fn()
            .mockReturnValueOnce(firstMetrics)
            .mockResolvedValue(false);
        canvasRendererMock.renderCanvas.mockReturnValue(canvasResult);
        const renderer = usePdfPageRenderer({
            container: ref(createContainerRoot(pageContainer)),
            document: createDocumentState({
                numPages: ref(1),
                ensurePageMetricsInRange,
                leasePage,
            }) as never,
        });

        const staleRender = renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });
        const authoritativeRender = renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });
        await vi.waitFor(() => expect(canvasRendererMock.renderCanvas).toHaveBeenCalledOnce());
        resolveFirstMetrics(false);
        await staleRender;
        await vi.advanceTimersByTimeAsync(0);

        expect(leasePage).toHaveBeenCalledOnce();
        expect(canvasRendererMock.renderCanvas).toHaveBeenCalledOnce();

        resolveCanvas(createRenderResult());
        await authoritativeRender;
    });


    it('does not arm visible recovery work while the viewer is inactive', async () => {
        vi.useFakeTimers();
        const isActive = ref(false);
        const {pageContainer} = createPageContainer();
        const renderer = usePdfPageRenderer({
            container: ref(createContainerRoot(pageContainer)),
            document: createDocumentState({
                numPages: ref(1),
                leasePage: vi.fn(async () => createPageLease({render: vi.fn(() => ({promise: Promise.resolve()}))})),
            }) as never,
            isActive,
        });

        await renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });
        isActive.value = true;
        await vi.advanceTimersByTimeAsync(1_000);

        expect(canvasRendererMock.renderCanvas).not.toHaveBeenCalled();
        renderer.cleanupAllPages();
    });

    it('does not replay postconditions from a render invalidated by cleanup', async () => {
        vi.useFakeTimers();
        const {
            pageContainer,
            setMountedCanvas,
        } = createPageContainer();
        let textLayerSignal: AbortSignal | null = null;
        let didAbortTextLayer = false;
        const textLayerPromise = new Promise<void>((resolve) => {
            textLayerRendererMock.renderTextLayer.mockImplementation((...args: unknown[]) => {
                textLayerSignal = args.at(-1) as AbortSignal;
                textLayerSignal.addEventListener('abort', () => {
                    didAbortTextLayer = true;
                    resolve();
                });
                return textLayerPromise;
            });
        });
        const pageLease = createPageLease({render: vi.fn(() => ({promise: Promise.resolve()}))});
        const renderer = usePdfPageRenderer({
            container: ref(createContainerRoot(pageContainer)),
            document: createDocumentState({
                numPages: ref(1),
                leasePage: vi.fn(async () => pageLease),
            }) as never,
        });

        const renderPromise = renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });
        await vi.waitFor(() => expect(textLayerRendererMock.renderTextLayer).toHaveBeenCalledOnce());
        expect(renderer.isPageRendered(1)).toBe(true);
        expect(annotationLayerRendererMock.renderAnnotationLayer).toHaveBeenCalledOnce();
        await renderPromise;
        const cleanupPromise = renderer.cleanupAllPages();
        setMountedCanvas(null);
        await cleanupPromise;
        await vi.advanceTimersByTimeAsync(1_000);

        expect(textLayerSignal).not.toBeNull();
        expect(didAbortTextLayer).toBe(true);
        expect(pageLease.release).toHaveBeenCalledOnce();
        expect(canvasRendererMock.renderCanvas).toHaveBeenCalledOnce();
        expect(textLayerRendererMock.renderTextLayer).toHaveBeenCalledOnce();
    });

    it('releases page resources after a page finishes rendering', async () => {
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);
        const cleanup = vi.fn();
        const pdfPage = {
            cleanup,
            render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() })),
        };

        const pageLease = createPageLease(pdfPage);
        const documentState = {
            ...createDocumentState(),
            numPages: ref(1),
            leasePage: vi.fn(async () => pageLease),
        };

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
        });

        await renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });

        expect(renderer.isPageRendered(1)).toBe(true);
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(documentState.evictPage).not.toHaveBeenCalled();
    });

    it('resolves in-flight render cancellation only after active PDF.js tasks settle', async () => {
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);
        const renderTask = Promise.withResolvers<undefined>();
        const cancelRenderTask = vi.fn();
        const startRender = vi.fn(() => ({
            cancel: cancelRenderTask,
            promise: renderTask.promise,
        }));
        const documentState = {
            ...createDocumentState(),
            numPages: ref(1),
            leasePage: vi.fn(async () => createPageLease({ cleanup: vi.fn() })),
        };

        canvasRendererMock.prepareCanvasRender.mockResolvedValueOnce({
            ...createRenderResult(),
            startRender,
        });

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
        });

        const renderPromise = renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });
        await vi.waitFor(() => {
            expect(startRender).toHaveBeenCalledOnce();
        });

        let cancellationSettled = false;
        const cancellationPromise = renderer.cancelInFlightRenders().then(() => {
            cancellationSettled = true;
        });
        await Promise.resolve();

        expect(cancelRenderTask).toHaveBeenCalled();
        expect(cancellationSettled).toBe(false);

        renderTask.resolve(undefined);
        await cancellationPromise;
        await renderPromise.catch(() => undefined);

        expect(cancellationSettled).toBe(true);
    });

    it('does not suppress managed embedded canvas annotations before the page overlay is mounted', async () => {
        const { pageContainer } = createPageContainer({ hasShapeOverlay: false });
        const containerRoot = createContainerRoot(pageContainer);
        const documentState = {
            ...createDocumentState(),
            numPages: ref(1),
            leasePage: vi.fn(async () => createPageLease({ cleanup: vi.fn() })),
        };

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            hiddenAnnotationIds: ref(new Set([
                '12R0',
                'deleted-annotation',
            ])),
            managedAnnotationIds: ref(new Set(['12R'])),
        });

        await renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });

        const canvasOptions = canvasRendererMock.renderCanvas.mock.calls[0]?.[2] as { hiddenAnnotationIds?: Set<string>; } | undefined;
        expect(canvasOptions?.hiddenAnnotationIds).toEqual(new Set(['deleted-annotation']));
    });

    it('suppresses managed embedded canvas annotations after the page overlay is mounted', async () => {
        const { pageContainer } = createPageContainer({ hasShapeOverlay: true });
        const containerRoot = createContainerRoot(pageContainer);
        const documentState = {
            ...createDocumentState(),
            numPages: ref(1),
            leasePage: vi.fn(async () => createPageLease({ cleanup: vi.fn() })),
        };

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            hiddenAnnotationIds: ref(new Set([
                '12R0',
                'deleted-annotation',
            ])),
            managedAnnotationIds: ref(new Set(['12R'])),
        });

        await renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });

        const canvasOptions = canvasRendererMock.renderCanvas.mock.calls[0]?.[2] as { hiddenAnnotationIds?: Set<string>; } | undefined;
        expect(canvasOptions?.hiddenAnnotationIds).toEqual(new Set([
            '12R',
            'deleted-annotation',
        ]));
    });

    it('re-renders a tracked page when the mounted canvas is missing', async () => {
        const {
            pageContainer,
            setMountedCanvas,
        } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);
        const documentState = {
            ...createDocumentState(),
            numPages: ref(1),
            leasePage: vi.fn(async () => createPageLease({ render: vi.fn(() => ({ promise: Promise.resolve() })) })),
        };

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
        });

        await renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });
        setMountedCanvas(null);
        await renderer.renderVisiblePages(
            {
                start: 1,
                end: 1,
            },
            { preserveRenderedPages: true },
        );

        expect(renderer.isPageRendered(1)).toBe(true);
        expect(canvasRendererMock.renderCanvas).toHaveBeenCalledTimes(2);
    });

    it('keeps an intact committed canvas ready across a pure render cancellation', async () => {
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: createDocumentState({
                numPages: ref(1),
                leasePage: vi.fn(async () => createPageLease({ render: vi.fn(() => ({ promise: Promise.resolve() })) })),
            }) as never,
        });

        await renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });
        expect(renderer.isPageCanvasCommitted(1)).toBe(true);

        await renderer.cancelInFlightRenders();

        expect(renderer.isPageCanvasCommitted(1)).toBe(true);
        await renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });
        expect(canvasRendererMock.renderCanvas).toHaveBeenCalledTimes(1);
    });

    it('does not run a private timer retry when a visible canvas never mounted', async () => {
        vi.useFakeTimers();
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);
        canvasRendererMock.mountCanvas.mockImplementation(() => {});

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: createDocumentState({
                numPages: ref(1),
                leasePage: vi.fn(async () => createPageLease({ render: vi.fn(() => ({ promise: Promise.resolve() })) })),
            }) as never,
        });

        await renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });
        expect(canvasRendererMock.renderCanvas).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(0);
        expect(canvasRendererMock.renderCanvas).toHaveBeenCalledTimes(1);
        await renderer.cancelInFlightRenders();
    });

    it('does not run a private render/scroll engine for search navigation', async () => {
        vi.stubGlobal('window', {});
        try {
            const { pageContainer } = createPageContainer({
                pageNumber: 2,
                offsetWidth: 6_000,
                offsetHeight: 6_000,
            });
            const containerRoot = createContainerRoot(pageContainer);
            const documentState = {
                ...createDocumentState(),
                numPages: ref(2),
                leasePage: vi.fn(async () => createPageLease({ render: vi.fn(() => ({ promise: Promise.resolve() })) })),
            };

            const renderer = usePdfPageRenderer({
                container: ref(containerRoot),
                document: documentState as never,
                currentPage: ref(1),
                effectiveScale: ref(1),
                bufferPages: ref(1),
                showAnnotations: ref(true),
                annotationUiManager: ref(null),
                annotationL10n: ref(null),
                searchPageMatches: ref(new Map()),
                currentSearchMatch: ref(cast<IPdfSearchMatch>({
                    pageIndex: 1,
                    matchIndex: 0,
                    startOffset: 0,
                    endOffset: 4,
                })),
                currentSearchMatchNavigationId: ref(0),
                workingCopyPath: ref(null),
            });

            renderer.requestScrollToCurrentResult();
            renderer.cancelPendingSearchScroll();
            await Promise.resolve();
            expect(canvasRendererMock.renderCanvas).not.toHaveBeenCalled();
            expect(canvasRendererMock.estimateRequestedPixels).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('applies search highlights before finalizing a text-layer-first search render', async () => {
        vi.useFakeTimers();
        const { pageContainer } = createPageContainer({
            pageNumber: 2,
            offsetWidth: 600,
            offsetHeight: 900,
        });
        const containerRoot = createContainerRoot(pageContainer);
        const canvasPaint = Promise.withResolvers<undefined>();
        const documentState = {
            ...createDocumentState(),
            numPages: ref(2),
            leasePage: vi.fn(async () => createPageLease({ render: vi.fn(() => ({ promise: Promise.resolve() })) })),
        };

        canvasRendererMock.prepareCanvasRender.mockImplementationOnce(async () => ({
            ...createRenderResult(),
            startRender: () => ({
                cancel: vi.fn(),
                promise: canvasPaint.promise,
            }),
        }));

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            currentSearchMatch: ref(cast<IPdfSearchMatch>({
                pageIndex: 1,
                matchIndex: 0,
                startOffset: 0,
                endOffset: 4,
            })),
            currentSearchMatchNavigationId: ref(0),
        });

        const renderPromise = renderer.renderVisiblePages(
            {
                start: 2,
                end: 2,
            },
            {
                bufferOverride: 0,
                preserveRenderedPages: true,
                prioritizeTextLayer: true,
            },
        );
        await vi.waitFor(() => {
            expect(textLayerRendererMock.applyPageSearchHighlights).toHaveBeenCalled();
        });

        expect(pageContainer.classList.contains('page_container--rendered')).toBe(false);
        expect(renderer.isPageRendered(2)).toBe(false);

        canvasPaint.resolve(undefined);
        await vi.runOnlyPendingTimersAsync();
        await renderPromise;

        expect(pageContainer.classList.contains('page_container--rendered')).toBe(false);
        expect(renderer.isPageRendered(2)).toBe(true);
    });

    it('commits canvas visual readiness before secondary page layers finish', async () => {
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);
        const textLayerRender = Promise.withResolvers<undefined>();
        const documentState = {
            ...createDocumentState(),
            numPages: ref(1),
            leasePage: vi.fn(async () => createPageLease({ render: vi.fn(() => ({ promise: Promise.resolve() })) })),
        };
        textLayerRendererMock.renderTextLayer.mockReturnValue(textLayerRender.promise);

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
        });

        const renderPromise = renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });
        await vi.waitFor(() => {
            expect(canvasRendererMock.mountCanvas).toHaveBeenCalled();
        });

        expect(pageContainer.classList.contains('page_container--rendered')).toBe(false);
        expect(renderer.isPageRendered(1)).toBe(true);
        expect(annotationLayerRendererMock.renderAnnotationLayer).toHaveBeenCalledOnce();
        expect(textLayerRendererMock.setupTextLayerInteraction).not.toHaveBeenCalled();
        await renderPromise;
        expect(textLayerRendererMock.setupTextLayerInteraction).not.toHaveBeenCalled();

        textLayerRender.resolve(undefined);
        await vi.waitFor(() => {
            expect(textLayerRendererMock.setupTextLayerInteraction).toHaveBeenCalledOnce();
        });

        expect(pageContainer.classList.contains('page_container--rendered')).toBe(false);
        expect(renderer.isPageRendered(1)).toBe(true);
        expect(canvasRendererMock.renderCanvas).toHaveBeenCalledOnce();
    });

    it('prefetches buffer canvases without eagerly extracting optional text', async () => {
        const firstPage = createPageContainer({pageNumber: 1});
        const secondPage = createPageContainer({pageNumber: 2});
        const containerRoot = createContainerRoot([
            firstPage.pageContainer,
            secondPage.pageContainer,
        ]);

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: createDocumentState({
                numPages: ref(2),
                leasePage: vi.fn(async () => createPageLease({render: vi.fn(() => ({promise: Promise.resolve()}))})),
            }) as never,
            bufferPages: ref(1),
        });

        await renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });

        expect(canvasRendererMock.renderCanvas).toHaveBeenCalledTimes(2);
        expect(annotationLayerRendererMock.renderAnnotationLayer).toHaveBeenCalledTimes(2);
        expect(textLayerRendererMock.renderTextLayer).toHaveBeenCalledOnce();
        expect(renderer.isPageRendered(1)).toBe(true);
        expect(renderer.isPageRendered(2)).toBe(true);
    });

    it('clears the canonical visual and notifies when a page-local layer is invalidated', async () => {
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);
        const onRenderedPageStateChanged = vi.fn();
        const documentState = {
            ...createDocumentState(),
            numPages: ref(1),
            leasePage: vi.fn(async () => createPageLease({ render: vi.fn(() => ({ promise: Promise.resolve() })) })),
        };

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            onRenderedPageStateChanged,
        });

        await renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });
        onRenderedPageStateChanged.mockClear();

        renderer.invalidatePages([1]);

        expect(renderer.isPageRendered(1)).toBe(false);
        expect(renderer.isPageFreshlyRendered(1)).toBe(false);
        expect(onRenderedPageStateChanged).toHaveBeenCalledTimes(1);
    });

    it('re-renders visible pages in place when preserving existing pages', async () => {
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);
        const pageContainerClassList = pageContainer.classList;
        const ensurePageMetricsInRange = vi.fn(async () => true);

        const documentState = {
            ...createDocumentState(),
            numPages: ref(1),
            ensurePageMetricsInRange,
            leasePage: vi.fn(async () => createPageLease({render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() }))})),
        };

        canvasRendererMock.renderCanvas
            .mockResolvedValueOnce(createRenderResult())
            .mockResolvedValueOnce(createRenderResult());

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
        });

        await renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });
        expect(ensurePageMetricsInRange).toHaveBeenCalledWith(1, 1);
        expect(renderer.isPageRendered(1)).toBe(true);

        vi.clearAllMocks();

        await renderer.reRenderAllVisiblePages(
            () => ({
                start: 1,
                end: 1,
            }),
        );

        expect(canvasRendererMock.renderCanvas).toHaveBeenCalledTimes(1);
        expect(renderer.isPageRendered(1)).toBe(true);
        expect(pageContainerClassList.remove).not.toHaveBeenCalled();
    });

    it('does not let a stale visible render cleanup remove the latest rendered page', async () => {
        const { pageContainer: firstPageContainer } = createPageContainer({ pageNumber: 1 });
        const { pageContainer: secondPageContainer } = createPageContainer({ pageNumber: 2 });
        const containerRoot = createContainerRoot([
            firstPageContainer,
            secondPageContainer,
        ]);
        const staleMetricsHydration = Promise.withResolvers<boolean>();
        const ensurePageMetricsInRange = vi.fn()
            .mockResolvedValueOnce(false)
            .mockReturnValueOnce(staleMetricsHydration.promise)
            .mockResolvedValueOnce(false);

        const documentState = {
            ...createDocumentState(),
            numPages: ref(2),
            ensurePageMetricsInRange,
            leasePage: vi.fn(async () => createPageLease({ render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() })) })),
        };

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            currentPage: ref(2),
        });

        await renderer.renderVisiblePages({
            start: 2,
            end: 2,
        });
        expect(renderer.isPageRendered(2)).toBe(true);

        const staleRender = renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });
        await Promise.resolve();

        await renderer.renderVisiblePages({
            start: 2,
            end: 2,
        });

        staleMetricsHydration.resolve(false);
        await staleRender;

        expect(ensurePageMetricsInRange).toHaveBeenNthCalledWith(1, 2, 2);
        expect(ensurePageMetricsInRange).toHaveBeenNthCalledWith(2, 1, 1);
        expect(ensurePageMetricsInRange).toHaveBeenNthCalledWith(3, 2, 2);
        expect(documentState.leasePage).not.toHaveBeenCalledWith(1);
        expect(renderer.isPageRendered(2)).toBe(true);
        expect(secondPageContainer.classList.remove).not.toHaveBeenCalledWith('page_container--rendered');
    });

    it('does not replay optional text postconditions after a committed page is superseded', async () => {
        const { pageContainer: firstPageContainer } = createPageContainer({ pageNumber: 1 });
        const { pageContainer: secondPageContainer } = createPageContainer({ pageNumber: 2 });
        const containerRoot = createContainerRoot([
            firstPageContainer,
            secondPageContainer,
        ]);
        const firstTextLayerRender = Promise.withResolvers<undefined>();
        const onPageRendered = vi.fn();
        const documentState = {
            ...createDocumentState(),
            numPages: ref(2),
            leasePage: vi.fn(async () => createPageLease({ render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() })) })),
        };
        textLayerRendererMock.renderTextLayer
            .mockReturnValueOnce(firstTextLayerRender.promise)
            .mockResolvedValue(undefined);

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            onPageRendered,
        });

        const staleRender = renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });

        await vi.waitFor(() => {
            expect(textLayerRendererMock.renderTextLayer).toHaveBeenCalledTimes(1);
        });

        await renderer.renderVisiblePages({
            start: 2,
            end: 2,
        });

        firstTextLayerRender.resolve(undefined);
        await staleRender;

        expect(onPageRendered).toHaveBeenCalledWith(1);
        expect(textLayerRendererMock.setupTextLayerInteraction).toHaveBeenCalledOnce();
        expect(renderer.isPageRendered(1)).toBe(false);
        expect(renderer.isPageRendered(2)).toBe(true);
    });

    it('does not restart a committed canvas while its optional text layer is still settling', async () => {
        const {
            pageContainer,
            setMountedCanvas,
        } = createPageContainer({ pageNumber: 1 });
        const containerRoot = createContainerRoot(pageContainer);
        const staleTextLayerRender = Promise.withResolvers<undefined>();
        const documentState = {
            ...createDocumentState(),
            numPages: ref(1),
            leasePage: vi.fn(async () => createPageLease({ render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() })) })),
        };
        canvasRendererMock.mountCanvas.mockImplementation((_host, canvas) => {
            setMountedCanvas(canvas);
        });
        textLayerRendererMock.renderTextLayer
            .mockResolvedValueOnce(undefined)
            .mockReturnValueOnce(staleTextLayerRender.promise);

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
        });

        await renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });
        expect(renderer.isPageRendered(1)).toBe(true);

        setMountedCanvas(null);
        const staleRender = renderer.renderVisiblePages(
            {
                start: 1,
                end: 1,
            },
            { preserveRenderedPages: true },
        );
        await vi.waitFor(() => {
            expect(canvasRendererMock.mountCanvas).toHaveBeenCalledTimes(2);
        });

        const latestRender = renderer.renderVisiblePages(
            {
                start: 1,
                end: 1,
            },
            { preserveRenderedPages: true },
        );
        await vi.waitFor(() => expect(renderer.isPageRendered(1)).toBe(true));

        staleTextLayerRender.resolve(undefined);
        await Promise.all([
            staleRender,
            latestRender,
        ]);

        expect(renderer.isPageRendered(1)).toBe(true);
        expect(canvasRendererMock.renderCanvas).toHaveBeenCalledTimes(2);
        expect(textLayerRendererMock.renderTextLayer).toHaveBeenCalledTimes(2);
        expect(pageContainer.classList.remove).not.toHaveBeenCalledWith('page_container--rendered');
    });

    it('keeps page rendered when text layer rendering fails', async () => {
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);

        const documentState = {
            ...createDocumentState(),
            numPages: ref(1),
            leasePage: vi.fn(async () => createPageLease({render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() }))})),
        };
        textLayerRendererMock.renderTextLayer.mockRejectedValue(new Error('text layer failed'));

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
        });

        await renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });

        expect(renderer.isPageRendered(1)).toBe(true);
        expect(documentState.evictPage).not.toHaveBeenCalled();
        await vi.waitFor(() => {
            expect(loggerError).toHaveBeenCalledWith(
                'pdf-renderer',
                expect.stringContaining('Failed to render text layer for page 1'),
                expect.any(Error),
            );
        });
    });

    it('keeps mounted canvas readable when stalled text layer rendering times out', async () => {
        vi.useFakeTimers();
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);
        const onRenderStall = vi.fn();
        let textLayerSignal: AbortSignal | null = null;
        let didAbortTextLayer = false;

        const documentState = {
            ...createDocumentState(),
            numPages: ref(1),
            leasePage: vi.fn(async () => createPageLease({render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() }))})),
        };
        textLayerRendererMock.renderTextLayer.mockImplementation((...args: unknown[]) => {
            textLayerSignal = args.at(-1) as AbortSignal;
            textLayerSignal.addEventListener('abort', () => {
                didAbortTextLayer = true;
            });
            return new Promise(() => {});
        });

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            annotationUiManager: cast<Ref<AnnotationEditorUIManager | null>>(ref({ direction: 'ltr' })),
            onRenderStall,
        });

        const renderPromise = renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(textLayerSignal).not.toBeNull();
        expect(annotationLayerRendererMock.renderAnnotationLayer).toHaveBeenCalledOnce();
        expect(annotationLayerRendererMock.renderAnnotationEditorLayer).toHaveBeenCalledOnce();
        expect(renderer.isPageRendered(1)).toBe(true);
        await vi.advanceTimersByTimeAsync(PDF_PAGE_TEXT_LAYER_TIMEOUT_MS);
        await renderPromise;

        expect(didAbortTextLayer).toBe(true);
        expect(onRenderStall).not.toHaveBeenCalled();
        expect(loggerWarn).toHaveBeenCalledWith(
            'pdf-renderer',
            'Optional text layer enrichment timed out for page 1',
            {
                pageNumber: 1,
                stage: 'text-layer',
                timeoutMs: PDF_PAGE_TEXT_LAYER_TIMEOUT_MS,
            },
        );
        expect(renderer.isPageRendered(1)).toBe(true);
        expect(annotationLayerRendererMock.renderAnnotationLayer).toHaveBeenCalledOnce();
        expect(canvasRendererMock.renderCanvas).toHaveBeenCalledOnce();
        expect(textLayerRendererMock.renderTextLayer).toHaveBeenCalledOnce();
    });

    it('keeps page rendered when annotation layer rendering fails', async () => {
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);

        const documentState = {
            ...createDocumentState(),
            numPages: ref(1),
            leasePage: vi.fn(async () => createPageLease({render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() }))})),
        };
        annotationLayerRendererMock.renderAnnotationLayer.mockRejectedValue(new Error('annotation layer failed'));

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            annotationUiManager: cast<Ref<AnnotationEditorUIManager | null>>(ref({ direction: 'ltr' })),
        });

        await renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });

        expect(renderer.isPageRendered(1)).toBe(true);
        expect(documentState.evictPage).not.toHaveBeenCalled();
        expect(loggerError).toHaveBeenCalledWith(
            'pdf-renderer',
            expect.stringContaining('Failed to render annotation layer for page 1'),
            expect.any(Error),
        );
    });

    it('does not report a superseded annotation render as a failure', async () => {
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);
        const documentState = {
            ...createDocumentState(),
            numPages: ref(1),
            leasePage: vi.fn(async () => createPageLease({render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() }))})),
        };
        annotationLayerRendererMock.renderAnnotationLayer.mockRejectedValue(
            Object.assign(new Error('Page render stage was aborted'), {name: 'AbortError'}),
        );

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
        });

        await renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });

        expect(renderer.isPageRendered(1)).toBe(true);
        expect(loggerError).not.toHaveBeenCalled();
    });

    it('times out a stalled annotation layer and still reveals the rendered page', async () => {
        vi.useFakeTimers();
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);
        const annotationSignals: AbortSignal[] = [];
        const documentState = {
            ...createDocumentState(),
            numPages: ref(1),
            leasePage: vi.fn(async () => createPageLease({render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() }))})),
        };
        annotationLayerRendererMock.renderAnnotationLayer.mockImplementation((...args: unknown[]) => {
            annotationSignals.push((args[5] as { signal: AbortSignal }).signal);
            return new Promise(() => {});
        });

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
        });

        const renderPromise = renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(annotationSignals).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(PDF_PAGE_RENDER_TIMEOUT_MS);
        await renderPromise;

        expect(annotationSignals[0]?.aborted).toBe(true);
        expect(renderer.isPageRendered(1)).toBe(true);
        expect(loggerError).toHaveBeenCalledWith(
            'pdf-renderer',
            expect.stringContaining('Failed to render annotation layer for page 1'),
            expect.objectContaining({
                name: 'PdfPageRenderTimeoutError',
                stage: 'annotation-layer',
            }),
        );
    });

    it('times out a stalled annotation editor layer and still reveals the rendered page', async () => {
        vi.useFakeTimers();
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);
        const annotationEditorSignals: AbortSignal[] = [];
        const documentState = {
            ...createDocumentState(),
            numPages: ref(1),
            leasePage: vi.fn(async () => createPageLease({render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() }))})),
        };
        annotationLayerRendererMock.renderAnnotationEditorLayer.mockImplementation((...args: unknown[]) => {
            annotationEditorSignals.push((args[6] as { signal: AbortSignal }).signal);
            return new Promise(() => {});
        });

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            annotationUiManager: cast<Ref<AnnotationEditorUIManager | null>>(ref({ direction: 'ltr' })),
        });

        const renderPromise = renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(annotationEditorSignals).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(PDF_PAGE_RENDER_TIMEOUT_MS);
        await renderPromise;

        expect(annotationEditorSignals[0]?.aborted).toBe(true);
        expect(renderer.isPageRendered(1)).toBe(true);
        expect(loggerError).toHaveBeenCalledWith(
            'pdf-renderer',
            expect.stringContaining('Failed to render annotation editor layer for page 1'),
            expect.objectContaining({
                name: 'PdfPageRenderTimeoutError',
                stage: 'annotation-editor-layer',
            }),
        );
    });

    it('reports hidden annotation preflight stalls as canvas prepare timeouts', async () => {
        vi.useFakeTimers();
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);
        const onRenderStall = vi.fn();

        const documentState = {
            ...createDocumentState(),
            numPages: ref(1),
            leasePage: vi.fn(async () => createPageLease({render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() }))})),
        };

        canvasRendererMock.prepareCanvasRender.mockImplementationOnce(async () => {
            await delay(16_000);

            return {
                ...createRenderResult(),
                startRender: () => ({
                    cancel: vi.fn(),
                    promise: Promise.resolve(),
                }),
            };
        });

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            onRenderStall,
        });

        const renderPromise = renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });

        await vi.advanceTimersByTimeAsync(15_000);
        await renderPromise;

        expect(onRenderStall).toHaveBeenCalledWith({
            pageNumber: 1,
            stage: 'canvas-prepare',
            timeoutMs: 15_000,
        });
        expect(renderer.isPageRendered(1)).toBe(false);
    });

    it('does not render visible pages while inactive', async () => {
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);
        const ensurePageMetricsInRange = vi.fn(async () => true);
        const leasePage = vi.fn(async () => ({render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() }))}));

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: createDocumentState({
                numPages: ref(1),
                ensurePageMetricsInRange,
                leasePage,
            }) as never,
            isActive: ref(false),
        });

        await renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });

        expect(ensurePageMetricsInRange).not.toHaveBeenCalled();
        expect(leasePage).not.toHaveBeenCalled();
        expect(canvasRendererMock.prepareCanvasRender).not.toHaveBeenCalled();
    });

    it('does not rerender visible pages while inactive', async () => {
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);
        const leasePage = vi.fn(async () => ({render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() }))}));

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: createDocumentState({
                numPages: ref(1),
                leasePage,
            }) as never,
            isActive: ref(false),
        });

        await renderer.reRenderAllVisiblePages(() => ({
            start: 1,
            end: 1,
        }));

        expect(leasePage).not.toHaveBeenCalled();
        expect(canvasRendererMock.renderCanvas).not.toHaveBeenCalled();
        expect(pageContainer.classList.remove).not.toHaveBeenCalled();
    });
});
