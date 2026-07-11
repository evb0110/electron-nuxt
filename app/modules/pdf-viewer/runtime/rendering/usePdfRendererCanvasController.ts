import type {
    IActivePdfRenderTask,
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
import { runCoordinatedPdfPageRender } from '@app/modules/pdf-viewer/engine/pdf-page-render-coordinator/coordinatedPdfPageRender';
import type { IPdfRenderSupervisor } from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';
import type { IPdfDocumentPageLease } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfDocument';
import type { IWorkspaceSurfaceLease } from '@app/utils/document-viewer/workspaceSurfaceBudget';

interface IUsePdfRendererCanvasControllerOptions {
    canvasRenderer: ReturnType<typeof usePdfCanvasRenderer>;
    activeRenderTasks: Map<number, IActivePdfRenderTask>;
    pageCanvases: Map<number, HTMLCanvasElement>;
    hiddenAnnotationIds: (pageNumber: number) => Set<string> | undefined;
    sourceMaxPixels?: ((pageNumber: number) => number | null | undefined) | undefined;
    getRenderVersion: () => number;
    getPage: (pageNumber: number) => Promise<IPdfDocumentPageLease>;
    cancelActiveRenderTask: (pageNumber: number) => void;
    cancelActiveRenderTaskIfCurrent: (pageNumber: number, version: number, requestId: number) => void;
    reservePageCanvasSurface?: ((
        pageNumber: number,
        canvas: HTMLCanvasElement,
        annotationCanvases?: Iterable<HTMLCanvasElement>,
    ) => IWorkspaceSurfaceLease) | undefined;
    replacePageCanvasSurfaceLease?: ((pageNumber: number, lease: IWorkspaceSurfaceLease) => void) | undefined;
    onRenderStall?: ((payload: IPageRenderStallPayload) => void) | undefined;
    renderSupervisor?: IPdfRenderSupervisor | undefined;
}

export const usePdfRendererCanvasController = (options: IUsePdfRendererCanvasControllerOptions) => {
    const {
        canvasRenderer,
        activeRenderTasks,
        pageCanvases,
        hiddenAnnotationIds,
        sourceMaxPixels,
        getRenderVersion,
        getPage,
        cancelActiveRenderTask,
        cancelActiveRenderTaskIfCurrent,
        reservePageCanvasSurface = () => ({
            bytes: 0,
            category: 'pdf-page-canvas',
            scopeId: 'untracked',
            release() {},
        }),
        replacePageCanvasSurfaceLease = (_pageNumber, lease) => lease.release(),
        onRenderStall,
        renderSupervisor,
    } = options;
    const queuedCanvasRenderAbortControllers = new Set<AbortController>();
    type TPreparedCanvasRender = NonNullable<Awaited<ReturnType<typeof canvasRenderer.prepareCanvasRender>>> & {continuationPriority?: NonNullable<IRenderVisiblePagesOptions['continuationPriority']>;};

    function abortQueuedCanvasRenders() {
        for (const controller of queuedCanvasRenderAbortControllers) {
            controller.abort();
        }
        queuedCanvasRenderAbortControllers.clear();
    }

    function releasePageResources(
        pageNumber: number,
        pageLease: IPdfDocumentPageLease,
    ) {
        try {
            logPdfRenderTrace('renderer-page-cleanup-begin', {
                pageNumber,
                renderVersion: getRenderVersion(),
            });
            pageLease.release();
            logPdfRenderTrace('renderer-page-cleanup-end', {
                pageNumber,
                renderVersion: getRenderVersion(),
            });
        } catch (error) {
            logPdfRenderTrace('renderer-page-cleanup-error', {
                pageNumber,
                renderVersion: getRenderVersion(),
                errorName: error instanceof Error ? error.name : null,
                errorMessage: error instanceof Error ? error.message : String(error),
            });
            BrowserLogger.warn(
                'pdf-renderer',
                `Failed to release PDF page resources for page ${pageNumber}`,
                error,
            );
        }
    }

    async function renderPreparedCanvasResult(
        pdfPage: PDFPageProxy,
        pageNumber: number,
        version: number,
        requestId: number,
        preparedCanvasRender: TPreparedCanvasRender,
        shouldContinue: () => boolean,
    ) {
        const {
            startRender,
            continuationPriority = 'visible',
            ...preparedRenderResult
        } = preparedCanvasRender;
        let renderStageTimedOut = false;
        const renderAbortController = new AbortController();
        queuedCanvasRenderAbortControllers.add(renderAbortController);

        return withPageStageTimeout(
            new Promise<typeof preparedRenderResult>((resolve, reject) => {
                if (getRenderVersion() !== version || !shouldContinue()) {
                    renderAbortController.abort();
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
                runCoordinatedPdfPageRender({
                    owner: 'viewer',
                    pageNumber,
                    pdfPage,
                    priority: 100,
                    continuation: {
                        key: `viewer:${pageNumber}:${version}:${requestId}`,
                        priority: continuationPriority,
                    },
                    signal: renderAbortController.signal,
                    shouldStart: () => !renderStageTimedOut && getRenderVersion() === version && shouldContinue(),
                    startRender: () => {
                        logPdfRenderTrace('renderer-canvas-render-start', {
                            pageNumber,
                            version,
                            requestId,
                            activeTasks: Array.from(activeRenderTasks.keys()),
                        });
                        return startRender();
                    },
                    onTask: (renderTask) => {
                        if (getRenderVersion() !== version || !shouldContinue()) {
                            try {
                                renderTask.cancel();
                            } catch {
                                // Ignore cancellation failures.
                            }
                            return;
                        }
                        activeRenderTasks.set(pageNumber, {
                            version,
                            requestId,
                            task: renderTask,
                        });
                    },
                }).then(
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
                renderStageTimedOut = true;
                renderAbortController.abort();
                cancelActiveRenderTaskIfCurrent(pageNumber, version, requestId);
            },
            onRenderStall,
            renderSupervisor,
        ).finally(() => {
            queuedCanvasRenderAbortControllers.delete(renderAbortController);
        });
    }

    async function loadPageForRender(
        pageNumber: number,
        version: number,
        shouldContinue: () => boolean,
    ) {
        let pageLoadTimedOut = false;
        const pagePromise = getPage(pageNumber);
        void pagePromise.then((pageLease) => {
            if (pageLoadTimedOut) {
                releasePageResources(pageNumber, pageLease);
            }
        }, () => {});
        const pageLease = await withPageStageTimeout(
            pagePromise,
            {
                pageNumber,
                stage: 'page-load',
                timeoutMs: PDF_PAGE_LOAD_TIMEOUT_MS,
            },
            () => getRenderVersion() === version && shouldContinue(),
            () => {
                pageLoadTimedOut = true;
            },
            onRenderStall,
            renderSupervisor,
        );
        if (getRenderVersion() === version && shouldContinue()) {
            return pageLease;
        }
        releasePageResources(pageNumber, pageLease);
        return null;
    }

    async function prepareCanvasRenderForPage(
        pdfPage: PDFPageProxy,
        pageNumber: number,
        version: number,
        requestId: number,
        scale: number,
        shouldContinue: () => boolean,
        renderOptions?: IRenderVisiblePagesOptions,
    ) {
        const canvasRenderOptions: Parameters<typeof canvasRenderer.prepareCanvasRender>[2] = {};
        const prepareAbortController = new AbortController();
        const shouldContinuePrepare = () => (
            getRenderVersion() === version
            && shouldContinue()
            && !prepareAbortController.signal.aborted
        );
        canvasRenderOptions.pageRenderCoordination = {
            owner: 'viewer',
            priority: 100,
            signal: prepareAbortController.signal,
            shouldStart: shouldContinuePrepare,
            shouldContinue: shouldContinuePrepare,
        };
        const ids = hiddenAnnotationIds(pageNumber);
        if (ids !== undefined) {
            canvasRenderOptions.hiddenAnnotationIds = ids;
        }
        logPdfRenderTrace('renderer-canvas-hidden-annotations', {
            pageNumber,
            version,
            requestId,
            hiddenAnnotationCount: ids?.size ?? 0,
            hiddenAnnotationIds: ids ? Array.from(ids).slice(0, 30) : [],
        });
        if (renderOptions?.maxCanvasPixelsOverride !== undefined) {
            canvasRenderOptions.maxCanvasPixels = renderOptions.maxCanvasPixelsOverride;
        }
        const sourceMaxPixelBudget = sourceMaxPixels?.(pageNumber);
        if (sourceMaxPixelBudget !== null && sourceMaxPixelBudget !== undefined) {
            canvasRenderOptions.sourceMaxPixels = sourceMaxPixelBudget;
        }
        let prepareStageTimedOut = false;
        const prepareCanvasRenderPromise = canvasRenderer.prepareCanvasRender(
            pdfPage,
            scale,
            canvasRenderOptions,
        );
        void prepareCanvasRenderPromise.then((preparedCanvasRender) => {
            if (prepareStageTimedOut && preparedCanvasRender) {
                canvasRenderer.cleanupCanvasRenderResult?.(preparedCanvasRender);
            }
        }, () => {});
        const preparedCanvasRender = await withPageStageTimeout(
            prepareCanvasRenderPromise,
            {
                pageNumber,
                stage: 'canvas-prepare',
                timeoutMs: PDF_PAGE_RENDER_TIMEOUT_MS,
            },
            () => getRenderVersion() === version && shouldContinue(),
            () => {
                prepareStageTimedOut = true;
                prepareAbortController.abort();
            },
            onRenderStall,
            renderSupervisor,
        );
        if (!preparedCanvasRender) {
            return null;
        }

        if (getRenderVersion() !== version || !shouldContinue()) {
            canvasRenderer.cleanupCanvasRenderResult(preparedCanvasRender);
            return null;
        }

        return {
            ...preparedCanvasRender,
            continuationPriority: renderOptions?.continuationPriority ?? 'visible',
        } satisfies TPreparedCanvasRender;
    }

    async function renderPreparedCanvasForPage(
        pdfPage: PDFPageProxy,
        pageNumber: number,
        version: number,
        requestId: number,
        preparedCanvasRender: TPreparedCanvasRender,
        shouldContinue: () => boolean,
    ) {
        try {
            const renderResult = await renderPreparedCanvasResult(
                pdfPage,
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

    async function prepareCanvasForRender(
        pdfPage: PDFPageProxy,
        pageNumber: number,
        version: number,
        requestId: number,
        scale: number,
        shouldContinue: () => boolean,
        renderOptions?: IRenderVisiblePagesOptions,
    ) {
        const preparedCanvasRender = await prepareCanvasRenderForPage(
            pdfPage,
            pageNumber,
            version,
            requestId,
            scale,
            shouldContinue,
            renderOptions,
        );
        if (!preparedCanvasRender) {
            return null;
        }

        return renderPreparedCanvasForPage(
            pdfPage,
            pageNumber,
            version,
            requestId,
            preparedCanvasRender,
            shouldContinue,
        );
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
        const surfaceLease = reservePageCanvasSurface(
            pageNumber,
            canvas,
            renderResult.annotationCanvasMap?.values() ?? [],
        );
        try {
            canvasRenderer.mountCanvas(
                canvasHost,
                canvas,
                previousCanvas,
            );
            if (previousCanvas && previousCanvas !== canvas) {
                canvasRenderer.cleanupCanvas(previousCanvas);
            }
            pageCanvases.set(pageNumber, canvas);
            replacePageCanvasSurfaceLease(pageNumber, surfaceLease);
        } catch (error) {
            surfaceLease.release();
            throw error;
        }
    }

    return {
        abortQueuedCanvasRenders,
        releasePageResources,
        renderPreparedCanvasResult,
        loadPageForRender,
        prepareCanvasRenderForPage,
        renderPreparedCanvasForPage,
        prepareCanvasForRender,
        mountRenderedCanvas,
    };
};
