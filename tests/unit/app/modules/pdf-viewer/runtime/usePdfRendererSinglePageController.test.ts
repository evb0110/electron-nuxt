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

function createPageRoot() {
    document.body.replaceChildren();
    const root = document.createElement('div');
    const page = document.createElement('div');
    page.classList.add('page_container');
    page.dataset.page = '1';
    const pageClassAdd = vi.spyOn(page.classList, 'add');

    const canvasHost = document.createElement('div');
    canvasHost.classList.add('page_canvas');
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
        pageClassAdd,
    };
}

describe('usePdfRendererSinglePageController', () => {
    it('cleans a mounted canvas when a later async text-layer stage goes stale', async () => {
        const {
            root,
            canvasHost,
            pageClassAdd,
        } = createPageRoot();
        let renderVersion = 1;
        const pdfPage = { cleanup: vi.fn() } as PDFPageProxy & {cleanup: ReturnType<typeof vi.fn>};
        const cleanupPageIfCurrentRender = vi.fn(() => {
            canvasHost.replaceChildren();
        });
        const releasePageResources = vi.fn();
        const renderingPages = new Map<number, number>();
        const renderingPageRequestIds = new Map<number, number>();

        const controller = usePdfRendererSinglePageController({
            isActive: true,
            effectiveScale: 1,
            annotationUiManager: null,
            getContainerRoot: () => root,
            renderedPages: new Set<number>(),
            staleRenderedPages: new Set<number>(),
            renderingPages,
            renderingPageRequestIds,
            activeRenderTasks: new Map(),
            getRenderVersion: () => renderVersion,
            getRenderDocumentToken: () => 'doc-1',
            getVisibleRenderRequestId: () => 1,
            summarizePageDom: () => ({}),
            clearSelectionBeforePageLayerTeardown: vi.fn(),
            cleanupPageIfCurrentRender,
            cleanupCanvasRenderResult: vi.fn(),
            releasePageResources,
            loadPageForRender: vi.fn(async () => pdfPage),
            prepareCanvasRenderForPage: vi.fn(async () => ({
                canvas: document.createElement('canvas'),
                startRender: vi.fn(),
            })),
            renderPreparedCanvasForPage: vi.fn(async prepared => ({ canvas: prepared.canvas })),
            prepareCanvasForRender: vi.fn(async () => ({ canvas: document.createElement('canvas') })),
            applyContainerDimensions: vi.fn(),
            mountRenderedCanvas: vi.fn((_pageNumber, _container, _host, renderResult) => {
                canvasHost.append(renderResult.canvas);
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

        expect(canvasHost.children).toHaveLength(0);
        expect(pageClassAdd).not.toHaveBeenCalledWith('page_container--rendered');
        expect(cleanupPageIfCurrentRender).toHaveBeenCalledWith(1, 1, 1);
        expect(releasePageResources).toHaveBeenCalledWith(1, pdfPage);
        expect(renderingPages.has(1)).toBe(false);
    });

    it('releases the loaded page when canvas preparation throws', async () => {
        const { root } = createPageRoot();
        const pdfPage = { cleanup: vi.fn() } as PDFPageProxy & {cleanup: ReturnType<typeof vi.fn>};
        const releasePageResources = vi.fn();
        const cleanupPageIfCurrentRender = vi.fn();
        const controller = usePdfRendererSinglePageController({
            isActive: true,
            effectiveScale: 1,
            annotationUiManager: null,
            getContainerRoot: () => root,
            renderedPages: new Set<number>(),
            staleRenderedPages: new Set<number>(),
            renderingPages: new Map(),
            renderingPageRequestIds: new Map(),
            activeRenderTasks: new Map(),
            getRenderVersion: () => 1,
            getRenderDocumentToken: () => 'doc-1',
            getVisibleRenderRequestId: () => 1,
            summarizePageDom: () => ({}),
            clearSelectionBeforePageLayerTeardown: vi.fn(),
            cleanupPageIfCurrentRender,
            cleanupCanvasRenderResult: vi.fn(),
            releasePageResources,
            loadPageForRender: vi.fn(async () => pdfPage),
            prepareCanvasRenderForPage: vi.fn(async () => ({
                canvas: document.createElement('canvas'),
                startRender: vi.fn(),
            })),
            renderPreparedCanvasForPage: vi.fn(async prepared => ({ canvas: prepared.canvas })),
            prepareCanvasForRender: vi.fn(async () => {
                throw new Error('canvas prepare failed');
            }),
            applyContainerDimensions: vi.fn(),
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

        expect(cleanupPageIfCurrentRender).toHaveBeenCalledWith(1, 1, 1);
        expect(releasePageResources).toHaveBeenCalledTimes(1);
        expect(releasePageResources).toHaveBeenCalledWith(1, pdfPage);
    });

    it('retries a cancelled current-page render without reusing its settled transaction request', async () => {
        const { root } = createPageRoot();
        const pdfPage = { cleanup: vi.fn() } as PDFPageProxy & {cleanup: ReturnType<typeof vi.fn>};
        const scheduleRenderForSinglePage = vi.fn();
        const cancelledError = Object.assign(new Error('rendering cancelled'), {name: 'RenderingCancelledException'});
        const controller = usePdfRendererSinglePageController({
            isActive: true,
            effectiveScale: 1,
            annotationUiManager: null,
            getContainerRoot: () => root,
            renderedPages: new Set<number>(),
            staleRenderedPages: new Set<number>(),
            renderingPages: new Map(),
            renderingPageRequestIds: new Map(),
            activeRenderTasks: new Map(),
            getRenderVersion: () => 1,
            getRenderDocumentToken: () => 'doc-1',
            getVisibleRenderRequestId: () => 1,
            summarizePageDom: () => ({}),
            clearSelectionBeforePageLayerTeardown: vi.fn(),
            cleanupPageIfCurrentRender: vi.fn(),
            cleanupCanvasRenderResult: vi.fn(),
            releasePageResources: vi.fn(),
            loadPageForRender: vi.fn(async () => pdfPage),
            prepareCanvasRenderForPage: vi.fn(async () => ({
                canvas: document.createElement('canvas'),
                startRender: vi.fn(),
            })),
            renderPreparedCanvasForPage: vi.fn(async prepared => ({ canvas: prepared.canvas })),
            prepareCanvasForRender: vi.fn(async () => {
                throw cancelledError;
            }),
            applyContainerDimensions: vi.fn(),
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
        await Promise.resolve();

        expect(scheduleRenderForSinglePage.mock.calls).toEqual([[
            1,
            {
                preserveRenderedPages: true,
                bufferOverride: 0,
            },
        ]]);
    });

    it('uses the invocation scale for standalone annotation-editor layer renders', async () => {
        const { root } = createPageRoot();
        const renderVersion = 1;
        const effectiveScale = ref(1);
        const pdfPage = { cleanup: vi.fn() } as PDFPageProxy & {cleanup: ReturnType<typeof vi.fn>};
        const releasePageResources = vi.fn();
        const getViewportForAnnotationEditorLayer = vi.fn(() => ({}) as never);
        const renderAnnotationEditorLayer = vi.fn(async () => ({
            ok: true,
            rendered: true,
        } as const));

        const controller = usePdfRendererSinglePageController({
            isActive: true,
            effectiveScale,
            annotationUiManager: {},
            getContainerRoot: () => root,
            renderedPages: new Set<number>(),
            staleRenderedPages: new Set<number>(),
            renderingPages: new Map(),
            renderingPageRequestIds: new Map(),
            activeRenderTasks: new Map(),
            getRenderVersion: () => renderVersion,
            getRenderDocumentToken: () => 'doc-1',
            getVisibleRenderRequestId: () => 1,
            summarizePageDom: () => ({}),
            clearSelectionBeforePageLayerTeardown: vi.fn(),
            cleanupPageIfCurrentRender: vi.fn(),
            cleanupCanvasRenderResult: vi.fn(),
            releasePageResources,
            loadPageForRender: vi.fn(async () => {
                effectiveScale.value = 2;
                return pdfPage;
            }),
            prepareCanvasRenderForPage: vi.fn(async () => ({
                canvas: document.createElement('canvas'),
                startRender: vi.fn(),
            })),
            renderPreparedCanvasForPage: vi.fn(async prepared => ({ canvas: prepared.canvas })),
            prepareCanvasForRender: vi.fn(async () => ({ canvas: document.createElement('canvas') })),
            applyContainerDimensions: vi.fn(),
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
            logNonCriticalStageError: vi.fn(),
        });

        const rendered = await controller.renderAnnotationEditorLayerForPage(1);

        expect(rendered).toBe(true);
        expect(getViewportForAnnotationEditorLayer).toHaveBeenCalledWith(pdfPage, 1);
        expect(renderAnnotationEditorLayer).toHaveBeenCalledOnce();
        expect(releasePageResources).toHaveBeenCalledWith(1, pdfPage);
    });

    it('reports standalone annotation-editor layer failure instead of treating current DOM as ready', async () => {
        const { root } = createPageRoot();
        const pdfPage = { cleanup: vi.fn() } as PDFPageProxy & {cleanup: ReturnType<typeof vi.fn>};
        const releasePageResources = vi.fn();
        const renderAnnotationEditorLayer = vi.fn(async () => ({
            ok: false,
            reason: 'render-error',
            error: new Error('failed'),
            retryable: false,
        } as const));

        const controller = usePdfRendererSinglePageController({
            isActive: true,
            effectiveScale: 1,
            annotationUiManager: {},
            getContainerRoot: () => root,
            renderedPages: new Set<number>(),
            staleRenderedPages: new Set<number>(),
            renderingPages: new Map(),
            renderingPageRequestIds: new Map(),
            activeRenderTasks: new Map(),
            getRenderVersion: () => 1,
            getRenderDocumentToken: () => 'doc-1',
            getVisibleRenderRequestId: () => 1,
            summarizePageDom: () => ({}),
            clearSelectionBeforePageLayerTeardown: vi.fn(),
            cleanupPageIfCurrentRender: vi.fn(),
            cleanupCanvasRenderResult: vi.fn(),
            releasePageResources,
            loadPageForRender: vi.fn(async () => pdfPage),
            prepareCanvasRenderForPage: vi.fn(async () => ({
                canvas: document.createElement('canvas'),
                startRender: vi.fn(),
            })),
            renderPreparedCanvasForPage: vi.fn(async prepared => ({ canvas: prepared.canvas })),
            prepareCanvasForRender: vi.fn(async () => ({ canvas: document.createElement('canvas') })),
            applyContainerDimensions: vi.fn(),
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
            logNonCriticalStageError: vi.fn(),
        });

        const rendered = await controller.renderAnnotationEditorLayerForPage(1);

        expect(rendered).toBe(false);
        expect(renderAnnotationEditorLayer).toHaveBeenCalledOnce();
        expect(releasePageResources).toHaveBeenCalledWith(1, pdfPage);
    });

    it('times out and aborts a stalled standalone annotation-editor layer render', async () => {
        vi.useFakeTimers();
        try {
            const { root } = createPageRoot();
            const pdfPage = { cleanup: vi.fn() } as PDFPageProxy & {cleanup: ReturnType<typeof vi.fn>};
            const releasePageResources = vi.fn();
            const annotationEditorSignals: AbortSignal[] = [];
            const renderAnnotationEditorLayer = vi.fn((...args: unknown[]) => {
                annotationEditorSignals.push((args[6] as {signal: AbortSignal}).signal);
                return new Promise<never>(() => {});
            });
            const logNonCriticalStageError = vi.fn();

            const controller = usePdfRendererSinglePageController({
                isActive: true,
                effectiveScale: 1,
                annotationUiManager: {},
                getContainerRoot: () => root,
                renderedPages: new Set<number>(),
                staleRenderedPages: new Set<number>(),
                renderingPages: new Map(),
                renderingPageRequestIds: new Map(),
                activeRenderTasks: new Map(),
                getRenderVersion: () => 1,
                getRenderDocumentToken: () => 'doc-1',
                getVisibleRenderRequestId: () => 1,
                summarizePageDom: () => ({}),
                clearSelectionBeforePageLayerTeardown: vi.fn(),
                cleanupPageIfCurrentRender: vi.fn(),
                cleanupCanvasRenderResult: vi.fn(),
                releasePageResources,
                loadPageForRender: vi.fn(async () => pdfPage),
                prepareCanvasRenderForPage: vi.fn(async () => ({
                    canvas: document.createElement('canvas'),
                    startRender: vi.fn(),
                })),
                renderPreparedCanvasForPage: vi.fn(async prepared => ({ canvas: prepared.canvas })),
                prepareCanvasForRender: vi.fn(async () => ({ canvas: document.createElement('canvas') })),
                applyContainerDimensions: vi.fn(),
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
            expect(releasePageResources).toHaveBeenCalledWith(1, pdfPage);
        } finally {
            vi.useRealTimers();
        }
    });
});
