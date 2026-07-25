import type { MaybeRefOrGetter } from 'vue';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { usePdfAnnotationLayerRenderer } from '@app/modules/pdf-viewer/runtime/rendering/usePdfAnnotationLayerRenderer';
import { PDF_PAGE_RENDER_TIMEOUT_MS } from '@app/constants/timeouts';
import { withPageStageTimeout } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/withPageStageTimeout';
import type { IPdfRenderSupervisor } from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';

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
    preserveCanvasOnStale?: boolean;
}

interface IUsePdfRendererAnnotationLayerControllerOptions {
    annotationLayerRenderer: ReturnType<typeof usePdfAnnotationLayerRenderer>;
    showAnnotations: MaybeRefOrGetter<boolean>;
    annotationUiManager: MaybeRefOrGetter<unknown>;
    getRenderVersion: () => number;
    cleanupPageIfCurrentRender: (pageNumber: number, version: number, requestId?: number) => void;
    logNonCriticalStageError: (pageNumber: number, stage: string, error: unknown) => void;
    renderSupervisor?: IPdfRenderSupervisor | undefined;
}

export const usePdfRendererAnnotationLayerController = (options: IUsePdfRendererAnnotationLayerControllerOptions) => {
    const {
        annotationLayerRenderer,
        showAnnotations,
        annotationUiManager,
        getRenderVersion,
        cleanupPageIfCurrentRender,
        logNonCriticalStageError,
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
            preserveCanvasOnStale = false,
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
                if (!preserveCanvasOnStale) {
                    cleanupPageIfCurrentRender(pageNumber, version, requestId);
                }
                return {
                    shouldContinue: false,
                    annotationLayerInstance: null,
                };
            }

            const annotationAbortController = createAnnotationLayerAbortController(pageNumber);
            try {
                annotationLayerInstance =
                    await withPageStageTimeout(
                        annotationLayerRenderer.renderAnnotationLayer(
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
                        ),
                        {
                            pageNumber,
                            stage: 'annotation-layer',
                            timeoutMs: PDF_PAGE_RENDER_TIMEOUT_MS,
                        },
                        () => getRenderVersion() === version && shouldContinue(),
                        () => annotationAbortController.abort(),
                        undefined,
                        options.renderSupervisor,
                        annotationAbortController.signal,
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
                if (!preserveCanvasOnStale) {
                    cleanupPageIfCurrentRender(pageNumber, version, requestId);
                }
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
                if (!preserveCanvasOnStale) {
                    cleanupPageIfCurrentRender(pageNumber, version, requestId);
                }
                return {
                    shouldContinue: false,
                    annotationLayerInstance: null,
                };
            }
            const annotationEditorAbortController = createAnnotationLayerAbortController(pageNumber);
            try {
                await withPageStageTimeout(
                    annotationLayerRenderer.renderAnnotationEditorLayer(
                        container,
                        annotationEditorLayerDiv,
                        textLayerDiv,
                        viewport,
                        pageNumber,
                        annotationLayerInstance,
                        {
                            signal: annotationEditorAbortController.signal,
                            shouldContinue,
                        },
                    ),
                    {
                        pageNumber,
                        stage: 'annotation-editor-layer',
                        timeoutMs: PDF_PAGE_RENDER_TIMEOUT_MS,
                    },
                    () => getRenderVersion() === version && shouldContinue(),
                    () => annotationEditorAbortController.abort(),
                    undefined,
                    options.renderSupervisor,
                    annotationEditorAbortController.signal,
                );
            } catch (annotationEditorError) {
                logNonCriticalStageError(
                    pageNumber,
                    'annotation editor layer',
                    annotationEditorError,
                );
            } finally {
                releaseAnnotationLayerAbortController(pageNumber, annotationEditorAbortController);
            }

            if (getRenderVersion() !== version || !shouldContinue()) {
                if (!preserveCanvasOnStale) {
                    cleanupPageIfCurrentRender(pageNumber, version, requestId);
                }
                return {
                    shouldContinue: false,
                    annotationLayerInstance: null,
                };
            }

        }

        if (getRenderVersion() !== version || !shouldContinue()) {
            if (!preserveCanvasOnStale) {
                cleanupPageIfCurrentRender(pageNumber, version, requestId);
            }
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
