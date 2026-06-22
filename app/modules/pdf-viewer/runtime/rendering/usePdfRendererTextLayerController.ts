import type { PDFPageProxy } from 'pdfjs-dist';
import type { usePdfTextLayerRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer';
import type {
    IActivePdfTextLayerTask,
    TClearSelectionBeforePageLayerTeardown,
    TPdfTextLayerCleanup,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import { PDF_PAGE_TEXT_LAYER_TIMEOUT_MS } from '@app/constants/timeouts';
import { isPageRenderTimeoutError } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/isPageRenderTimeoutError';
import type { IPageRenderStallPayload } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/pdfPageRenderTimeoutTypes';
import { withPageStageTimeout } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/withPageStageTimeout';
import { clearPdfSelectionForLayerTeardown } from '@app/modules/pdf-viewer/engine/pdf-selection-cleanup/clearPdfSelectionForLayerTeardown';

interface ITextLayerRenderContext {
    container: HTMLElement;
    pdfPage: PDFPageProxy;
    renderResult: {
        canvas: HTMLCanvasElement;
        viewport: Parameters<ReturnType<typeof usePdfTextLayerRenderer>['renderTextLayer']>[2];
        scaleX: number;
        scaleY: number;
        rawDims: {
            pageWidth: number;
            pageHeight: number;
        };
        userUnit: number;
        totalScaleFactor: number;
    };
    textLayerDiv: HTMLDivElement | null;
}

interface IUsePdfRendererTextLayerControllerOptions {
    textLayerRenderer: ReturnType<typeof usePdfTextLayerRenderer>;
    activeTextLayerAbortControllers: Map<number, IActivePdfTextLayerTask>;
    textLayerCleanupFns: Map<number, TPdfTextLayerCleanup>;
    getRenderVersion: () => number;
    cleanupTextLayer: (pageNumber: number) => void;
    cleanupPageIfCurrentRender: (pageNumber: number, version: number, requestId?: number) => void;
    cancelActiveTextLayerRender: (pageNumber: number) => void;
    cancelActiveTextLayerRenderIfCurrent: (pageNumber: number, version: number, requestId: number) => void;
    clearSelectionBeforePageLayerTeardown: TClearSelectionBeforePageLayerTeardown;
    logNonCriticalStageError: (pageNumber: number, stage: string, error: unknown) => void;
    onRenderStall?: ((payload: IPageRenderStallPayload) => void) | undefined;
}

export const usePdfRendererTextLayerController = (options: IUsePdfRendererTextLayerControllerOptions) => {
    const {
        textLayerRenderer,
        activeTextLayerAbortControllers,
        textLayerCleanupFns,
        getRenderVersion,
        cleanupTextLayer,
        cleanupPageIfCurrentRender,
        cancelActiveTextLayerRender,
        cancelActiveTextLayerRenderIfCurrent,
        clearSelectionBeforePageLayerTeardown,
        logNonCriticalStageError,
        onRenderStall,
    } = options;

    async function renderTextLayerForPage(
        pageNumber: number,
        version: number,
        requestId: number,
        context: ITextLayerRenderContext,
        scale: number,
        shouldContinue: () => boolean,
    ) {
        const {
            container,
            pdfPage,
            renderResult,
            textLayerDiv,
        } = context;
        if (!textLayerDiv) {
            return true;
        }
        if (getRenderVersion() !== version || !shouldContinue()) {
            cleanupPageIfCurrentRender(pageNumber, version, requestId);
            return false;
        }

        const {
            canvas,
            viewport,
            scaleX,
            scaleY,
            rawDims,
            userUnit,
            totalScaleFactor,
        } = renderResult;

        clearSelectionBeforePageLayerTeardown(pageNumber);
        cleanupTextLayer(pageNumber);
        cancelActiveTextLayerRender(pageNumber);
        let isTextLayerRendered = false;

        try {
            const controller = new AbortController();
            activeTextLayerAbortControllers.set(pageNumber, {
                version,
                requestId,
                controller,
            });
            await withPageStageTimeout(
                textLayerRenderer.renderTextLayer(
                    pdfPage,
                    textLayerDiv,
                    viewport,
                    scale,
                    userUnit,
                    totalScaleFactor,
                    controller.signal,
                ),
                {
                    pageNumber,
                    stage: 'text-layer',
                    timeoutMs: PDF_PAGE_TEXT_LAYER_TIMEOUT_MS,
                },
                () => getRenderVersion() === version && shouldContinue(),
                () => {
                    cancelActiveTextLayerRenderIfCurrent(pageNumber, version, requestId);
                },
                onRenderStall,
            );
            isTextLayerRendered = true;
        } catch (textLayerError) {
            if (isPageRenderTimeoutError(textLayerError)) {
                clearPdfSelectionForLayerTeardown({
                    target: textLayerDiv,
                    root: container,
                });
                textLayerRenderer.cleanupTextLayerDom(textLayerDiv);
                throw textLayerError;
            }
            if (
                getRenderVersion() !== version
                || !shouldContinue()
                || (
                    textLayerError
                    && typeof textLayerError === 'object'
                    && (textLayerError as { name?: unknown }).name === 'AbortError'
                )
            ) {
                clearPdfSelectionForLayerTeardown({
                    target: textLayerDiv,
                    root: container,
                });
                textLayerRenderer.cleanupTextLayerDom(textLayerDiv);
                cleanupPageIfCurrentRender(pageNumber, version, requestId);
                return false;
            }
            logNonCriticalStageError(
                pageNumber,
                'text layer',
                textLayerError,
            );
            clearPdfSelectionForLayerTeardown({
                target: textLayerDiv,
                root: container,
            });
            textLayerRenderer.cleanupTextLayerDom(textLayerDiv);
        } finally {
            const activeTextLayer = activeTextLayerAbortControllers.get(pageNumber);
            if (
                activeTextLayer?.version === version
                && activeTextLayer.requestId === requestId
            ) {
                activeTextLayerAbortControllers.delete(pageNumber);
            }
        }

        if (getRenderVersion() !== version || !shouldContinue()) {
            cleanupPageIfCurrentRender(pageNumber, version, requestId);
            return false;
        }

        if (!isTextLayerRendered) {
            return true;
        }

        try {
            const cleanup =
                textLayerRenderer.setupTextLayerInteraction(textLayerDiv);
            if (typeof cleanup === 'function') {
                textLayerCleanupFns.set(pageNumber, cleanup);
            }
        } catch (textLayerInteractionError) {
            logNonCriticalStageError(
                pageNumber,
                'text layer interaction',
                textLayerInteractionError,
            );
        }

        try {
            textLayerRenderer.applyPageSearchHighlights(
                container,
                textLayerDiv,
                pageNumber,
                canvas,
                {
                    userUnit,
                    totalScaleFactor,
                    viewportWidth: viewport.width,
                    viewportHeight: viewport.height,
                    rawPageWidth: rawDims.pageWidth,
                    rawPageHeight: rawDims.pageHeight,
                    canvasPixelWidth: canvas.width,
                    canvasPixelHeight: canvas.height,
                    renderScaleX: scaleX,
                    renderScaleY: scaleY,
                },
            );
        } catch (searchHighlightError) {
            logNonCriticalStageError(
                pageNumber,
                'search highlights',
                searchHighlightError,
            );
        }

        return true;
    }

    return renderTextLayerForPage;
};
