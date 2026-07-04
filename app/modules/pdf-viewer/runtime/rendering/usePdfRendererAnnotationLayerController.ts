import type { MaybeRefOrGetter } from 'vue';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { usePdfAnnotationLayerRenderer } from '@app/modules/pdf-viewer/runtime/rendering/usePdfAnnotationLayerRenderer';

type TAnnotationLayerInstance = Awaited<
    ReturnType<ReturnType<typeof usePdfAnnotationLayerRenderer>['renderAnnotationLayer']>
> | null;

interface IAnnotationRenderContext {
    container: HTMLElement;
    pdfPage: PDFPageProxy;
    renderResult: {
        viewport: Parameters<ReturnType<typeof usePdfAnnotationLayerRenderer>['renderAnnotationLayer']>[2];
        annotationCanvasMap: Parameters<ReturnType<typeof usePdfAnnotationLayerRenderer>['renderAnnotationLayer']>[4];
    };
    textLayerDiv: HTMLDivElement | null;
}

interface IUsePdfRendererAnnotationLayerControllerOptions {
    annotationLayerRenderer: ReturnType<typeof usePdfAnnotationLayerRenderer>;
    showAnnotations: MaybeRefOrGetter<boolean>;
    annotationUiManager: MaybeRefOrGetter<unknown>;
    getRenderVersion: () => number;
    cleanupPageIfCurrentRender: (pageNumber: number, version: number, requestId?: number) => void;
    logNonCriticalStageError: (pageNumber: number, stage: string, error: unknown) => void;
    onAnnotationLayersRendered?: ((pageNumber: number, container: HTMLElement) => void) | undefined;
}

export const usePdfRendererAnnotationLayerController = (options: IUsePdfRendererAnnotationLayerControllerOptions) => {
    const {
        annotationLayerRenderer,
        showAnnotations,
        annotationUiManager,
        getRenderVersion,
        cleanupPageIfCurrentRender,
        logNonCriticalStageError,
        onAnnotationLayersRendered,
    } = options;
    const activeAnnotationLayerAbortControllers = new Map<number, AbortController>();

    function createAnnotationLayerAbortController(pageNumber: number) {
        activeAnnotationLayerAbortControllers.get(pageNumber)?.abort();
        const controller = new AbortController();
        activeAnnotationLayerAbortControllers.set(pageNumber, controller);
        return controller;
    }

    function releaseAnnotationLayerAbortController(pageNumber: number, controller: AbortController) {
        if (activeAnnotationLayerAbortControllers.get(pageNumber) === controller) {
            activeAnnotationLayerAbortControllers.delete(pageNumber);
        }
    }

    async function renderAnnotationLayersForPage(
        pageNumber: number,
        version: number,
        requestId: number,
        context: IAnnotationRenderContext,
        shouldContinue: () => boolean,
    ) {
        const {
            container,
            pdfPage,
            renderResult,
            textLayerDiv,
        } = context;
        const {
            viewport,
            annotationCanvasMap,
        } = renderResult;
        const annotationLayerDiv =
            container.querySelector<HTMLElement>('.annotation-layer');
        let annotationLayerInstance: TAnnotationLayerInstance = null;
        if (annotationLayerDiv && toValue(showAnnotations)) {
            if (getRenderVersion() !== version || !shouldContinue()) {
                cleanupPageIfCurrentRender(pageNumber, version, requestId);
                return {
                    shouldContinue: false,
                    annotationLayerInstance: null,
                };
            }

            const annotationAbortController = createAnnotationLayerAbortController(pageNumber);
            try {
                annotationLayerInstance =
                    await annotationLayerRenderer.renderAnnotationLayer(
                        pdfPage,
                        annotationLayerDiv,
                        viewport,
                        pageNumber,
                        annotationCanvasMap,
                        {
                            documentVersion: version,
                            signal: annotationAbortController.signal,
                            shouldContinue,
                        },
                    );
            } catch (annotationError) {
                logNonCriticalStageError(
                    pageNumber,
                    'annotation layer',
                    annotationError,
                );
            } finally {
                releaseAnnotationLayerAbortController(pageNumber, annotationAbortController);
            }

            if (getRenderVersion() !== version || !shouldContinue()) {
                cleanupPageIfCurrentRender(pageNumber, version, requestId);
                return {
                    shouldContinue: false,
                    annotationLayerInstance: null,
                };
            }
        }

        const annotationEditorLayerDiv =
            container.querySelector<HTMLElement>('.annotation-editor-layer');
        if (
            annotationEditorLayerDiv &&
            toValue(annotationUiManager)
        ) {
            if (getRenderVersion() !== version || !shouldContinue()) {
                cleanupPageIfCurrentRender(pageNumber, version, requestId);
                return {
                    shouldContinue: false,
                    annotationLayerInstance: null,
                };
            }
            try {
                await annotationLayerRenderer.renderAnnotationEditorLayer(
                    container,
                    annotationEditorLayerDiv,
                    textLayerDiv,
                    viewport,
                    pageNumber,
                    annotationLayerInstance,
                    { shouldContinue },
                );
            } catch (annotationEditorError) {
                logNonCriticalStageError(
                    pageNumber,
                    'annotation editor layer',
                    annotationEditorError,
                );
            }

            if (getRenderVersion() !== version || !shouldContinue()) {
                cleanupPageIfCurrentRender(pageNumber, version, requestId);
                return {
                    shouldContinue: false,
                    annotationLayerInstance: null,
                };
            }

        }

        try {
            onAnnotationLayersRendered?.(pageNumber, container);
        } catch (error) {
            logNonCriticalStageError(
                pageNumber,
                'annotation color sync',
                error,
            );
        }
        if (getRenderVersion() !== version || !shouldContinue()) {
            cleanupPageIfCurrentRender(pageNumber, version, requestId);
            return {
                shouldContinue: false,
                annotationLayerInstance: null,
            };
        }

        return {
            shouldContinue: true,
            annotationLayerInstance,
        };
    }

    return renderAnnotationLayersForPage;
};
