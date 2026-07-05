import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { usePdfRendererCanvasController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererCanvasController';
import { PDF_PAGE_RENDER_TIMEOUT_MS } from '@app/constants/timeouts';
import {
    resetCoordinatedPdfPageRendersForTest,
    runCoordinatedPdfPageRender,
} from '@app/modules/pdf-viewer/engine/pdf-page-render-coordinator/coordinatedPdfPageRender';

function createDeferredRenderTask() {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return {
        task: {
            cancel: vi.fn(),
            promise,
        },
        resolve,
    };
}

describe('usePdfRendererCanvasController', () => {
    afterEach(() => {
        vi.useRealTimers();
        resetCoordinatedPdfPageRendersForTest();
    });

    it('passes page-specific hidden annotation ids into canvas preparation', async () => {
        const hiddenAnnotationIds = vi.fn((pageNumber: number) => new Set([`hidden-${pageNumber}`]));
        const renderTask = {
            cancel: vi.fn(),
            promise: Promise.resolve(),
        };
        const preparedCanvasRender = {
            canvas: {} as HTMLCanvasElement,
            viewport: {} as never,
            annotationCanvasMap: new Map<string, HTMLCanvasElement>(),
            scaleX: 1,
            scaleY: 1,
            rawDims: {
                pageWidth: 1,
                pageHeight: 1,
            },
            userUnit: 1,
            totalScaleFactor: 1,
            requestedPixels: 1,
            grantedPixels: 1,
            pixelScaleFactor: 1,
            wasClamped: false,
            startRender: vi.fn(() => renderTask),
        };
        const prepareCanvasRender = vi.fn(async (
            _pdfPage: unknown,
            _scale: number,
            _options?: {
                hiddenAnnotationIds?: Set<string>;
                pageRenderCoordination?: {
                    signal?: AbortSignal | undefined;
                    shouldStart?: (() => boolean) | undefined;
                };
            },
        ) => preparedCanvasRender);
        const controller = usePdfRendererCanvasController({
            canvasRenderer: {
                prepareCanvasRender,
                renderCanvas: vi.fn(),
                cleanupCanvas: vi.fn(),
                cleanupCanvasRenderResult: vi.fn(),
                estimateRequestedPixels: vi.fn(),
                applyContainerDimensions: vi.fn(),
                mountCanvas: vi.fn(),
            },
            activeRenderTasks: new Map(),
            pageCanvases: new Map(),
            hiddenAnnotationIds,
            getRenderVersion: () => 5,
            getPage: vi.fn(),
            releasePage: vi.fn(),
            cancelActiveRenderTask: vi.fn(),
            cancelActiveRenderTaskIfCurrent: vi.fn(),
        });

        await controller.prepareCanvasForRender(
            {} as never,
            42,
            5,
            1,
            1.5,
            () => true,
        );

        expect(hiddenAnnotationIds).toHaveBeenCalledWith(42);
        expect(prepareCanvasRender).toHaveBeenCalledOnce();
        const canvasOptions = prepareCanvasRender.mock.calls[0]?.[2];
        expect(canvasOptions?.hiddenAnnotationIds).toEqual(new Set(['hidden-42']));
        expect(canvasOptions?.pageRenderCoordination?.signal).toBeInstanceOf(AbortSignal);
        expect(canvasOptions?.pageRenderCoordination?.shouldStart?.()).toBe(true);
    });

    it('aborts canvas prepare coordination when the prepare stage times out', async () => {
        vi.useFakeTimers();
        let coordination: { signal?: AbortSignal | undefined } | undefined;
        const onRenderStall = vi.fn();
        const controller = usePdfRendererCanvasController({
            canvasRenderer: {
                prepareCanvasRender: vi.fn((
                    _pdfPage: unknown,
                    _scale: number,
                    options?: { pageRenderCoordination?: { signal?: AbortSignal | undefined }; },
                ) => {
                    coordination = options?.pageRenderCoordination;
                    return new Promise<never>(() => undefined);
                }),
                renderCanvas: vi.fn(),
                cleanupCanvas: vi.fn(),
                cleanupCanvasRenderResult: vi.fn(),
                estimateRequestedPixels: vi.fn(),
                applyContainerDimensions: vi.fn(),
                mountCanvas: vi.fn(),
            },
            activeRenderTasks: new Map(),
            pageCanvases: new Map(),
            hiddenAnnotationIds: (_pageNumber: number) => new Set(['hidden-7']),
            getRenderVersion: () => 5,
            getPage: vi.fn(),
            releasePage: vi.fn(),
            cancelActiveRenderTask: vi.fn(),
            cancelActiveRenderTaskIfCurrent: vi.fn(),
            onRenderStall,
        });

        const preparePromise = controller.prepareCanvasForRender(
            {} as never,
            7,
            5,
            1,
            1,
            () => true,
        );
        const prepareExpectation = expect(preparePromise).rejects.toMatchObject({
            pageNumber: 7,
            stage: 'canvas-prepare',
        });

        expect(coordination?.signal?.aborted).toBe(false);
        vi.advanceTimersByTime(PDF_PAGE_RENDER_TIMEOUT_MS);
        await prepareExpectation;

        expect(coordination?.signal?.aborted).toBe(true);
        expect(onRenderStall).toHaveBeenCalledOnce();
    });

    it('cancels an existing same-page PDF.js task before starting its replacement', async () => {
        const events: string[] = [];
        const previousTask = {
            cancel: vi.fn(() => {
                events.push('cancel previous');
            }),
            promise: new Promise(() => undefined),
        };
        const nextTask = {
            cancel: vi.fn(),
            promise: Promise.resolve(),
        };
        const activeRenderTasks = new Map([[
            928,
            {
                version: 5,
                requestId: 143,
                task: previousTask,
            },
        ]]);
        const cancelActiveRenderTask = vi.fn((pageNumber: number) => {
            const activeTask = activeRenderTasks.get(pageNumber);
            activeRenderTasks.delete(pageNumber);
            activeTask?.task.cancel();
        });
        const controller = usePdfRendererCanvasController({
            canvasRenderer: {
                prepareCanvasRender: vi.fn(),
                renderCanvas: vi.fn(),
                cleanupCanvas: vi.fn(),
                cleanupCanvasRenderResult: vi.fn(),
                estimateRequestedPixels: vi.fn(),
                applyContainerDimensions: vi.fn(),
                mountCanvas: vi.fn(),
            },
            activeRenderTasks,
            pageCanvases: new Map(),
            hiddenAnnotationIds: (_pageNumber: number) => undefined,
            getRenderVersion: () => 5,
            getPage: vi.fn(),
            releasePage: vi.fn(),
            cancelActiveRenderTask,
            cancelActiveRenderTaskIfCurrent: vi.fn(),
        });
        const preparedCanvasRender = {
            canvas: {} as HTMLCanvasElement,
            viewport: {} as never,
            annotationCanvasMap: new Map<string, HTMLCanvasElement>(),
            scaleX: 1,
            scaleY: 1,
            rawDims: {
                pageWidth: 1,
                pageHeight: 1,
            },
            userUnit: 1,
            totalScaleFactor: 1,
            requestedPixels: 1,
            grantedPixels: 1,
            pixelScaleFactor: 1,
            wasClamped: false,
            startRender: vi.fn(() => {
                events.push('start replacement');
                return nextTask;
            }),
        };

        await controller.renderPreparedCanvasResult(
            {} as never,
            928,
            5,
            144,
            preparedCanvasRender,
            () => true,
        );

        expect(events).toEqual([
            'cancel previous',
            'start replacement',
        ]);
        expect(cancelActiveRenderTask).toHaveBeenCalledWith(928);
        expect(activeRenderTasks.get(928)?.task).toBe(nextTask);
    });

    it('releases a leased page when the completed page load is stale', async () => {
        let renderVersion = 1;
        const pdfPage = {} as never;
        const pageLoad = Promise.withResolvers<typeof pdfPage>();
        const releasePage = vi.fn();
        const controller = usePdfRendererCanvasController({
            canvasRenderer: {
                prepareCanvasRender: vi.fn(),
                renderCanvas: vi.fn(),
                cleanupCanvas: vi.fn(),
                cleanupCanvasRenderResult: vi.fn(),
                estimateRequestedPixels: vi.fn(),
                applyContainerDimensions: vi.fn(),
                mountCanvas: vi.fn(),
            },
            activeRenderTasks: new Map(),
            pageCanvases: new Map(),
            hiddenAnnotationIds: (_pageNumber: number) => undefined,
            getRenderVersion: () => renderVersion,
            getPage: vi.fn(() => pageLoad.promise),
            releasePage,
            cancelActiveRenderTask: vi.fn(),
            cancelActiveRenderTaskIfCurrent: vi.fn(),
        });

        const loadPromise = controller.loadPageForRender(1, 1, () => true);
        renderVersion = 2;
        pageLoad.resolve(pdfPage);

        await expect(loadPromise).resolves.toBeNull();
        expect(releasePage).toHaveBeenCalledWith(1, pdfPage);
    });

    it('does not start a canvas render after its stage timeout fires while waiting for the page coordinator', async () => {
        vi.useFakeTimers();
        const pdfPage = {} as never;
        const blockingRender = createDeferredRenderTask();
        const blockedRun = runCoordinatedPdfPageRender({
            owner: 'thumbnail',
            pageNumber: 7,
            pdfPage,
            priority: 100,
            startRender: () => blockingRender.task,
        });
        await Promise.resolve();

        const replacementTask = {
            cancel: vi.fn(),
            promise: Promise.resolve(),
        };
        const preparedCanvasRender = {
            canvas: {} as HTMLCanvasElement,
            viewport: {} as never,
            annotationCanvasMap: new Map<string, HTMLCanvasElement>(),
            scaleX: 1,
            scaleY: 1,
            rawDims: {
                pageWidth: 1,
                pageHeight: 1,
            },
            userUnit: 1,
            totalScaleFactor: 1,
            requestedPixels: 1,
            grantedPixels: 1,
            pixelScaleFactor: 1,
            wasClamped: false,
            startRender: vi.fn(() => replacementTask),
        };
        const activeRenderTasks = new Map();
        const onRenderStall = vi.fn();
        const controller = usePdfRendererCanvasController({
            canvasRenderer: {
                prepareCanvasRender: vi.fn(),
                renderCanvas: vi.fn(),
                cleanupCanvas: vi.fn(),
                cleanupCanvasRenderResult: vi.fn(),
                estimateRequestedPixels: vi.fn(),
                applyContainerDimensions: vi.fn(),
                mountCanvas: vi.fn(),
            },
            activeRenderTasks,
            pageCanvases: new Map(),
            hiddenAnnotationIds: (_pageNumber: number) => undefined,
            getRenderVersion: () => 5,
            getPage: vi.fn(),
            releasePage: vi.fn(),
            cancelActiveRenderTask: vi.fn(),
            cancelActiveRenderTaskIfCurrent: vi.fn(),
            onRenderStall,
        });

        const renderPromise = controller.renderPreparedCanvasResult(
            pdfPage,
            7,
            5,
            144,
            preparedCanvasRender,
            () => true,
        );
        const renderExpectation = expect(renderPromise).rejects.toMatchObject({
            pageNumber: 7,
            stage: 'canvas-render',
        });

        vi.advanceTimersByTime(PDF_PAGE_RENDER_TIMEOUT_MS);
        await renderExpectation;

        blockingRender.resolve();
        await blockedRun;
        await Promise.resolve();

        expect(onRenderStall).toHaveBeenCalledOnce();
        expect(preparedCanvasRender.startRender).not.toHaveBeenCalled();
        expect(activeRenderTasks.has(7)).toBe(false);
    });
});
