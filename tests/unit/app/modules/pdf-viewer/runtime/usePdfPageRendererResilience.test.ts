import {
    afterEach,
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
import { cast } from '@tests/helpers/cast';

const loggerError = vi.fn();

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    error: loggerError,
    warn: vi.fn(),
    warnThrottled: vi.fn(),
    debug: vi.fn(),
}}));

interface IClassList {
    add: (...args: string[]) => void;
    contains: (className: string) => boolean;
    remove: (...args: string[]) => void;
}

interface INodeLike {
    style: Record<string, string>;
    classList: IClassList;
    dataset?: Record<string, string>;
    offsetTop?: number;
    offsetHeight?: number;
    innerHTML?: string;
    hidden?: boolean;
    dir?: string;
    appendChild?: (...args: unknown[]) => void;
    querySelector?: (selector: string) => unknown;
}

interface ICanvasLike extends INodeLike {
    width: number;
    height: number;
    remove: () => void;
}

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
    applyContainerDimensions: vi.fn(),
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
    renderAnnotationEditorLayer: vi.fn(() => true),
    cleanupEditorLayer: vi.fn(),
    clearAllLayers: vi.fn(),
};

vi.mock('@app/modules/pdf-viewer/runtime/composables/pdf/usePdfCanvasRenderer', () => ({usePdfCanvasRenderer: () => canvasRendererMock}));

vi.mock('@app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer', () => ({usePdfTextLayerRenderer: () => textLayerRendererMock}));

vi.mock('@app/modules/pdf-viewer/runtime/rendering/usePdfAnnotationLayerRenderer', () => ({usePdfAnnotationLayerRenderer: () => annotationLayerRendererMock}));

const { usePdfPageRenderer } = await import('@app/modules/pdf-viewer/runtime/rendering/usePdfPageRenderer');
const { PDF_PAGE_TEXT_LAYER_TIMEOUT_MS } = await import('@app/constants/timeouts');

function createClassList(): IClassList {
    const classNames = new Set<string>();

    return {
        add: vi.fn((...args: string[]) => {
            for (const className of args) {
                classNames.add(className);
            }
        }),
        contains: vi.fn((className: string) => classNames.has(className)),
        remove: vi.fn((...args: string[]) => {
            for (const className of args) {
                classNames.delete(className);
            }
        }),
    };
}

function createCanvas(): ICanvasLike {
    return {
        width: 0,
        height: 0,
        remove: vi.fn(),
        style: {},
        classList: createClassList(),
    };
}

function createDeferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });

    return {
        promise,
        reject,
        resolve,
    };
}

function createPageContainer(overrides?: {
    pageNumber?: number;
    textLayerDiv?: INodeLike | null;
    annotationLayerDiv?: INodeLike | null;
    annotationEditorLayerDiv?: INodeLike | null;
}) {
    const pageNumber = overrides?.pageNumber ?? 1;
    let mountedCanvas: unknown = null;
    const canvasHost: INodeLike = {
        innerHTML: '',
        style: {},
        classList: createClassList(),
        appendChild: vi.fn(),
    };
    const skeleton: INodeLike = {
        style: {display: ''},
        classList: createClassList(),
    };
    const textLayerDiv = overrides?.textLayerDiv ?? {
        innerHTML: '',
        style: {},
        classList: createClassList(),
    };
    const annotationLayerDiv = overrides?.annotationLayerDiv ?? {
        innerHTML: '',
        style: {},
        classList: createClassList(),
    };
    const annotationEditorLayerDiv = overrides?.annotationEditorLayerDiv ?? {
        innerHTML: '',
        hidden: false,
        dir: 'ltr',
        style: {},
        classList: createClassList(),
    };

    const selectorMap = new Map<string, unknown>([
        [
            '.page_canvas',
            canvasHost,
        ],
        [
            '.page_canvas canvas',
            mountedCanvas,
        ],
        [
            '.pdf-page-skeleton',
            skeleton,
        ],
        [
            '.text-layer',
            textLayerDiv,
        ],
        [
            '.annotation-layer',
            annotationLayerDiv,
        ],
        [
            '.annotation-editor-layer',
            annotationEditorLayerDiv,
        ],
    ]);

    const pageContainer: INodeLike = {
        dataset: { page: String(pageNumber) },
        offsetTop: 0,
        offsetHeight: 180,
        style: {},
        classList: createClassList(),
        querySelector: vi.fn((selector: string) => selectorMap.get(selector) ?? null),
    };

    return {
        pageContainer,
        canvasHost,
        textLayerDiv,
        setMountedCanvas: (canvas: unknown) => {
            mountedCanvas = canvas;
            selectorMap.set('.page_canvas canvas', mountedCanvas);
        },
    };
}

