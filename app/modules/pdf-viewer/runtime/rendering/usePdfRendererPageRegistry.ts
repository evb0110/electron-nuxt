import type {
    IActivePdfRenderTask,
    IActivePdfTextLayerTask,
    TPdfTextLayerCleanup,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import { createPdfPageRenderState } from '@app/modules/pdf-viewer/runtime/rendering/pdfPageRenderState';

export const usePdfRendererPageRegistry = () => {
    const pageRenderState = createPdfPageRenderState();
    const {
        renderedPages,
        renderingPages,
        renderingPageRequestIds,
    } = pageRenderState;
    const missingRenderTargetRetries = new Map<number, number>();
    const activeRenderTasks = new Map<number, IActivePdfRenderTask>();
    const pageCanvases = new Map<number, HTMLCanvasElement>();
    const textLayerCleanupFns = new Map<number, TPdfTextLayerCleanup>();
    const activeTextLayerAbortControllers = new Map<number, IActivePdfTextLayerTask>();
    const activeOptionalTextLayerTasks = new Map<number, {
        version: number;
        requestId: number;
        promise: Promise<void>;
    }>();

    function trackOptionalTextLayerTask(
        pageNumber: number,
        version: number,
        requestId: number,
        task: Promise<unknown>,
    ) {
        const promise = task
            .catch(() => undefined)
            .then(() => undefined)
            .finally(() => {
                const current = activeOptionalTextLayerTasks.get(pageNumber);
                if (current?.version === version && current.requestId === requestId) {
                    activeOptionalTextLayerTasks.delete(pageNumber);
                }
            });
        activeOptionalTextLayerTasks.set(pageNumber, {
            version,
            requestId,
            promise,
        });
        return promise;
    }

    function waitForOptionalTextLayerTasksToSettle() {
        return Promise.all(Array.from(
            activeOptionalTextLayerTasks.values(),
            task => task.promise,
        )).then(() => undefined);
    }

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

    function waitForActiveRenderTasksToSettle() {
        const activeTaskPromises = Array.from(
            activeRenderTasks.values(),
            activeRenderTask => activeRenderTask.task.promise.catch(() => undefined),
        );
        return Promise.all(activeTaskPromises).then(() => undefined);
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

    function getTrackedPageNumbersForCleanup() {
        const pagesToCleanup = new Set<number>();
        renderedPages.forEach((page) => pagesToCleanup.add(page));
        renderingPages.forEach((_, page) => pagesToCleanup.add(page));
        pageCanvases.forEach((_, page) => pagesToCleanup.add(page));
        textLayerCleanupFns.forEach((_, page) => pagesToCleanup.add(page));
        return pagesToCleanup;
    }

    return {
        pageRenderState,
        renderedPages,
        renderingPages,
        renderingPageRequestIds,
        missingRenderTargetRetries,
        activeRenderTasks,
        pageCanvases,
        textLayerCleanupFns,
        activeTextLayerAbortControllers,
        activeOptionalTextLayerTasks,
        trackOptionalTextLayerTask,
        waitForOptionalTextLayerTasksToSettle,
        cancelActiveRenderTask,
        cancelActiveRenderTaskIfCurrent,
        cancelAllActiveRenderTasks,
        waitForActiveRenderTasksToSettle,
        cancelActiveTextLayerRender,
        cancelActiveTextLayerRenderIfCurrent,
        cancelAllActiveTextLayerRenders,
        getTrackedPageNumbersForCleanup,
    };
};
