import type {
    ICancelableRenderTask,
    IRenderVisiblePagesOptions,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { usePdfCanvasRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfCanvasRenderer';
import {
    PDF_PAGE_LOAD_TIMEOUT_MS,
    PDF_PAGE_RENDER_TIMEOUT_MS,
} from '@app/constants/timeouts';
import type { IPageRenderStallPayload } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/pdfPageRenderTimeoutTypes';
import { withPageStageTimeout } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/withPageStageTimeout';
import { BrowserLogger } from '@app/utils/browserLogger';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';



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
                if (getRenderVersion() !== version || !shouldContinue()) {
                    reject(new Error(`Rendering cancelled before canvas paint for page ${pageNumber}`));
                    return;
                }

                /**
                 * Cancel a same-page task before starting its replacement.
                 *
                 * Rapid paged navigation can request page 928 several times in
                 * quick succession (row render, buffer render, fit-height
                 * rerender). Starting a new PDF.js render before cancelling the
                 * old one leaves two render pipelines competing for the same
                 * page proxy; on large files that can strand the newer task and
                 * leave the page skeleton visible until a long stall timeout.
                 */
                if (activeRenderTasks.has(pageNumber)) {
                    logPdfRenderTrace('renderer-canvas-render-cancel-existing-task', {
                        pageNumber,
                        version,
                        requestId,
                    });
                    cancelActiveRenderTask(pageNumber);
                }
                logPdfRenderTrace('renderer-canvas-render-start', {
                    pageNumber,
                    version,
                    requestId,
                    activeTasks: Array.from(activeRenderTasks.keys()),
                });
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
                activeRenderTasks.set(pageNumber, {
                    version,
                    requestId,
                    task: renderTask,
                });

                renderTask.promise.then(
                    () => {
                        logPdfRenderTrace('renderer-canvas-render-resolve', {
                            pageNumber,
                            version,
                            requestId,
                        });
                        resolve(preparedRenderResult);
                    },
                    (error) => {
                        logPdfRenderTrace('renderer-canvas-render-reject', {
                            pageNumber,
                            version,
                            requestId,
                            errorName: error instanceof Error ? error.name : null,
                            errorMessage: error instanceof Error ? error.message : String(error),
                        });
                        reject(error);
                    },
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