function createContainerRoot(pageContainerOrContainers: INodeLike | INodeLike[]) {
    const pageContainers = Array.isArray(pageContainerOrContainers)
        ? pageContainerOrContainers
        : [pageContainerOrContainers];

    return cast<HTMLElement>({
        querySelectorAll: vi.fn((selector: string) => (
            selector === '.page_container'
                ? pageContainers
                : []
        )),
        querySelector: vi.fn((selector: string) => {
            const pageMatch = selector.match(/^\.page_container\[data-page="(\d+)"\]$/);
            if (!pageMatch) {
                return null;
            }

            return pageContainers.find(
                pageContainer => pageContainer.dataset?.page === pageMatch[1],
            ) ?? null;
        }),
    });
}

function createRenderResult() {
    return {
        canvas: cast<HTMLCanvasElement>(createCanvas()),
        viewport: {
            width: 120,
            height: 180,
            rawDims: {
                pageWidth: 120,
                pageHeight: 180,
            },
        },
        scaleX: 1,
        scaleY: 1,
        rawDims: {
            pageWidth: 120,
            pageHeight: 180,
        },
        userUnit: 1,
        totalScaleFactor: 1,
    };
}

describe('usePdfPageRenderer resilience', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('releases page resources after a page finishes rendering', async () => {
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);
        const cleanup = vi.fn();
        const pdfPage = {
            cleanup,
            render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() })),
        };

        const documentState = {
            pdfDocument: shallowRef({} as object),
            numPages: ref(1),
            basePageWidth: ref(100),
            basePageHeight: ref(100),
            isLoading: ref(false),
            getPage: vi.fn(async () => pdfPage),
            evictPage: vi.fn(),
            cleanupPageCache: vi.fn(),
        };

        canvasRendererMock.renderCanvas.mockResolvedValue(createRenderResult());
        textLayerRendererMock.renderTextLayer.mockResolvedValue(undefined);
        annotationLayerRendererMock.renderAnnotationLayer.mockResolvedValue(null);

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            currentPage: ref(1),
            effectiveScale: ref(1),
            bufferPages: ref(0),
            showAnnotations: ref(true),
            annotationUiManager: ref(null),
            annotationL10n: ref(null),
            searchPageMatches: ref(new Map()),
            currentSearchMatch: ref(null),
            workingCopyPath: ref(null),
        });

        await renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });

        expect(renderer.isPageRendered(1)).toBe(true);
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(documentState.evictPage).not.toHaveBeenCalled();
    });

    it('re-renders a tracked page when the mounted canvas is missing', async () => {
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);
        const documentState = {
            pdfDocument: shallowRef({} as object),
            numPages: ref(1),
            basePageWidth: ref(100),
            basePageHeight: ref(100),
            isLoading: ref(false),
            getPage: vi.fn(async () => ({ render: vi.fn(() => ({ promise: Promise.resolve() })) })),
            evictPage: vi.fn(),
            cleanupPageCache: vi.fn(),
        };

        canvasRendererMock.renderCanvas.mockResolvedValue(createRenderResult());
        textLayerRendererMock.renderTextLayer.mockResolvedValue(undefined);
        annotationLayerRendererMock.renderAnnotationLayer.mockResolvedValue(null);

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            currentPage: ref(1),
            effectiveScale: ref(1),
            bufferPages: ref(0),
            showAnnotations: ref(true),
            annotationUiManager: ref(null),
            annotationL10n: ref(null),
            searchPageMatches: ref(new Map()),
            currentSearchMatch: ref(null),
            workingCopyPath: ref(null),
        });

        await renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });
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

    it('waits to mark the page rendered until page layers finish', async () => {
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);
        const textLayerRender = createDeferred();
        const documentState = {
            pdfDocument: shallowRef({} as object),
            numPages: ref(1),
            basePageWidth: ref(100),
            basePageHeight: ref(100),
            isLoading: ref(false),
            getPage: vi.fn(async () => ({ render: vi.fn(() => ({ promise: Promise.resolve() })) })),
            evictPage: vi.fn(),
            cleanupPageCache: vi.fn(),
        };

        canvasRendererMock.renderCanvas.mockResolvedValue(createRenderResult());
        textLayerRendererMock.renderTextLayer.mockReturnValue(textLayerRender.promise);
        annotationLayerRendererMock.renderAnnotationLayer.mockResolvedValue(null);

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            currentPage: ref(1),
            effectiveScale: ref(1),
            bufferPages: ref(0),
            showAnnotations: ref(true),
            annotationUiManager: ref(null),
            annotationL10n: ref(null),
            searchPageMatches: ref(new Map()),
            currentSearchMatch: ref(null),
            workingCopyPath: ref(null),
        });

        const renderPromise = renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });
        await vi.waitFor(() => {
            expect(canvasRendererMock.mountCanvas).toHaveBeenCalled();
        });

        expect(pageContainer.classList.contains('page_container--rendered')).toBe(false);
        expect(renderer.isPageRendered(1)).toBe(false);

        textLayerRender.resolve();
        await renderPromise;

        expect(pageContainer.classList.contains('page_container--rendered')).toBe(true);
        expect(renderer.isPageRendered(1)).toBe(true);
    });

    it('notifies when invalidation removes rendered page state', async () => {
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);
        const onRenderedPageStateChanged = vi.fn();
        const documentState = {
            pdfDocument: shallowRef({} as object),
            numPages: ref(1),
            basePageWidth: ref(100),
            basePageHeight: ref(100),
            isLoading: ref(false),
            getPage: vi.fn(async () => ({ render: vi.fn(() => ({ promise: Promise.resolve() })) })),
            evictPage: vi.fn(),
            cleanupPageCache: vi.fn(),
        };

        canvasRendererMock.renderCanvas.mockResolvedValue(createRenderResult());
        textLayerRendererMock.renderTextLayer.mockResolvedValue(undefined);
        annotationLayerRendererMock.renderAnnotationLayer.mockResolvedValue(null);

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            currentPage: ref(1),
            effectiveScale: ref(1),
            bufferPages: ref(0),
            showAnnotations: ref(true),
            annotationUiManager: ref(null),
            annotationL10n: ref(null),
            searchPageMatches: ref(new Map()),
            currentSearchMatch: ref(null),
            workingCopyPath: ref(null),
            onRenderedPageStateChanged,
        });

        await renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });
        onRenderedPageStateChanged.mockClear();

        renderer.invalidatePages([1]);

        expect(renderer.isPageRendered(1)).toBe(false);
        expect(onRenderedPageStateChanged).toHaveBeenCalledTimes(1);
    });

    it('re-renders visible pages in place when preserving existing pages', async () => {
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);
        const pageContainerClassList = pageContainer.classList;
        const ensurePageMetricsInRange = vi.fn(async () => true);

        const documentState = {
            pdfDocument: shallowRef({} as object),
            numPages: ref(1),
            basePageWidth: ref(100),
            basePageHeight: ref(100),
            isLoading: ref(false),
            ensurePageMetricsInRange,
            getPage: vi.fn(async () => ({render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() }))})),
            evictPage: vi.fn(),
            cleanupPageCache: vi.fn(),
        };

        canvasRendererMock.renderCanvas
            .mockResolvedValueOnce(createRenderResult())
            .mockResolvedValueOnce(createRenderResult());
        textLayerRendererMock.renderTextLayer.mockResolvedValue(undefined);
        annotationLayerRendererMock.renderAnnotationLayer.mockResolvedValue(null);

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            currentPage: ref(1),
            effectiveScale: ref(1),
            bufferPages: ref(0),
            showAnnotations: ref(true),
            annotationUiManager: ref(null),
            annotationL10n: ref(null),
            searchPageMatches: ref(new Map()),
            currentSearchMatch: ref(null),
            workingCopyPath: ref(null),
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
            { preserveExistingPages: true },
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
        const staleMetricsHydration = createDeferred<boolean>();
        const ensurePageMetricsInRange = vi.fn()
            .mockResolvedValueOnce(false)
            .mockReturnValueOnce(staleMetricsHydration.promise)
            .mockResolvedValueOnce(false);

        const documentState = {
            pdfDocument: shallowRef({} as object),
            numPages: ref(2),
            basePageWidth: ref(100),
            basePageHeight: ref(100),
            isLoading: ref(false),
            ensurePageMetricsInRange,
            getPage: vi.fn(async () => ({ render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() })) })),
            evictPage: vi.fn(),
            cleanupPageCache: vi.fn(),
        };

        canvasRendererMock.renderCanvas.mockResolvedValue(createRenderResult());
        textLayerRendererMock.renderTextLayer.mockResolvedValue(undefined);
        annotationLayerRendererMock.renderAnnotationLayer.mockResolvedValue(null);

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            currentPage: ref(2),
            effectiveScale: ref(1),
            bufferPages: ref(0),
            showAnnotations: ref(true),
            annotationUiManager: ref(null),
            annotationL10n: ref(null),
            searchPageMatches: ref(new Map()),
            currentSearchMatch: ref(null),
            workingCopyPath: ref(null),
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
        expect(documentState.getPage).not.toHaveBeenCalledWith(1);
        expect(renderer.isPageRendered(2)).toBe(true);
        expect(secondPageContainer.classList.remove).not.toHaveBeenCalledWith('page_container--rendered');
    });

    it('does not finalize a page render superseded after canvas paint', async () => {
        const { pageContainer: firstPageContainer } = createPageContainer({ pageNumber: 1 });
        const { pageContainer: secondPageContainer } = createPageContainer({ pageNumber: 2 });
        const containerRoot = createContainerRoot([
            firstPageContainer,
            secondPageContainer,
        ]);
        const firstTextLayerRender = createDeferred();
        const onPageRendered = vi.fn();
        const documentState = {
            pdfDocument: shallowRef({} as object),
            numPages: ref(2),
            basePageWidth: ref(100),
            basePageHeight: ref(100),
            isLoading: ref(false),
            getPage: vi.fn(async () => ({ render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() })) })),
            evictPage: vi.fn(),
            cleanupPageCache: vi.fn(),
        };

        canvasRendererMock.renderCanvas.mockResolvedValue(createRenderResult());
        textLayerRendererMock.renderTextLayer
            .mockReturnValueOnce(firstTextLayerRender.promise)
            .mockResolvedValue(undefined);
        annotationLayerRendererMock.renderAnnotationLayer.mockResolvedValue(null);

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            currentPage: ref(1),
            effectiveScale: ref(1),
            bufferPages: ref(0),
            showAnnotations: ref(true),
            annotationUiManager: ref(null),
            annotationL10n: ref(null),
            searchPageMatches: ref(new Map()),
            currentSearchMatch: ref(null),
            workingCopyPath: ref(null),
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

        firstTextLayerRender.resolve();
        await staleRender;

        expect(onPageRendered).not.toHaveBeenCalledWith(1);
        expect(renderer.isPageRendered(1)).toBe(false);
        expect(renderer.isPageRendered(2)).toBe(true);
    });

    it('transfers ownership when a preserved page is still rendering with a mounted canvas', async () => {
        const {
            pageContainer,
            setMountedCanvas,
        } = createPageContainer({ pageNumber: 1 });
        const containerRoot = createContainerRoot(pageContainer);
        const staleTextLayerRender = createDeferred();
        const documentState = {
            pdfDocument: shallowRef({} as object),
            numPages: ref(1),
            basePageWidth: ref(100),
            basePageHeight: ref(100),
            isLoading: ref(false),
            getPage: vi.fn(async () => ({ render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() })) })),
            evictPage: vi.fn(),
            cleanupPageCache: vi.fn(),
        };

        canvasRendererMock.renderCanvas.mockResolvedValue(createRenderResult());
        canvasRendererMock.mountCanvas.mockImplementation((_host, canvas) => {
            setMountedCanvas(canvas);
        });
        textLayerRendererMock.renderTextLayer
            .mockResolvedValueOnce(undefined)
            .mockReturnValueOnce(staleTextLayerRender.promise)
            .mockResolvedValueOnce(undefined);
        annotationLayerRendererMock.renderAnnotationLayer.mockResolvedValue(null);

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            currentPage: ref(1),
            effectiveScale: ref(1),
            bufferPages: ref(0),
            showAnnotations: ref(true),
            annotationUiManager: ref(null),
            annotationL10n: ref(null),
            searchPageMatches: ref(new Map()),
            currentSearchMatch: ref(null),
            workingCopyPath: ref(null),
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
        await vi.waitFor(() => {
            expect(canvasRendererMock.renderCanvas).toHaveBeenCalledTimes(3);
        });

        staleTextLayerRender.resolve();
        await Promise.all([
            staleRender,
            latestRender,
        ]);

        expect(renderer.isPageRendered(1)).toBe(true);
        expect(pageContainer.classList.remove).not.toHaveBeenCalledWith('page_container--rendered');
    });

    it('keeps page rendered when text layer rendering fails', async () => {
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);

        const documentState = {
            pdfDocument: shallowRef({} as object),
            numPages: ref(1),
            basePageWidth: ref(100),
            basePageHeight: ref(100),
            isLoading: ref(false),
            getPage: vi.fn(async () => ({render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() }))})),
            evictPage: vi.fn(),
            cleanupPageCache: vi.fn(),
        };

        canvasRendererMock.renderCanvas.mockResolvedValue(createRenderResult());
        textLayerRendererMock.renderTextLayer.mockRejectedValue(new Error('text layer failed'));

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            currentPage: ref(1),
            effectiveScale: ref(1),
            bufferPages: ref(0),
            showAnnotations: ref(true),
            annotationUiManager: ref(null),
            annotationL10n: ref(null),
            searchPageMatches: ref(new Map()),
            currentSearchMatch: ref(null),
            workingCopyPath: ref(null),
        });

        await renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });

        expect(renderer.isPageRendered(1)).toBe(true);
        expect(documentState.evictPage).not.toHaveBeenCalled();
        expect(loggerError).toHaveBeenCalledWith(
            'pdf-renderer',
            expect.stringContaining('Failed to render text layer for page 1'),
            expect.any(Error),
        );
    });

    it('times out and aborts stalled text layer rendering', async () => {
        vi.useFakeTimers();
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);
        const onRenderStall = vi.fn();
        let textLayerSignal: AbortSignal | null = null;
        let didAbortTextLayer = false;

        const documentState = {
            pdfDocument: shallowRef({} as object),
            numPages: ref(1),
            basePageWidth: ref(100),
            basePageHeight: ref(100),
            isLoading: ref(false),
            getPage: vi.fn(async () => ({render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() }))})),
            evictPage: vi.fn(),
            cleanupPageCache: vi.fn(),
        };

        canvasRendererMock.renderCanvas.mockResolvedValue(createRenderResult());
        textLayerRendererMock.renderTextLayer.mockImplementation((...args: unknown[]) => {
            textLayerSignal = args.at(-1) as AbortSignal;
            textLayerSignal.addEventListener('abort', () => {
                didAbortTextLayer = true;
            });
            return new Promise(() => {});
        });
        annotationLayerRendererMock.renderAnnotationLayer.mockResolvedValue(null);

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            currentPage: ref(1),
            effectiveScale: ref(1),
            bufferPages: ref(0),
            showAnnotations: ref(true),
            annotationUiManager: ref(null),
            annotationL10n: ref(null),
            searchPageMatches: ref(new Map()),
            currentSearchMatch: ref(null),
            workingCopyPath: ref(null),
            onRenderStall,
        });

        const renderPromise = renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(textLayerSignal).not.toBeNull();
        await vi.advanceTimersByTimeAsync(PDF_PAGE_TEXT_LAYER_TIMEOUT_MS);
        await renderPromise;

        expect(didAbortTextLayer).toBe(true);
        expect(onRenderStall).toHaveBeenCalledWith({
            pageNumber: 1,
            stage: 'text-layer',
            timeoutMs: PDF_PAGE_TEXT_LAYER_TIMEOUT_MS,
        });
        expect(renderer.isPageRendered(1)).toBe(false);
        expect(annotationLayerRendererMock.renderAnnotationLayer).not.toHaveBeenCalled();
    });

    it('keeps page rendered when annotation layer rendering fails', async () => {
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);

        const documentState = {
            pdfDocument: shallowRef({} as object),
            numPages: ref(1),
            basePageWidth: ref(100),
            basePageHeight: ref(100),
            isLoading: ref(false),
            getPage: vi.fn(async () => ({render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() }))})),
            evictPage: vi.fn(),
            cleanupPageCache: vi.fn(),
        };

        canvasRendererMock.renderCanvas.mockResolvedValue(createRenderResult());
        textLayerRendererMock.renderTextLayer.mockResolvedValue(undefined);
        annotationLayerRendererMock.renderAnnotationLayer.mockRejectedValue(new Error('annotation layer failed'));

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            currentPage: ref(1),
            effectiveScale: ref(1),
            bufferPages: ref(0),
            showAnnotations: ref(true),
            annotationUiManager: cast<Ref<AnnotationEditorUIManager | null>>(ref({ direction: 'ltr' })),
            annotationL10n: ref(null),
            searchPageMatches: ref(new Map()),
            currentSearchMatch: ref(null),
            workingCopyPath: ref(null),
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

    it('does not treat hidden annotation preflight work as a stalled canvas render', async () => {
        vi.useFakeTimers();
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);
        const onRenderStall = vi.fn();

        const documentState = {
            pdfDocument: shallowRef({} as object),
            numPages: ref(1),
            basePageWidth: ref(100),
            basePageHeight: ref(100),
            isLoading: ref(false),
            getPage: vi.fn(async () => ({render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() }))})),
            evictPage: vi.fn(),
            cleanupPageCache: vi.fn(),
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
        textLayerRendererMock.renderTextLayer.mockResolvedValue(undefined);
        annotationLayerRendererMock.renderAnnotationLayer.mockResolvedValue(null);

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            currentPage: ref(1),
            effectiveScale: ref(1),
            bufferPages: ref(0),
            showAnnotations: ref(true),
            annotationUiManager: ref(null),
            annotationL10n: ref(null),
            searchPageMatches: ref(new Map()),
            currentSearchMatch: ref(null),
            workingCopyPath: ref(null),
            onRenderStall,
        });

        const renderPromise = renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });

        await vi.advanceTimersByTimeAsync(16_000);
        await renderPromise;

        expect(onRenderStall).not.toHaveBeenCalled();
        expect(renderer.isPageRendered(1)).toBe(true);
    });

    it('does not render visible pages while inactive', async () => {
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);
        const ensurePageMetricsInRange = vi.fn(async () => true);
        const getPage = vi.fn(async () => ({render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() }))}));

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: {
                pdfDocument: shallowRef({} as object),
                numPages: ref(1),
                basePageWidth: ref(100),
                basePageHeight: ref(100),
                isLoading: ref(false),
                ensurePageMetricsInRange,
                getPage,
                evictPage: vi.fn(),
                cleanupPageCache: vi.fn(),
            } as never,
            currentPage: ref(1),
            isActive: ref(false),
            effectiveScale: ref(1),
            bufferPages: ref(0),
            searchPageMatches: ref(new Map()),
            currentSearchMatch: ref(null),
            workingCopyPath: ref(null),
        });

        await renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });

        expect(ensurePageMetricsInRange).not.toHaveBeenCalled();
        expect(getPage).not.toHaveBeenCalled();
        expect(canvasRendererMock.prepareCanvasRender).not.toHaveBeenCalled();
    });

    it('does not rerender visible pages while inactive', async () => {
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);
        const getPage = vi.fn(async () => ({render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() }))}));

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: {
                pdfDocument: shallowRef({} as object),
                numPages: ref(1),
                basePageWidth: ref(100),
                basePageHeight: ref(100),
                isLoading: ref(false),
                getPage,
                evictPage: vi.fn(),
                cleanupPageCache: vi.fn(),
            } as never,
            currentPage: ref(1),
            isActive: ref(false),
            effectiveScale: ref(1),
            bufferPages: ref(0),
            searchPageMatches: ref(new Map()),
            currentSearchMatch: ref(null),
            workingCopyPath: ref(null),
        });

        await renderer.reRenderAllVisiblePages(() => ({
            start: 1,
            end: 1,
        }));

        expect(getPage).not.toHaveBeenCalled();
        expect(canvasRendererMock.renderCanvas).not.toHaveBeenCalled();
        expect(pageContainer.classList.remove).not.toHaveBeenCalled();
    });
});
