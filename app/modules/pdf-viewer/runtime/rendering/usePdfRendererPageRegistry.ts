import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

interface ICancelableRenderTask {
    cancel: () => void;
    promise: Promise<unknown>;
}

export function usePdfRendererPageRegistry() {
    const renderedPages = new Set<number>();
    const staleRenderedPages = new Set<number>();
    const renderingPages = new Map<number, number>();
    const renderingPageRequestIds = new Map<number, number>();
    const missingRenderTargetRetries = new Map<number, number>();
    const activeRenderTasks = new Map<number, {
        version: number;
        requestId: number;
        task: ICancelableRenderTask;
    }>();
    const pageCanvases = new Map<number, HTMLCanvasElement>();
    const textLayerCleanupFns = new Map<number, () => void>();
    const activeTextLayerAbortControllers = new Map<number, {
        version: number;
        requestId: number;
        controller: AbortController;
    }>();

    function cancelActiveRenderTask(pageNumber: number) {
        const activeRenderTask = activeRenderTasks.get(pageNumber);
        if (!activeRenderTask) {
            return;
        }
        activeRenderTasks.delete(pageNumber);
        try {
            activeRenderTask.task.cancel();
        } catch {
            // Ignore cancellation failures.
        }
    }

    function cancelActiveRenderTaskIfCurrent(
        pageNumber: number,
        version: number,
        requestId: number,
    ) {
        const activeRenderTask = activeRenderTasks.get(pageNumber);
        if (
            !activeRenderTask
            || activeRenderTask.version !== version
            || activeRenderTask.requestId !== requestId
        ) {
            return;
        }
        cancelActiveRenderTask(pageNumber);
    }

    function cancelAllActiveRenderTasks() {
        for (const pageNumber of Array.from(activeRenderTasks.keys())) {
            cancelActiveRenderTask(pageNumber);
        }
    }

    function cancelActiveTextLayerRender(pageNumber: number) {
        const activeTextLayer = activeTextLayerAbortControllers.get(pageNumber);
        if (!activeTextLayer) {
            return;
        }
        activeTextLayerAbortControllers.delete(pageNumber);
        activeTextLayer.controller.abort();
    }

    function cancelActiveTextLayerRenderIfCurrent(
        pageNumber: number,
        version: number,
        requestId: number,
    ) {
        const activeTextLayer = activeTextLayerAbortControllers.get(pageNumber);
        if (
            !activeTextLayer
            || activeTextLayer.version !== version
            || activeTextLayer.requestId !== requestId
        ) {
            return;
        }
        cancelActiveTextLayerRender(pageNumber);
    }

    function cancelAllActiveTextLayerRenders() {
        for (const pageNumber of Array.from(activeTextLayerAbortControllers.keys())) {
            cancelActiveTextLayerRender(pageNumber);
        }
    }

    function cancelObsoleteInFlightRenders(
        pagesToKeepRendering: Set<number>,
        requestId: number,
        cleanupCancelledPage?: (pageNumber: number, version: number, requestId?: number) => void,
    ) {
        const cancelledPages: number[] = [];

        for (const pageNumber of Array.from(renderingPages.keys())) {
            if (pagesToKeepRendering.has(pageNumber)) {
                continue;
            }

            const renderingVersion = renderingPages.get(pageNumber);
            const renderingRequestId = renderingPageRequestIds.get(pageNumber);
            cancelActiveRenderTask(pageNumber);
            cancelActiveTextLayerRender(pageNumber);
            if (typeof renderingVersion === 'number') {
                cleanupCancelledPage?.(pageNumber, renderingVersion, renderingRequestId);
            }
            if (renderingPages.get(pageNumber) === renderingVersion) {
                renderingPages.delete(pageNumber);
                renderingPageRequestIds.delete(pageNumber);
            }
            missingRenderTargetRetries.delete(pageNumber);
            cancelledPages.push(pageNumber);
        }

        for (const pageNumber of Array.from(missingRenderTargetRetries.keys())) {
            if (!pagesToKeepRendering.has(pageNumber)) {
                missingRenderTargetRetries.delete(pageNumber);
            }
        }

        if (cancelledPages.length > 0) {
            logPdfRenderTrace('renderer-visible-render-cancel-obsolete', {
                requestId,
                pagesToKeepRendering: Array.from(pagesToKeepRendering),
                cancelledPages,
            });
        }
    }

    function getTrackedPageNumbersForCleanup() {
        const pagesToCleanup = new Set<number>();
        renderedPages.forEach((page) => pagesToCleanup.add(page));
        renderingPages.forEach((_, page) => pagesToCleanup.add(page));
        pageCanvases.forEach((_, page) => pagesToCleanup.add(page));
        textLayerCleanupFns.forEach((_, page) => pagesToCleanup.add(page));
        return pagesToCleanup;
    }

    return {
        renderedPages,
        staleRenderedPages,
        renderingPages,
        renderingPageRequestIds,
        missingRenderTargetRetries,
        activeRenderTasks,
        pageCanvases,
        textLayerCleanupFns,
        activeTextLayerAbortControllers,
        cancelActiveRenderTask,
        cancelActiveRenderTaskIfCurrent,
        cancelAllActiveRenderTasks,
        cancelActiveTextLayerRender,
        cancelActiveTextLayerRenderIfCurrent,
        cancelAllActiveTextLayerRenders,
        cancelObsoleteInFlightRenders,
        getTrackedPageNumbersForCleanup,
    };
}
