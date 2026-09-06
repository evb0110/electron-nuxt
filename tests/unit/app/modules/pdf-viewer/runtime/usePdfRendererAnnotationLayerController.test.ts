// @vitest-environment happy-dom

import { requirePageNumber } from '@contracts/pageNumbers';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { PDFPageProxy } from 'pdfjs-dist';
import { usePdfRendererAnnotationLayerController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererAnnotationLayerController';

type TAnnotationRenderContext = Parameters<
    ReturnType<typeof usePdfRendererAnnotationLayerController>
>[3];

function createPdfPage(): PDFPageProxy {
    // The controller forwards the page proxy to the renderer but does not read it.
    return {} as PDFPageProxy;
}

function createViewport(): TAnnotationRenderContext['renderResult']['viewport'] {
    // PDF.js owns the complete viewport shape; this test needs its dimensions.
    return {
        width: 100,
        height: 100,
        rotation: 0,
    } as TAnnotationRenderContext['renderResult']['viewport'];
}

function createRenderContext(container: HTMLElement): TAnnotationRenderContext {
    return {
        container,
        pdfPage: createPdfPage(),
        renderResult: {
            viewport: createViewport(),
            annotationCanvasMap: null,
        },
        textLayerDiv: null,
    };
}

function createHarness() {
    const container = document.createElement('div');
    const annotationLayerDiv = document.createElement('div');
    annotationLayerDiv.className = 'annotation-layer';
    container.append(annotationLayerDiv);

    const renderDeferred = Promise.withResolvers<null>();
    const renderSignals: AbortSignal[] = [];
    const annotationLayerRenderer = {
        renderAnnotationLayer: vi.fn((_page, _layer, _viewport, _pageNumber, _canvasMap, renderOptions) => {
            if (renderOptions?.signal) {
                renderSignals.push(renderOptions.signal);
            }
            return renderDeferred.promise;
        }),
        renderAnnotationEditorLayer: vi.fn(),
        hideHiddenManagedEditors: vi.fn(),
        cleanupEditorLayer: vi.fn(),
        clearAllLayers: vi.fn(),
    } satisfies Parameters<typeof usePdfRendererAnnotationLayerController>[0]['annotationLayerRenderer'];
    const controller = usePdfRendererAnnotationLayerController({
        annotationLayerRenderer,
        showAnnotations: ref(true),
        annotationUiManager: ref(null),
        getRenderVersion: () => 1,
        cleanupPageIfCurrentRender: vi.fn(),
        logNonCriticalStageError: vi.fn(),
    });

    return {
        annotationLayerRenderer,
        container,
        controller,
        renderDeferred,
        renderSignals,
    };
}

describe('usePdfRendererAnnotationLayerController', () => {
    it('aborts active annotation work when a page is released', async () => {
        const harness = createHarness();
        const render = harness.controller(
            requirePageNumber(1),
            1,
            1,
            createRenderContext(harness.container),
            () => true,
        );

        await vi.waitFor(() => {
            expect(harness.annotationLayerRenderer.renderAnnotationLayer).toHaveBeenCalledOnce();
        });
        expect(harness.renderSignals[0]?.aborted).toBe(false);

        harness.controller.cancel(requirePageNumber(1));

        expect(harness.renderSignals[0]?.aborted).toBe(true);
        harness.renderDeferred.resolve(null);
        await expect(render).resolves.toMatchObject({shouldContinue: true});
    });

    it('registers editor-layer controllers so dispose aborts direct editor renders', () => {
        const harness = createHarness();
        const editorController = new AbortController();

        const unregister = harness.controller.register(requirePageNumber(7), editorController);
        harness.controller.dispose();

        expect(editorController.signal.aborted).toBe(true);
        unregister();
    });

    it('aborts every registered page controller when the document is cleared', () => {
        const harness = createHarness();
        const first = new AbortController();
        const second = new AbortController();

        harness.controller.register(requirePageNumber(1), first);
        harness.controller.register(requirePageNumber(2), second);
        harness.controller.cancelAll();

        expect(first.signal.aborted).toBe(true);
        expect(second.signal.aborted).toBe(true);
    });
});
