// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { PDFPageProxy } from 'pdfjs-dist';
import { usePdfRendererSinglePageController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererSinglePageController';
import { PDF_PAGE_RENDER_TIMEOUT_MS } from '@app/constants/timeouts';
import { createPdfPageRenderState } from '@app/modules/pdf-viewer/runtime/rendering/pdfPageRenderState';
import { cast } from '@tests/helpers/cast';

function createPageRoot() {
    document.body.replaceChildren();
    const root = document.createElement('div');
    const page = document.createElement('div');
    page.classList.add('page_container');
    page.dataset.page = '1';
    const pageClassAdd = vi.spyOn(page.classList, 'add');

    const canvasHost = document.createElement('div');
    canvasHost.classList.add('page_canvas');
    const renderLayer = document.createElement('div');
    renderLayer.classList.add('page_canvas__render-layer');
    canvasHost.append(renderLayer);
    const textLayer = document.createElement('div');
    textLayer.classList.add('text-layer');
    const annotationLayer = document.createElement('div');
    annotationLayer.classList.add('annotation-layer');
    const annotationEditorLayer = document.createElement('div');
    annotationEditorLayer.classList.add('annotation-editor-layer');

    page.append(
        canvasHost,
        textLayer,
        annotationLayer,
        annotationEditorLayer,
    );
    root.append(page);
    document.body.append(root);

    return {
        root,
        page,
        canvasHost,
        renderLayer,
        pageClassAdd,
    };
}

function createPageLease(page: PDFPageProxy) {
    return {
        page,
        release: vi.fn(),
    };
}

describe('usePdfRendererSinglePageController', () => {
    it('commits canvas-only buffer work without constructing page layers', async () => {
        const {
            root,
            page,
            renderLayer,
        } = createPageRoot();
        const viewport = {
            width: 200,
            height: 100,
            userUnit: 1,
            rawDims: {
                pageWidth: 200,
                pageHeight: 100,
            },
        };
        const pdfPage = cast<PDFPageProxy>({
            cleanup: vi.fn(),
            getViewport: vi.fn(() => viewport),
        });
        const pageLease = createPageLease(pdfPage);
        const pageRenderState = createPdfPageRenderState();
        const renderTextLayerForPage = vi.fn(async () => true);
        const renderAnnotationLayersForPage = vi.fn(async () => ({
            shouldContinue: true,
            annotationLayerInstance: null,
        }));
        const canvas = document.createElement('canvas');
        canvas.width = 200;
        canvas.height = 100;
        const renderResult = {
            canvas,
            viewport: cast<ReturnType<PDFPageProxy['getViewport']>>(viewport),
            annotationCanvasMap: null,
            scaleX: 1,
            scaleY: 1,
            rawDims: viewport.rawDims,
            requestedPixels: 20_000,
            grantedPixels: 20_000,
            pixelScaleFactor: 1,
            wasClamped: false,
            userUnit: 1,
            totalScaleFactor: 1,
        };
        const clearPageVisual = vi.fn(() => false);
        const prepareCanvasForRender = vi.fn(async () => renderResult);
        const mountRenderedCanvas = vi.fn((_pageNumber, _container, _host, result) => {
            renderLayer.append(result.canvas);
        });
        const controller = usePdfRendererSinglePageController({
            isActive: true,
            effectiveScale: 1,
            outputScale: 1,
            annotationUiManager: null,
            getContainerRoot: () => root,
            pageRenderState,
            renderingPages: pageRenderState.renderingPages,
            renderingPageRequestIds: pageRenderState.renderingPageRequestIds,
            activeRenderTasks: new Map(),
            getRenderVersion: () => 1,
            getRenderDocumentToken: () => 'doc-1',
            getDocumentRevision: () => 'rev-1',
            getVisibleRenderRequestId: () => 1,
            summarizePageDom: () => ({}),
            clearSelectionBeforePageLayerTeardown: vi.fn(),
            clearPageVisual,
            trackOptionalTextLayerTask: vi.fn(async (_pageNumber, _version, _requestId, task) => {
                await task;
            }),
            cleanupPageIfCurrentRender: vi.fn(),
            cleanupCanvasRenderResult: vi.fn(),
            loadPageForRender: vi.fn(async () => pageLease),
            prepareCanvasRenderForPage: vi.fn(async () => ({
                ...renderResult,
                startRender: vi.fn(),
            })),
            renderPreparedCanvasForPage: vi.fn(async prepared => prepared),
            prepareCanvasForRender,
            applyContainerUserUnit: vi.fn(),
            mountRenderedCanvas,
            scheduleRenderForSinglePage: vi.fn(),
            scheduleMissingRenderTargetRetry: vi.fn(),
            clearMissingRenderTargetRetry: vi.fn(),
            waitForRenderLifecycleDelay: vi.fn(async () => true),
            renderTextLayerForPage,
            renderAnnotationLayersForPage,
            renderAnnotationEditorLayer: vi.fn(async () => ({
                ok: true,
                rendered: true,
            } as const)),
            getViewportForAnnotationEditorLayer: vi.fn(() => viewport as never),
            scheduleOcrDebugForPage: vi.fn(),
            markPageCanvasSurfaceEvictable: vi.fn(),
            logNonCriticalStageError: vi.fn(),
        });

        await controller.renderSingleVisiblePage(
            root,
            1,
            1,
            1,
            false,
            1,
            () => true,
            new Set(),
            {
                start: 2,
                end: 2,
            },
            {contentIntent: 'canvas-only-buffer'},
        );

        expect(renderAnnotationLayersForPage).not.toHaveBeenCalled();
        expect(renderTextLayerForPage).not.toHaveBeenCalled();
        expect(page.dataset.pageLayerReadiness).toBe('canvas-only');
        expect(pageRenderState.getSlot(1)).toEqual(expect.objectContaining({
            canvasReadiness: 'ready',
            layerReadiness: 'canvas-only',
            container: page,
        }));
        expect(renderLayer.firstElementChild).toBe(canvas);

        await controller.renderSingleVisiblePage(
            root,
            1,
            1,
            1,
            false,
            2,
            () => true,
            new Set([1]),
            {
                start: 1,
                end: 1,
            },
            {contentIntent: 'layers-only-promotion'},
        );

        expect(prepareCanvasForRender).toHaveBeenCalledOnce();
        expect(mountRenderedCanvas).toHaveBeenCalledOnce();
        expect(clearPageVisual).toHaveBeenCalledOnce();
        expect(renderAnnotationLayersForPage).toHaveBeenCalledOnce();
        expect(renderTextLayerForPage).toHaveBeenCalledOnce();
        expect(page.dataset.pageLayerReadiness).toBe('ready');
        expect(pageRenderState.getSlot(1).layerReadiness).toBe('ready');
    });

    it('cleans a mounted canvas when a later async text-layer stage goes stale', async () => {
        const {
            root,
            renderLayer,
            pageClassAdd,
        } = createPageRoot();
        let renderVersion = 1;
        const pdfPage = { cleanup: vi.fn() } as PDFPageProxy & {cleanup: ReturnType<typeof vi.fn>};
        const cleanupPageIfCurrentRender = vi.fn(() => {
            renderLayer.replaceChildren();
        });
        const pageLease = createPageLease(pdfPage);
        const renderingPages = new Map<number, number>();
        const renderingPageRequestIds = new Map<number, number>();

        const controller = usePdfRendererSinglePageController({
            isActive: true,
            effectiveScale: 1,
            outputScale: 1,
            annotationUiManager: null,
            getContainerRoot: () => root,
            renderingPages,
            renderingPageRequestIds,
            activeRenderTasks: new Map(),
            getRenderVersion: () => renderVersion,
            getRenderDocumentToken: () => 'doc-1',
            getDocumentRevision: () => 'rev-1',
            getVisibleRenderRequestId: () => 1,
            summarizePageDom: () => ({}),
            clearSelectionBeforePageLayerTeardown: vi.fn(),
            clearPageVisual: vi.fn(() => false),
            trackOptionalTextLayerTask: vi.fn(async (_pageNumber, _version, _requestId, task) => {
                await task;
            }),
            cleanupPageIfCurrentRender,
            cleanupCanvasRenderResult: vi.fn(),
            loadPageForRender: vi.fn(async () => pageLease),
            prepareCanvasRenderForPage: vi.fn(async () => ({
                canvas: document.createElement('canvas'),
                startRender: vi.fn(),
            })),
            renderPreparedCanvasForPage: vi.fn(async prepared => ({ canvas: prepared.canvas })),
            prepareCanvasForRender: vi.fn(async () => ({ canvas: document.createElement('canvas') })),
            applyContainerUserUnit: vi.fn(),
            mountRenderedCanvas: vi.fn((_pageNumber, _container, _host, renderResult) => {
                renderLayer.append(renderResult.canvas);
            }),
            scheduleRenderForSinglePage: vi.fn(),
            scheduleMissingRenderTargetRetry: vi.fn(),
            clearMissingRenderTargetRetry: vi.fn(),
            waitForRenderLifecycleDelay: vi.fn(async () => true),
            renderTextLayerForPage: vi.fn(async () => {
                renderVersion = 2;
                return false;
            }),
            renderAnnotationLayersForPage: vi.fn(async () => ({
                shouldContinue: true,
                annotationLayerInstance: null,
            })),
            renderAnnotationEditorLayer: vi.fn(async () => ({
                ok: true,
                rendered: true,
            } as const)),
            getViewportForAnnotationEditorLayer: vi.fn(() => ({}) as never),
            scheduleOcrDebugForPage: vi.fn(),
            markPageCanvasSurfaceEvictable: vi.fn(),
            logNonCriticalStageError: vi.fn(),
        });

        await controller.renderSingleVisiblePage(
            root,
            1,
            1,
            1,
            false,
            1,
            () => true,
            new Set([1]),
            {
                start: 1,
                end: 1,
            },
        );

        expect(renderLayer.children).toHaveLength(0);
        expect(pageClassAdd).not.toHaveBeenCalledWith('page_container--rendered');
        expect(cleanupPageIfCurrentRender).not.toHaveBeenCalled();
        expect(pageLease.release).toHaveBeenCalled();
        expect(renderingPages.has(1)).toBe(false);
    });

    it('releases the loaded page when canvas preparation throws', async () => {
        const { root } = createPageRoot();
        const pdfPage = { cleanup: vi.fn() } as PDFPageProxy & {cleanup: ReturnType<typeof vi.fn>};
        const pageLease = createPageLease(pdfPage);
        const cleanupPageIfCurrentRender = vi.fn();
        const pageRenderState = createPdfPageRenderState();
        const controller = usePdfRendererSinglePageController({
            isActive: true,
            effectiveScale: 1,
            outputScale: 1,
            annotationUiManager: null,
            getContainerRoot: () => root,
            pageRenderState,
            renderingPages: pageRenderState.renderingPages,
            renderingPageRequestIds: pageRenderState.renderingPageRequestIds,
            activeRenderTasks: new Map(),
            getRenderVersion: () => 1,
            getRenderDocumentToken: () => 'doc-1',
            getDocumentRevision: () => 'rev-1',
            getVisibleRenderRequestId: () => 1,
            summarizePageDom: () => ({}),
            clearSelectionBeforePageLayerTeardown: vi.fn(),
            clearPageVisual: vi.fn(() => false),
            trackOptionalTextLayerTask: vi.fn(async (_pageNumber, _version, _requestId, task) => {
                await task;
            }),
            cleanupPageIfCurrentRender,
            cleanupCanvasRenderResult: vi.fn(),
            loadPageForRender: vi.fn(async () => pageLease),
            prepareCanvasRenderForPage: vi.fn(async () => ({
                canvas: document.createElement('canvas'),
                startRender: vi.fn(),
            })),
            renderPreparedCanvasForPage: vi.fn(async prepared => ({ canvas: prepared.canvas })),
            prepareCanvasForRender: vi.fn(async () => {
                throw new Error('canvas prepare failed');
            }),
            applyContainerUserUnit: vi.fn(),
            mountRenderedCanvas: vi.fn(),
            scheduleRenderForSinglePage: vi.fn(),
            scheduleMissingRenderTargetRetry: vi.fn(),
            clearMissingRenderTargetRetry: vi.fn(),
            waitForRenderLifecycleDelay: vi.fn(async () => true),
            renderTextLayerForPage: vi.fn(async () => true),
            renderAnnotationLayersForPage: vi.fn(async () => ({
                shouldContinue: true,
                annotationLayerInstance: null,
            })),
            renderAnnotationEditorLayer: vi.fn(async () => ({
                ok: true,
                rendered: true,
            } as const)),
            getViewportForAnnotationEditorLayer: vi.fn(() => ({}) as never),
            scheduleOcrDebugForPage: vi.fn(),
            markPageCanvasSurfaceEvictable: vi.fn(),
            logNonCriticalStageError: vi.fn(),
        });

        await controller.renderSingleVisiblePage(
            root,
            1,
            1,
            1,
            false,
            1,
            () => true,
            new Set([1]),
            {
                start: 1,
                end: 1,
            },
        );

        expect(cleanupPageIfCurrentRender).toHaveBeenCalledWith(1, 1, 1, {terminalFailure: true});
        expect(pageLease.release).toHaveBeenCalled();
        expect(pageRenderState.getSlot(1)).toEqual(expect.objectContaining({
            visual: 'none',
            job: 'failed',
            version: 1,
            requestId: 1,
        }));
    });

    it('reschedules a required page when its slot remount invalidates canvas preparation', async () => {
        const { root } = createPageRoot();
        const pdfPage = { cleanup: vi.fn() } as PDFPageProxy & {cleanup: ReturnType<typeof vi.fn>};
        const pageLease = createPageLease(pdfPage);
        const scheduleMissingRenderTargetRetry = vi.fn();
        const pageRenderState = createPdfPageRenderState();
        const controller = usePdfRendererSinglePageController({
            isActive: true,
            effectiveScale: 1,
            outputScale: 1,
            annotationUiManager: null,
            getContainerRoot: () => root,
            pageRenderState,
            renderingPages: pageRenderState.renderingPages,
            renderingPageRequestIds: pageRenderState.renderingPageRequestIds,
            activeRenderTasks: new Map(),
            getRenderVersion: () => 1,
            getRenderDocumentToken: () => 'doc-1',
            getDocumentRevision: () => 'rev-1',
            getVisibleRenderRequestId: () => 7,
            summarizePageDom: () => ({}),
            clearSelectionBeforePageLayerTeardown: vi.fn(),
            clearPageVisual: vi.fn(() => false),
            trackOptionalTextLayerTask: vi.fn(async (_pageNumber, _version, _requestId, task) => {
                await task;
            }),
            cleanupPageIfCurrentRender: vi.fn(),
            cleanupCanvasRenderResult: vi.fn(),
            loadPageForRender: vi.fn(async () => pageLease),
            prepareCanvasRenderForPage: vi.fn(async () => ({
                canvas: document.createElement('canvas'),
                startRender: vi.fn(),
            })),
            renderPreparedCanvasForPage: vi.fn(async prepared => ({ canvas: prepared.canvas })),
            prepareCanvasForRender: vi.fn(async () => null),
            applyContainerUserUnit: vi.fn(),
            mountRenderedCanvas: vi.fn(),
            scheduleRenderForSinglePage: vi.fn(),
            scheduleMissingRenderTargetRetry,
            clearMissingRenderTargetRetry: vi.fn(),
            waitForRenderLifecycleDelay: vi.fn(async () => true),
            renderTextLayerForPage: vi.fn(async () => true),
            renderAnnotationLayersForPage: vi.fn(async () => ({
                shouldContinue: true,
                annotationLayerInstance: null,
            })),
            renderAnnotationEditorLayer: vi.fn(async () => ({
                ok: true,
                rendered: true,
            } as const)),
            getViewportForAnnotationEditorLayer: vi.fn(() => ({}) as never),
            scheduleOcrDebugForPage: vi.fn(),
            markPageCanvasSurfaceEvictable: vi.fn(),
            logNonCriticalStageError: vi.fn(),
        });
        const visibleRange = {
            start: 1,
            end: 1,
        };

        await controller.renderSingleVisiblePage(
            root,
            1,
            1,
            1,
            false,
            7,
            () => true,
            new Set([1]),
            visibleRange,
        );

        expect(scheduleMissingRenderTargetRetry).toHaveBeenCalledWith(
            1,
            1,
            7,
            true,
            visibleRange,
            'doc-1',
            undefined,
        );
        expect(pageLease.release).toHaveBeenCalled();
    });

    it('retries a cancelled required render with the same canonical render request', async () => {
        const { root } = createPageRoot();
        const pdfPage = { cleanup: vi.fn() } as PDFPageProxy & {cleanup: ReturnType<typeof vi.fn>};
        const pageLease = createPageLease(pdfPage);
        const scheduleRenderForSinglePage = vi.fn();
        const cancelledError = Object.assign(new Error('rendering cancelled'), {name: 'RenderingCancelledException'});
        const pageRenderState = createPdfPageRenderState();
        const controller = usePdfRendererSinglePageController({
            isActive: true,
            effectiveScale: 1,
            outputScale: 1,
            annotationUiManager: null,
            getContainerRoot: () => root,
            pageRenderState,
            renderingPages: pageRenderState.renderingPages,
            renderingPageRequestIds: pageRenderState.renderingPageRequestIds,
            activeRenderTasks: new Map(),
            getRenderVersion: () => 1,
            getRenderDocumentToken: () => 'doc-1',
            getDocumentRevision: () => 'rev-1',
            getVisibleRenderRequestId: () => 1,
            summarizePageDom: () => ({}),
            clearSelectionBeforePageLayerTeardown: vi.fn(),
            clearPageVisual: vi.fn(() => false),
            trackOptionalTextLayerTask: vi.fn(async (_pageNumber, _version, _requestId, task) => {
                await task;
            }),
            cleanupPageIfCurrentRender: vi.fn(),
            cleanupCanvasRenderResult: vi.fn(),
            loadPageForRender: vi.fn(async () => pageLease),
            prepareCanvasRenderForPage: vi.fn(async () => ({
                canvas: document.createElement('canvas'),
                startRender: vi.fn(),
            })),
            renderPreparedCanvasForPage: vi.fn(async prepared => ({ canvas: prepared.canvas })),
            prepareCanvasForRender: vi.fn(async () => {
                throw cancelledError;
            }),
            applyContainerUserUnit: vi.fn(),
            mountRenderedCanvas: vi.fn(),
            scheduleRenderForSinglePage,
            scheduleMissingRenderTargetRetry: vi.fn(),
            clearMissingRenderTargetRetry: vi.fn(),
            waitForRenderLifecycleDelay: vi.fn(async () => true),
            renderTextLayerForPage: vi.fn(async () => true),
            renderAnnotationLayersForPage: vi.fn(async () => ({
                shouldContinue: true,
                annotationLayerInstance: null,
            })),
            renderAnnotationEditorLayer: vi.fn(async () => ({
                ok: true,
                rendered: true,
            } as const)),
            getViewportForAnnotationEditorLayer: vi.fn(() => ({}) as never),
            scheduleOcrDebugForPage: vi.fn(),
            markPageCanvasSurfaceEvictable: vi.fn(),
            logNonCriticalStageError: vi.fn(),
        });

        await controller.renderSingleVisiblePage(
            root,
            1,
            1,
            1,
            false,
            1,
            () => true,
            new Set([1]),
            {
                start: 1,
                end: 1,
            },
            {transactionRequest: {transactionId: 99} as never},
        );
        await vi.waitFor(() => {
            expect(scheduleRenderForSinglePage).toHaveBeenCalledWith(1, {
                bufferOverride: 0,
                preserveRenderedPages: true,
            });
        });
    });

    it('uses the invocation scale for standalone annotation-editor layer renders', async () => {
        const { root } = createPageRoot();
        const renderVersion = 1;
        const effectiveScale = ref(1);
        const pdfPage = { cleanup: vi.fn() } as PDFPageProxy & {cleanup: ReturnType<typeof vi.fn>};
        const pageLease = createPageLease(pdfPage);
        const getViewportForAnnotationEditorLayer = vi.fn(() => ({}) as never);
        const renderAnnotationEditorLayer = vi.fn(async () => ({
            ok: true,
            rendered: true,
        } as const));

        const controller = usePdfRendererSinglePageController({
            isActive: true,
            effectiveScale,
            outputScale: 1,
            annotationUiManager: {},
            getContainerRoot: () => root,
            renderingPages: new Map(),
            renderingPageRequestIds: new Map(),
            activeRenderTasks: new Map(),
            getRenderVersion: () => renderVersion,
            getRenderDocumentToken: () => 'doc-1',
            getDocumentRevision: () => 'rev-1',
            getVisibleRenderRequestId: () => 1,
            summarizePageDom: () => ({}),
            clearSelectionBeforePageLayerTeardown: vi.fn(),
            clearPageVisual: vi.fn(() => false),
            trackOptionalTextLayerTask: vi.fn(async (_pageNumber, _version, _requestId, task) => {
                await task;
            }),
            cleanupPageIfCurrentRender: vi.fn(),
            cleanupCanvasRenderResult: vi.fn(),
            loadPageForRender: vi.fn(async () => {
                effectiveScale.value = 2;
                return pageLease;
            }),
            prepareCanvasRenderForPage: vi.fn(async () => ({
                canvas: document.createElement('canvas'),
                startRender: vi.fn(),
            })),
            renderPreparedCanvasForPage: vi.fn(async prepared => ({ canvas: prepared.canvas })),
            prepareCanvasForRender: vi.fn(async () => ({ canvas: document.createElement('canvas') })),
            applyContainerUserUnit: vi.fn(),
            mountRenderedCanvas: vi.fn(),
            scheduleRenderForSinglePage: vi.fn(),
            scheduleMissingRenderTargetRetry: vi.fn(),
            clearMissingRenderTargetRetry: vi.fn(),
            waitForRenderLifecycleDelay: vi.fn(async () => true),
            renderTextLayerForPage: vi.fn(async () => true),
            renderAnnotationLayersForPage: vi.fn(async () => ({
                shouldContinue: true,
                annotationLayerInstance: null,
            })),
            renderAnnotationEditorLayer,
            getViewportForAnnotationEditorLayer,
            scheduleOcrDebugForPage: vi.fn(),
            markPageCanvasSurfaceEvictable: vi.fn(),
            logNonCriticalStageError: vi.fn(),
        });

        const rendered = await controller.renderAnnotationEditorLayerForPage(1);

        expect(rendered).toBe(true);
        expect(getViewportForAnnotationEditorLayer).toHaveBeenCalledWith(pdfPage, 1);
        expect(renderAnnotationEditorLayer).toHaveBeenCalledOnce();
        expect(pageLease.release).toHaveBeenCalled();
    });

    it('reports standalone annotation-editor layer failure instead of treating current DOM as ready', async () => {
        const { root } = createPageRoot();
        const pdfPage = { cleanup: vi.fn() } as PDFPageProxy & {cleanup: ReturnType<typeof vi.fn>};
        const pageLease = createPageLease(pdfPage);
        const renderAnnotationEditorLayer = vi.fn(async () => ({
            ok: false,
            reason: 'render-error',
            error: new Error('failed'),
            retryable: false,
        } as const));

        const controller = usePdfRendererSinglePageController({
            isActive: true,
            effectiveScale: 1,
            outputScale: 1,
            annotationUiManager: {},
            getContainerRoot: () => root,
            renderingPages: new Map(),
            renderingPageRequestIds: new Map(),
            activeRenderTasks: new Map(),
            getRenderVersion: () => 1,
            getRenderDocumentToken: () => 'doc-1',
            getDocumentRevision: () => 'rev-1',
            getVisibleRenderRequestId: () => 1,
            summarizePageDom: () => ({}),
            clearSelectionBeforePageLayerTeardown: vi.fn(),
            clearPageVisual: vi.fn(() => false),
            trackOptionalTextLayerTask: vi.fn(async (_pageNumber, _version, _requestId, task) => {
                await task;
            }),
            cleanupPageIfCurrentRender: vi.fn(),
            cleanupCanvasRenderResult: vi.fn(),
            loadPageForRender: vi.fn(async () => pageLease),
            prepareCanvasRenderForPage: vi.fn(async () => ({
                canvas: document.createElement('canvas'),
                startRender: vi.fn(),
            })),
            renderPreparedCanvasForPage: vi.fn(async prepared => ({ canvas: prepared.canvas })),
            prepareCanvasForRender: vi.fn(async () => ({ canvas: document.createElement('canvas') })),
            applyContainerUserUnit: vi.fn(),
            mountRenderedCanvas: vi.fn(),
            scheduleRenderForSinglePage: vi.fn(),
            scheduleMissingRenderTargetRetry: vi.fn(),
            clearMissingRenderTargetRetry: vi.fn(),
            waitForRenderLifecycleDelay: vi.fn(async () => true),
            renderTextLayerForPage: vi.fn(async () => true),
            renderAnnotationLayersForPage: vi.fn(async () => ({
                shouldContinue: true,
                annotationLayerInstance: null,
            })),
            renderAnnotationEditorLayer,
            getViewportForAnnotationEditorLayer: vi.fn(() => ({}) as never),
            scheduleOcrDebugForPage: vi.fn(),
            markPageCanvasSurfaceEvictable: vi.fn(),
            logNonCriticalStageError: vi.fn(),
        });

        const rendered = await controller.renderAnnotationEditorLayerForPage(1);

        expect(rendered).toBe(false);
        expect(renderAnnotationEditorLayer).toHaveBeenCalledOnce();
        expect(pageLease.release).toHaveBeenCalled();
    });

    it('times out and aborts a stalled standalone annotation-editor layer render', async () => {
        vi.useFakeTimers();
        try {
            const { root } = createPageRoot();
            const pdfPage = { cleanup: vi.fn() } as PDFPageProxy & {cleanup: ReturnType<typeof vi.fn>};
            const pageLease = createPageLease(pdfPage);
            const annotationEditorSignals: AbortSignal[] = [];
            const renderAnnotationEditorLayer = vi.fn((...args: unknown[]) => {
                annotationEditorSignals.push((args[6] as {signal: AbortSignal}).signal);
                return new Promise<never>(() => {});
            });
            const logNonCriticalStageError = vi.fn();

            const controller = usePdfRendererSinglePageController({
                isActive: true,
                effectiveScale: 1,
                outputScale: 1,
                annotationUiManager: {},
                getContainerRoot: () => root,
                renderingPages: new Map(),
                renderingPageRequestIds: new Map(),
                activeRenderTasks: new Map(),
                getRenderVersion: () => 1,
                getRenderDocumentToken: () => 'doc-1',
                getDocumentRevision: () => 'rev-1',
                getVisibleRenderRequestId: () => 1,
                summarizePageDom: () => ({}),
                clearSelectionBeforePageLayerTeardown: vi.fn(),
                clearPageVisual: vi.fn(() => false),
                trackOptionalTextLayerTask: vi.fn(async (_pageNumber, _version, _requestId, task) => {
                    await task;
                }),
                cleanupPageIfCurrentRender: vi.fn(),
                cleanupCanvasRenderResult: vi.fn(),
                loadPageForRender: vi.fn(async () => pageLease),
                prepareCanvasRenderForPage: vi.fn(async () => ({
                    canvas: document.createElement('canvas'),
                    startRender: vi.fn(),
                })),
                renderPreparedCanvasForPage: vi.fn(async prepared => ({ canvas: prepared.canvas })),
                prepareCanvasForRender: vi.fn(async () => ({ canvas: document.createElement('canvas') })),
                applyContainerUserUnit: vi.fn(),
                mountRenderedCanvas: vi.fn(),
                scheduleRenderForSinglePage: vi.fn(),
                scheduleMissingRenderTargetRetry: vi.fn(),
                clearMissingRenderTargetRetry: vi.fn(),
                waitForRenderLifecycleDelay: vi.fn(async () => true),
                renderTextLayerForPage: vi.fn(async () => true),
                renderAnnotationLayersForPage: vi.fn(async () => ({
                    shouldContinue: true,
                    annotationLayerInstance: null,
                })),
                renderAnnotationEditorLayer,
                getViewportForAnnotationEditorLayer: vi.fn(() => ({}) as never),
                scheduleOcrDebugForPage: vi.fn(),
                markPageCanvasSurfaceEvictable: vi.fn(),
                logNonCriticalStageError,
            });

            const renderPromise = controller.renderAnnotationEditorLayerForPage(1);
            await vi.advanceTimersByTimeAsync(0);
            expect(annotationEditorSignals).toHaveLength(1);

            await vi.advanceTimersByTimeAsync(PDF_PAGE_RENDER_TIMEOUT_MS);

            await expect(renderPromise).resolves.toBe(false);
            expect(annotationEditorSignals[0]?.aborted).toBe(true);
            expect(logNonCriticalStageError).toHaveBeenCalledWith(
                1,
                'annotation editor layer',
                expect.objectContaining({
                    name: 'PdfPageRenderTimeoutError',
                    stage: 'annotation-editor-layer',
                }),
            );
            expect(pageLease.release).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});
