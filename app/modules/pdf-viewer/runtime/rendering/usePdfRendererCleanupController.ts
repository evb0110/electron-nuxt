import type { Ref } from 'vue';
import type { usePdfAnnotationLayerRenderer } from '@app/modules/pdf-viewer/runtime/rendering/usePdfAnnotationLayerRenderer';
import type { usePdfCanvasRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfCanvasRenderer';
import type { usePdfTextLayerRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer';
import { BrowserLogger } from '@app/utils/browserLogger';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { clearPdfSelectionForLayerTeardown } from '@app/modules/pdf-viewer/engine/pdf-selection-cleanup/clearPdfSelectionForLayerTeardown';
import { pdfViewerDomClasses } from '@app/modules/pdf-viewer/dom/pdf-viewer-dom/pdfViewerDomClasses';

interface IUsePdfRendererCleanupControllerOptions {
    container: Ref<HTMLElement | null>;
    currentPage: Ref<number>;
    renderedPages: Set<number>;
    staleRenderedPages: Set<number>;
    renderingPages: Map<number, number>;
    renderingPageRequestIds: Map<number, number>;
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
    onRenderedPageStateChanged?: (() => void) | undefined;
    invalidatePendingSearchRequests: () => void;
}

export function usePdfRendererCleanupController(options: IUsePdfRendererCleanupControllerOptions) {
    const {
        container: containerRef,
        currentPage,
        renderedPages,
        staleRenderedPages,
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

    function cleanupPage(pageNumber: number) {
        logPdfRenderTrace('renderer-cleanup-page-begin', {
            pageNumber,
            renderVersion: getRenderVersion(),
            page: summarizePageDom(pageNumber),
        });
        const containerRoot = containerRef.value;
        const container = getMountedPageContainer(pageNumber, containerRoot);
        clearPdfSelectionForLayerTeardown({
            target: container,
            root: containerRoot,
            includeDetached: true,
            includeAnyPdfTextSelection: pageNumber === currentPage.value,
        });
        cancelActiveRenderTask(pageNumber);
        cancelActiveTextLayerRender(pageNumber);

        cleanupTextLayer(pageNumber);

        let didChangeRenderedState = false;

        const canvas = pageCanvases.get(pageNumber);
        if (canvas) {
            canvasRenderer.cleanupCanvas(canvas);
            pageCanvases.delete(pageNumber);
            didChangeRenderedState = true;
        }

        didChangeRenderedState = renderedPages.delete(pageNumber) || didChangeRenderedState;
        didChangeRenderedState = staleRenderedPages.delete(pageNumber) || didChangeRenderedState;
        didChangeRenderedState = renderingPages.delete(pageNumber) || didChangeRenderedState;
        renderingPageRequestIds.delete(pageNumber);

        annotationLayerRenderer.cleanupEditorLayer(pageNumber);

        if (containerRoot) {
            container?.classList.remove(pdfViewerDomClasses.renderedPageContainer);
            const skeleton =
                container?.querySelector<HTMLElement>('.pdf-page-skeleton');
            const canvasHost =
                container?.querySelector<HTMLDivElement>('.page_canvas');
            const textLayerDiv =
                container?.querySelector<HTMLDivElement>('.text-layer');
            const annotationLayerDiv =
                container?.querySelector<HTMLElement>('.annotation-layer');
            const annotationEditorLayerDiv = container?.querySelector<HTMLElement>(
                '.annotation-editor-layer',
            );

            if (canvasHost) {
                canvasHost.innerHTML = '';
            }

            if (skeleton) {
                skeleton.style.display = '';
            }

            if (textLayerDiv) {
                textLayerRenderer.cleanupTextLayerDom(textLayerDiv);
            }

            if (annotationLayerDiv) {
                annotationLayerDiv.innerHTML = '';
            }

            if (annotationEditorLayerDiv) {
                annotationEditorLayerDiv.innerHTML = '';
            }

            if (container) {
                textLayerRenderer.clearOcrDebug(container);
            }
        }

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
    ) {
        if (renderingPages.get(pageNumber) !== version) {
            return;
        }
        if (
            requestId !== undefined
            && renderingPageRequestIds.get(pageNumber) !== requestId
        ) {
            return;
        }

        if (staleRenderedPages.has(pageNumber)) {
            renderingPages.delete(pageNumber);
            renderingPageRequestIds.delete(pageNumber);
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
        renderedPages.clear();
        staleRenderedPages.clear();
        renderingPages.clear();
        renderingPageRequestIds.clear();
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
        cleanupPage,
        cleanupPageIfCurrentRender,
        cleanupAllPages,
    };
}
