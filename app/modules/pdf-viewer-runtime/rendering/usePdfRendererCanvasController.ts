import type { PDFPageProxy } from 'pdfjs-dist';
import type { usePdfCanvasRenderer } from '@app/composables/pdf/usePdfCanvasRenderer';
import {
    PDF_PAGE_LOAD_TIMEOUT_MS,
    PDF_PAGE_RENDER_TIMEOUT_MS,
} from '@app/constants/timeouts';
import {
    withPageStageTimeout,
    type IPageRenderStallPayload,
} from '@app/composables/pdf/pdfPageRenderTimeout';
import { BrowserLogger } from '@app/utils/browserLogger';

interface ICancelableRenderTask {
    cancel: () => void;
    promise: Promise<unknown>;
}

interface IRenderVisiblePagesOptions {maxCanvasPixelsOverride?: number;}

interface IUsePdfRendererCanvasControllerOptions {
    canvasRenderer: ReturnType<typeof usePdfCanvasRenderer>;
    activeRenderTasks: Map<number, {
        version: number;
        requestId: number;
        task: ICancelableRenderTask;
    }>;
    pageCanvases: Map<number, HTMLCanvasElement>;
    hiddenAnnotationIds: () => Set<string> | undefined;
    getRenderVersion: () => number;
    getPage: (pageNumber: number) => Promise<PDFPageProxy>;
    cancelActiveRenderTask: (pageNumber: number) => void;
    cancelActiveRenderTaskIfCurrent: (pageNumber: number, version: number, requestId: number) => void;
    onRenderStall?: ((payload: IPageRenderStallPayload) => void) | undefined;
}

export function usePdfRendererCanvasController(options: IUsePdfRendererCanvasControllerOptions) {
    const {
        canvasRenderer,
        activeRenderTasks,
        pageCanvases,
        hiddenAnnotationIds,
        getRenderVersion,
        getPage,
        cancelActiveRenderTask,
        cancelActiveRenderTaskIfCurrent,
        onRenderStall,
    } = options;

    function releasePageResources(
        pageNumber: number,
        pdfPage: PDFPageProxy,
    ) {
        try {
            pdfPage.cleanup();
        } catch (error) {
            BrowserLogger.warn(
                'pdf-renderer',
                `Failed to release PDF page resources for page ${pageNumber}`,
                error,
            );
        }
    }

    async function renderPreparedCanvasResult(
        pageNumber: number,
        version: number,
        requestId: number,
        preparedCanvasRender: NonNullable<Awaited<ReturnType<typeof canvasRenderer.prepareCanvasRender>>>,
        shouldContinue: () => boolean,
    ) {
        const {
            startRender,
            ...preparedRenderResult
        } = preparedCanvasRender;

        return withPageStageTimeout(
            new Promise<typeof preparedRenderResult>((resolve, reject) => {
                const renderTask = startRender();
                if (getRenderVersion() !== version || !shouldContinue()) {
                    try {
                        renderTask.cancel();
                    } catch {
                        // Ignore cancellation failures.
                    }
                    reject(new Error(`Rendering cancelled before canvas paint for page ${pageNumber}`));
                    return;
                }

                const previousTask = activeRenderTasks.get(pageNumber);
                if (previousTask && previousTask.task !== renderTask) {
                    cancelActiveRenderTask(pageNumber);
                }
                activeRenderTasks.set(pageNumber, {
                    version,
                    requestId,
                    task: renderTask,
                });

                renderTask.promise.then(
                    () => resolve(preparedRenderResult),
                    reject,
                );
            }),
            {
                pageNumber,
                stage: 'canvas-render',
                timeoutMs: PDF_PAGE_RENDER_TIMEOUT_MS,
            },
            () => getRenderVersion() === version && shouldContinue(),
            () => {
                cancelActiveRenderTaskIfCurrent(pageNumber, version, requestId);
            },
            onRenderStall,
        );
    }

    async function loadPageForRender(
        pageNumber: number,
        version: number,
        shouldContinue: () => boolean,
    ) {
        const pdfPage = await withPageStageTimeout(
            getPage(pageNumber),
            {
                pageNumber,
                stage: 'page-load',
                timeoutMs: PDF_PAGE_LOAD_TIMEOUT_MS,
            },
            () => getRenderVersion() === version && shouldContinue(),
            undefined,
            onRenderStall,
        );
        return getRenderVersion() === version && shouldContinue() ? pdfPage : null;
    }

    async function prepareCanvasForRender(
        pdfPage: PDFPageProxy,
        pageNumber: number,
        version: number,
        requestId: number,
        scale: number,
        shouldContinue: () => boolean,
        renderOptions?: IRenderVisiblePagesOptions,
    ) {
        const canvasRenderOptions: Parameters<typeof canvasRenderer.prepareCanvasRender>[2] = {};
        const ids = hiddenAnnotationIds();
        if (ids !== undefined) {
            canvasRenderOptions.hiddenAnnotationIds = ids;
        }
        if (renderOptions?.maxCanvasPixelsOverride !== undefined) {
            canvasRenderOptions.maxCanvasPixels = renderOptions.maxCanvasPixelsOverride;
        }
        const preparedCanvasRender = await canvasRenderer.prepareCanvasRender(
            pdfPage,
            scale,
            canvasRenderOptions,
        );
        if (!preparedCanvasRender) {
            return null;
        }

        if (getRenderVersion() !== version || !shouldContinue()) {
            canvasRenderer.cleanupCanvasRenderResult(preparedCanvasRender);
            return null;
        }

        try {
            const renderResult = await renderPreparedCanvasResult(
                pageNumber,
                version,
                requestId,
                preparedCanvasRender,
                shouldContinue,
            );
            if (!shouldContinue()) {
                canvasRenderer.cleanupCanvasRenderResult(renderResult);
                return null;
            }
            return renderResult;
        } catch (error) {
            canvasRenderer.cleanupCanvasRenderResult(preparedCanvasRender);
            throw error;
        }
    }

    function mountRenderedCanvas(
        pageNumber: number,
        container: HTMLElement,
        canvasHost: HTMLDivElement,
        renderResult: Awaited<ReturnType<typeof renderPreparedCanvasResult>>,
        scale: number,
    ) {
        const {
            canvas,
            viewport,
            userUnit,
            totalScaleFactor,
        } = renderResult;

        canvasRenderer.applyContainerDimensions(
            container,
            viewport,
            scale,
            userUnit,
            totalScaleFactor,
        );
        const previousCanvas = pageCanvases.get(pageNumber);
        canvasRenderer.mountCanvas(
            canvasHost,
            canvas,
            previousCanvas,
        );
        if (previousCanvas && previousCanvas !== canvas) {
            canvasRenderer.cleanupCanvas(previousCanvas);
        }
        pageCanvases.set(pageNumber, canvas);
    }

    return {
        releasePageResources,
        renderPreparedCanvasResult,
        loadPageForRender,
        prepareCanvasForRender,
        mountRenderedCanvas,
    };
}
