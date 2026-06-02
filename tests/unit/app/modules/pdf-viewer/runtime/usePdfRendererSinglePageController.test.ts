import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { PDFPageProxy } from 'pdfjs-dist';
import { usePdfRendererSinglePageController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererSinglePageController';

class FakeElement {
    public readonly children: unknown[] = [];
    public readonly classList = {
        add: vi.fn(),
        remove: vi.fn(),
    };
    public readonly dataset: Record<string, string> = {};
    public innerHTML = '';
    public isConnected = true;
    private readonly bySelector = new Map<string, FakeElement>();

    public constructor(private readonly parent: FakeElement | null = null) {}

    public append(...children: unknown[]) {
        this.children.push(...children);
    }

    public closest(selector: string) {
        return selector === '.page_container' ? this.parent : null;
    }

    public querySelector<T = FakeElement>(selector: string): T | null {
        return (this.bySelector.get(selector) ?? null) as T | null;
    }

    public setQuery(selector: string, element: FakeElement) {
        this.bySelector.set(selector, element);
    }
}

function createPageRoot() {
    const root = new FakeElement();
    const page = new FakeElement(root);
    page.dataset.page = '1';

    const canvasHost = new FakeElement(page);
    const textLayer = new FakeElement(page);
    const annotationLayer = new FakeElement(page);
    const annotationEditorLayer = new FakeElement(page);

    root.setQuery('.page_container[data-page="1"]', page);
    page.setQuery('.page_canvas', canvasHost);
    page.setQuery('.text-layer', textLayer);
    page.setQuery('.annotation-layer', annotationLayer);
    page.setQuery('.annotation-editor-layer', annotationEditorLayer);

    return {
        root: root as FakeElement & HTMLElement,
        page,
        canvasHost,
    };
}

describe('usePdfRendererSinglePageController', () => {
    it('cleans a mounted canvas when a later async text-layer stage goes stale', async () => {
        const {
            root,
            page,
            canvasHost,
        } = createPageRoot();
        let renderVersion = 1;
        const pdfPage = { cleanup: vi.fn() } as PDFPageProxy & {cleanup: ReturnType<typeof vi.fn>};
        const cleanupPageIfCurrentRender = vi.fn(() => {
            canvasHost.children.length = 0;
        });
        const releasePageResources = vi.fn();
        const renderingPages = new Map<number, number>();
        const renderingPageRequestIds = new Map<number, number>();

        const controller = usePdfRendererSinglePageController({
            isActive: true,
            effectiveScale: 1,
            annotationUiManager: null,
            getContainerRoot: () => root,
            renderedPages: new Set<number>(),
            staleRenderedPages: new Set<number>(),
            renderingPages,
            renderingPageRequestIds,
            activeRenderTasks: new Map(),
            getRenderVersion: () => renderVersion,
            getVisibleRenderRequestId: () => 1,
            summarizePageDom: () => ({}),
            clearSelectionBeforePageLayerTeardown: vi.fn(),
            cleanupPageIfCurrentRender,
            cleanupCanvasRenderResult: vi.fn(),
            releasePageResources,
            loadPageForRender: vi.fn(async () => pdfPage),
            prepareCanvasForRender: vi.fn(async () => ({ canvas: { tagName: 'CANVAS' } })),
            mountRenderedCanvas: vi.fn((_pageNumber, _container, _host, renderResult) => {
                canvasHost.append(renderResult.canvas);
            }),
            scheduleRenderForSinglePage: vi.fn(),
            scheduleMissingRenderTargetRetry: vi.fn(),
            clearMissingRenderTargetRetry: vi.fn(),
            renderTextLayerForPage: vi.fn(async () => {
                renderVersion = 2;
                return false;
            }),
            renderAnnotationLayersForPage: vi.fn(async () => ({
                shouldContinue: true,
                annotationLayerInstance: null,
            })),
            renderAnnotationEditorLayer: vi.fn(async () => true),
            getViewportForAnnotationEditorLayer: vi.fn(() => ({}) as never),
            scheduleOcrDebugForPage: vi.fn(),
            logNonCriticalStageError: vi.fn(),
        });

        await controller.renderSingleVisiblePage(
            root,
            1,
            1,
            1,
            false,
            1,
            () => true,
            new Set([1]),
        );

        expect(canvasHost.children).toHaveLength(0);
        expect(page.classList.add).not.toHaveBeenCalledWith('page_container--rendered');
        expect(cleanupPageIfCurrentRender).toHaveBeenCalledWith(1, 1, 1);
        expect(releasePageResources).toHaveBeenCalledWith(1, pdfPage);
        expect(renderingPages.has(1)).toBe(false);
    });
});
