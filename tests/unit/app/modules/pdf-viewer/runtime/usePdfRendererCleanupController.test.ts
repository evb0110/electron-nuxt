// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { createPdfPageRenderState } from '@app/modules/pdf-viewer/runtime/rendering/pdfPageRenderState';
import { usePdfRendererCleanupController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererCleanupController';

describe('usePdfRendererCleanupController', () => {
    function createPageDom() {
        const root = document.createElement('div');
        const page = document.createElement('div');
        page.className = 'page_container page_container--rendered';
        page.dataset.page = '1';
        const canvasHost = document.createElement('div');
        canvasHost.className = 'page_canvas__render-layer';
        const canvas = document.createElement('canvas');
        canvas.width = 800;
        canvas.height = 1_000;
        canvasHost.append(canvas);
        const textLayer = document.createElement('div');
        textLayer.className = 'text-layer';
        textLayer.append(document.createElement('span'));
        const annotationLayer = document.createElement('div');
        annotationLayer.className = 'annotation-layer';
        annotationLayer.append(document.createElement('canvas'));
        const annotationEditorLayer = document.createElement('div');
        annotationEditorLayer.className = 'annotation-editor-layer';
        annotationEditorLayer.append(document.createElement('canvas'));
        page.append(canvasHost, textLayer, annotationLayer, annotationEditorLayer);
        root.append(page);
        document.body.replaceChildren(root);
        return {
            root,
            page,
            canvasHost,
            canvas,
            textLayer,
            annotationLayer,
            annotationEditorLayer,
        };
    }

    function createController(options: {
        root: HTMLElement;
        page: HTMLElement;
        pageRenderState: ReturnType<typeof createPdfPageRenderState>;
        pageCanvases: Map<number, HTMLCanvasElement>;
    }) {
        const cleanupCanvas = vi.fn((target: HTMLCanvasElement) => {
            target.width = 0;
            target.height = 0;
        });
        const cleanupTextLayerDom = vi.fn((target: HTMLElement) => target.replaceChildren());
        const evictPage = vi.fn();
        const controller = usePdfRendererCleanupController({
            container: ref(options.root),
            currentPage: ref(1),
            pageRenderState: options.pageRenderState,
            renderedPages: options.pageRenderState.renderedPages,
            renderingPages: options.pageRenderState.renderingPages,
            renderingPageRequestIds: options.pageRenderState.renderingPageRequestIds,
            missingRenderTargetRetries: new Map(),
            pageCanvases: options.pageCanvases,
            textLayerCleanupFns: new Map(),
            canvasRenderer: {cleanupCanvas} as never,
            textLayerRenderer: {
                cleanupTextLayerDom,
                clearOcrDebug: vi.fn(),
            } as never,
            annotationLayerRenderer: {
                cleanupEditorLayer: vi.fn(),
                clearAllLayers: vi.fn(),
            } as never,
            getRenderVersion: () => 2,
            bumpRenderVersion: vi.fn(() => 3),
            getMountedPageContainer: () => options.page,
            summarizePageDom: () => ({}),
            cancelActiveRenderTask: vi.fn(),
            cancelActiveTextLayerRender: vi.fn(),
            getTrackedPageNumbersForCleanup: () => new Set([1]),
            evictPage,
            cleanupPageCache: vi.fn(),
            onRenderedPageStateChanged: vi.fn(),
            invalidatePendingSearchRequests: vi.fn(),
        });
        return {
            controller,
            cleanupCanvas,
            cleanupTextLayerDom,
            evictPage,
        };
    }

    it('cleans partial DOM and resources when the initial render fails', () => {
        const dom = createPageDom();
        const pageRenderState = createPdfPageRenderState();
        pageRenderState.beginRender(1, 1, 1, 'doc-1', 1);
        expect(pageRenderState.markRenderFailed(1, 1, 1)).toBe(true);
        const pageCanvases = new Map([[
            1,
            dom.canvas,
        ]]);
        const harness = createController({
            root: dom.root,
            page: dom.page,
            pageRenderState,
            pageCanvases,
        });

        harness.controller.cleanupPageIfCurrentRender(1, 1, 1, {terminalFailure: true});

        expect(harness.cleanupCanvas).toHaveBeenCalledOnce();
        expect(pageCanvases.has(1)).toBe(false);
        expect(dom.canvas.width).toBe(0);
        expect(dom.canvas.height).toBe(0);
        expect(dom.canvasHost.children).toHaveLength(0);
        expect(dom.textLayer.children).toHaveLength(0);
        expect(dom.annotationLayer.children).toHaveLength(0);
        expect(dom.annotationEditorLayer.children).toHaveLength(0);
        expect(harness.evictPage).toHaveBeenCalledWith(1);
        expect(pageRenderState.getSlot(1)).toEqual(expect.objectContaining({
            visual: 'none',
            job: 'failed',
            version: 1,
            requestId: 1,
        }));
    });

    it('removes prior pixels when their canonical replacement render fails', () => {
        const dom = createPageDom();

        const pageRenderState = createPdfPageRenderState();
        pageRenderState.beginRender(1, 1, 1, 'doc-1', 1);
        pageRenderState.commitCanvas(1, 1, 1);
        pageRenderState.beginRender(1, 2, 2, 'doc-1', 1.5);
        expect(pageRenderState.markRenderFailed(1, 2, 2)).toBe(true);

        const pageCanvases = new Map([[
            1,
            dom.canvas,
        ]]);
        const harness = createController({
            root: dom.root,
            page: dom.page,
            pageRenderState,
            pageCanvases,
        });

        harness.controller.cleanupPageIfCurrentRender(1, 2, 2, {terminalFailure: true});

        expect(harness.cleanupCanvas).toHaveBeenCalledOnce();
        expect(pageCanvases.has(1)).toBe(false);
        expect(dom.canvasHost.children).toHaveLength(0);
        expect(dom.textLayer.children).toHaveLength(0);
        expect(dom.annotationLayer.children).toHaveLength(0);
        expect(dom.annotationEditorLayer.children).toHaveLength(0);
        expect(harness.evictPage).toHaveBeenCalledWith(1);
        expect(pageRenderState.getSlot(1)).toEqual(expect.objectContaining({
            visual: 'none',
            job: 'failed',
            version: 2,
            requestId: 2,
        }));
    });
});
