import type { Ref } from 'vue';
import type { usePdfAnnotationLayerRenderer } from '@app/modules/pdf-viewer/runtime/rendering/usePdfAnnotationLayerRenderer';
import type { usePdfCanvasRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfCanvasRenderer';
import type { usePdfTextLayerRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer';
import { BrowserLogger } from '@app/utils/browserLogger';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { clearPdfSelectionForLayerTeardown } from '@app/modules/pdf-viewer/engine/pdf-selection-cleanup/clearPdfSelectionForLayerTeardown';
import type {
    IPdfPageNumberStateMap,
    IPdfPageNumberStateSet,
    TPdfPageRenderState,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfPageRenderState';

interface IUsePdfRendererCleanupControllerOptions {
    container: Ref<HTMLElement | null>;
    currentPage: Ref<number>;
    pageRenderState: TPdfPageRenderState;
    renderedPages: IPdfPageNumberStateSet;
    renderingPages: IPdfPageNumberStateMap;
    renderingPageRequestIds: IPdfPageNumberStateMap;
    missingRenderTargetRetries: Map<number, number>;
    pageCanvases: Map<number, HTMLCanvasElement>;
    textLayerCleanupFns: Map<number, () => void>;
    canvasRenderer: ReturnType<typeof usePdfCanvasRenderer>;
    textLayerRenderer: ReturnType<typeof usePdfTextLayerRenderer>;
    annotationLayerRenderer: ReturnType<typeof usePdfAnnotationLayerRenderer>;
    getRenderVersion: () => number;
    bumpRenderVersion: (reason: string, payload?: Record<string, unknown>) => number;
    getMountedPageContainer: (pageNumber: number, containerRoot?: HTMLElement | null) => HTMLElement | null;
    summarizePageDom: (pageNumber: number) => Record<string, unknown>;
    cancelActiveRenderTask: (pageNumber: number) => void;
    cancelActiveTextLayerRender: (pageNumber: number) => void;
    getTrackedPageNumbersForCleanup: () => Set<number>;
    evictPage: (pageNumber: number) => void;
    cleanupPageCache: () => void;
    releasePageCanvasSurface: (pageNumber: number) => void;
    releaseAllSurfaceResources: () => void;
    onRenderedPageStateChanged?: (() => void) | undefined;
    invalidatePendingSearchRequests: () => void;
}

export const usePdfRendererCleanupController = (options: IUsePdfRendererCleanupControllerOptions) => {
    const {
        container: containerRef,
        currentPage,
        pageRenderState,
        renderedPages,
        renderingPages,
        renderingPageRequestIds,
        missingRenderTargetRetries,
        pageCanvases,
        textLayerCleanupFns,
        canvasRenderer,
        textLayerRenderer,
        annotationLayerRenderer,
        getRenderVersion,
        bumpRenderVersion,
        getMountedPageContainer,
        summarizePageDom,
        cancelActiveRenderTask,
        cancelActiveTextLayerRender,
        getTrackedPageNumbersForCleanup,
        evictPage,
        cleanupPageCache,
        releasePageCanvasSurface,
        releaseAllSurfaceResources,
        onRenderedPageStateChanged,
        invalidatePendingSearchRequests,
    } = options;

    function cleanupTextLayer(pageNumber: number) {
        const cleanup = textLayerCleanupFns.get(pageNumber);
        if (cleanup) {
            cleanup();
            textLayerCleanupFns.delete(pageNumber);
        }
    }

    function clearPageVisual(pageNumber: number, notify = true) {
        const containerRoot = containerRef.value;
        const container = getMountedPageContainer(pageNumber, containerRoot);
        clearPdfSelectionForLayerTeardown({
            target: container,
            root: containerRoot,
            includeDetached: true,
            includeAnyPdfTextSelection: pageNumber === currentPage.value,
        });
        cleanupTextLayer(pageNumber);

        let didChangeRenderedState = false;
        const canvas = pageCanvases.get(pageNumber);
        if (canvas) {
            canvasRenderer.cleanupCanvas(canvas);
            pageCanvases.delete(pageNumber);
            didChangeRenderedState = true;
        }
        releasePageCanvasSurface(pageNumber);
        didChangeRenderedState = renderedPages.delete(pageNumber) || didChangeRenderedState;

        annotationLayerRenderer.cleanupEditorLayer(pageNumber);
        if (containerRoot) {
            const skeleton = container?.querySelector<HTMLElement>('.document-page-skeleton');
            const canvasHost = container?.querySelector<HTMLDivElement>('.page_canvas__render-layer');
            const textLayerDiv = container?.querySelector<HTMLDivElement>('.text-layer');
            const annotationLayerDiv = container?.querySelector<HTMLElement>('.annotation-layer');
            const annotationEditorLayerDiv = container?.querySelector<HTMLElement>('.annotation-editor-layer');

            if (canvasHost) {
                zeroCanvasDescendants(canvasHost);
                canvasHost.replaceChildren();
            }
            if (skeleton) {
                skeleton.style.display = '';
            }
            if (textLayerDiv) {
                textLayerRenderer.cleanupTextLayerDom(textLayerDiv);
            }
            if (annotationLayerDiv) {
                zeroCanvasDescendants(annotationLayerDiv);
                annotationLayerDiv.replaceChildren();
            }
            if (annotationEditorLayerDiv) {
                zeroCanvasDescendants(annotationEditorLayerDiv);
                annotationEditorLayerDiv.replaceChildren();
            }
            if (container) {
                textLayerRenderer.clearOcrDebug(container);
            }
        }

        if (notify && didChangeRenderedState) {
            onRenderedPageStateChanged?.();
        }
        return didChangeRenderedState;
    }

    function cleanupPage(pageNumber: number) {
        logPdfRenderTrace('renderer-cleanup-page-begin', {
            pageNumber,
            renderVersion: getRenderVersion(),
            page: summarizePageDom(pageNumber),
        });
        cancelActiveRenderTask(pageNumber);
        cancelActiveTextLayerRender(pageNumber);
        let didChangeRenderedState = clearPageVisual(pageNumber, false);
        didChangeRenderedState = renderingPages.delete(pageNumber) || didChangeRenderedState;
        renderingPageRequestIds.delete(pageNumber);

        try {
            evictPage(pageNumber);
        } catch (error) {
            BrowserLogger.error(
                'pdf-renderer',
                'Failed to evict cached PDF page',
                error,
            );
        }

        if (didChangeRenderedState) {
            onRenderedPageStateChanged?.();
        }
        logPdfRenderTrace('renderer-cleanup-page-end', {
            pageNumber,
            renderVersion: getRenderVersion(),
            didChangeRenderedState,
            page: summarizePageDom(pageNumber),
        });
    }

    function cleanupPageIfCurrentRender(
        pageNumber: number,
        version: number,
        requestId?: number,
        cleanupOptions?: {terminalFailure?: boolean},
    ) {
        const slot = pageRenderState.getSlot(pageNumber);
        const isCurrentTerminalFailure = cleanupOptions?.terminalFailure === true
            && slot.job === 'failed'
            && slot.version === version
            && (requestId === undefined || slot.requestId === requestId);
        if (!isCurrentTerminalFailure && renderingPages.get(pageNumber) !== version) {
            return;
        }
        if (
            !isCurrentTerminalFailure
            &&
            requestId !== undefined
            && renderingPageRequestIds.get(pageNumber) !== requestId
        ) {
            return;
        }

        cleanupPage(pageNumber);
    }

    function cleanupAllPages() {
        bumpRenderVersion('cleanup-all-pages');

        getTrackedPageNumbersForCleanup().forEach((page) => cleanupPage(page));

        for (const [
            , canvas,
        ] of pageCanvases) {
            canvasRenderer.cleanupCanvas(canvas);
        }

        pageCanvases.clear();
        releaseAllSurfaceResources();
        pageRenderState.clearAll();
        missingRenderTargetRetries.clear();
        textLayerCleanupFns.clear();
        annotationLayerRenderer.clearAllLayers();

        invalidatePendingSearchRequests();

        try {
            cleanupPageCache();
        } catch (error) {
            BrowserLogger.error(
                'pdf-renderer',
                'Failed to clean up PDF page cache',
                error,
            );
        }
    }

    return {
        cleanupTextLayer,
        clearPageVisual,
        cleanupPage,
        cleanupPageIfCurrentRender,
        cleanupAllPages,
    };
};

function zeroCanvasDescendants(root: HTMLElement) {
    if (typeof root.querySelectorAll !== 'function') {
        return;
    }
    for (const canvas of root.querySelectorAll<HTMLCanvasElement>('canvas')) {
        canvas.width = 0;
        canvas.height = 0;
    }
}
