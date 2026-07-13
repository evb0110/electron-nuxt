import type {
    IActivePdfRenderTask,
    IActivePdfTextLayerTask,
    TPdfTextLayerCleanup,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { createPdfPageRenderState } from '@app/modules/pdf-viewer/runtime/rendering/pdfPageRenderState';
import {
    estimateCanvasSurfaceBytes,
    workspaceSurfaceBudgetController,
    type IWorkspaceSurfaceLease,
} from '@app/utils/document-viewer/workspaceSurfaceBudget';

let nextPdfViewerSurfaceScopeId = 1;

interface IUsePdfRendererPageRegistryOptions {
    isPageProtected?: (pageNumber: number) => boolean;
    onPageEvicted?: (pageNumber: number) => void;
}

export const usePdfRendererPageRegistry = (options: IUsePdfRendererPageRegistryOptions = {}) => {
    const pageRenderState = createPdfPageRenderState();
    const {
        renderedPages,
        renderingPages,
        renderingPageRequestIds,
    } = pageRenderState;
    const missingRenderTargetRetries = new Map<number, number>();
    const activeRenderTasks = new Map<number, IActivePdfRenderTask>();
    const pageCanvases = new Map<number, HTMLCanvasElement>();
    const pageCanvasSurfaceLeases = new Map<number, IWorkspaceSurfaceLease>();
    const surfaceScopeId = `pdf-viewer:${nextPdfViewerSurfaceScopeId}`;
    nextPdfViewerSurfaceScopeId += 1;
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

    function reservePageCanvasSurface(
        pageNumber: number,
        canvas: HTMLCanvasElement,
        annotationCanvases: Iterable<HTMLCanvasElement> = [],
    ): IWorkspaceSurfaceLease {
        const canvases = [
            canvas,
            ...annotationCanvases,
        ];
        const leases: IWorkspaceSurfaceLease[] = [];
        let committed = false;
        let released = false;

        const evict = () => {
            for (const reservedCanvas of canvases) {
                reservedCanvas.width = 0;
                reservedCanvas.height = 0;
            }
            if (pageCanvases.get(pageNumber) === canvas) {
                pageCanvases.delete(pageNumber);
                renderedPages.delete(pageNumber);
            }
            if (pageCanvasSurfaceLeases.get(pageNumber) === compositeLease) {
                pageCanvasSurfaceLeases.delete(pageNumber);
            }
            compositeLease.release();
            options.onPageEvicted?.(pageNumber);
        };
        const canEvict = () => committed
            && pageCanvases.get(pageNumber) === canvas
            && options.isPageProtected?.(pageNumber) !== true;
        leases.push(workspaceSurfaceBudgetController.reserve({
            scopeId: surfaceScopeId,
            category: 'pdf-page-canvas',
            bytes: estimateCanvasSurfaceBytes(canvas),
            priority: 50,
            canEvict,
            evict,
        }));
        for (const annotationCanvas of canvases.slice(1)) {
            leases.push(workspaceSurfaceBudgetController.reserve({
                scopeId: surfaceScopeId,
                category: 'pdf-annotation-canvas',
                bytes: estimateCanvasSurfaceBytes(annotationCanvas),
                priority: 50,
                canEvict,
                evict,
            }));
        }
        const compositeLease: IWorkspaceSurfaceLease = {
            bytes: leases.reduce((total, lease) => total + lease.bytes, 0),
            category: 'pdf-page-canvas',
            scopeId: surfaceScopeId,
            promotePriority(priority) {
                leases.forEach(lease => lease.promotePriority?.(priority));
            },
            setPriority(priority) {
                leases.forEach(lease => lease.setPriority?.(priority));
            },
            release() {
                if (released) {
                    return;
                }
                released = true;
                leases.forEach(lease => lease.release());
            },
        };
        pendingSurfaceLeaseCommits.set(compositeLease, () => {
            committed = true;
        });
        return compositeLease;
    }

    const pendingSurfaceLeaseCommits = new WeakMap<IWorkspaceSurfaceLease, () => void>();

    function replacePageCanvasSurfaceLease(pageNumber: number, lease: IWorkspaceSurfaceLease) {
        const previousLease = pageCanvasSurfaceLeases.get(pageNumber);
        pageCanvasSurfaceLeases.set(pageNumber, lease);
        previousLease?.release();
    }

    function markPageCanvasSurfaceEvictable(pageNumber: number) {
        const lease = pageCanvasSurfaceLeases.get(pageNumber);
        if (!lease) {
            return;
        }
        pendingSurfaceLeaseCommits.get(lease)?.();
        pendingSurfaceLeaseCommits.delete(lease);
        workspaceSurfaceBudgetController.enforceBudget();
    }

    function releasePageCanvasSurface(pageNumber: number) {
        pageCanvasSurfaceLeases.get(pageNumber)?.release();
        pageCanvasSurfaceLeases.delete(pageNumber);
    }

    function setPageCanvasSurfacePriority(pageNumber: number, priority: number) {
        pageCanvasSurfaceLeases.get(pageNumber)?.setPriority?.(priority);
    }

    function releaseAllSurfaceResources() {
        workspaceSurfaceBudgetController.releaseScope(surfaceScopeId);
        pageCanvasSurfaceLeases.clear();
    }

    return {
        pageRenderState,
        renderedPages,
        renderingPages,
        renderingPageRequestIds,
        missingRenderTargetRetries,
        activeRenderTasks,
        pageCanvases,
        reservePageCanvasSurface,
        replacePageCanvasSurfaceLease,
        markPageCanvasSurfaceEvictable,
        releasePageCanvasSurface,
        setPageCanvasSurfacePriority,
        releaseAllSurfaceResources,
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
        cancelObsoleteInFlightRenders,
        getTrackedPageNumbersForCleanup,
    };
};
