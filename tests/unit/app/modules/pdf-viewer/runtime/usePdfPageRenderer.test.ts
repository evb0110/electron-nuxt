// @vitest-environment happy-dom

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { cast } from '@tests/helpers/cast';
import { createPdfPageRenderState } from '@app/modules/pdf-viewer/runtime/rendering/pdfPageRenderState';
import type { IUsePdfPageRendererOptions } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';

const rendererFixture = vi.hoisted(() => ({
    renderTextLayer: vi.fn(),
    applyPageSearchHighlights: vi.fn(),
    cleanupTextLayerDom: vi.fn(),
    setupTextLayerInteraction: vi.fn(),
    clearOcrDebug: vi.fn(),
    scheduleOcrDebugForPage: vi.fn(),
}));
const annotationControllerFixture = vi.hoisted(() => ({render: vi.fn()}));

vi.mock('@app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer', () => ({usePdfTextLayerRenderer: () => rendererFixture}));
vi.mock('@app/modules/pdf-viewer/runtime/rendering/usePdfAnnotationLayerRenderer', () => ({usePdfAnnotationLayerRenderer: () => ({
    cleanupEditorLayer: vi.fn(),
    clearAllLayers: vi.fn(),
    hideHiddenManagedEditors: vi.fn(),
    renderAnnotationEditorLayer: vi.fn(async () => undefined),
})}));
vi.mock('@app/modules/pdf-viewer/runtime/rendering/usePdfRendererAnnotationLayerController', () => ({usePdfRendererAnnotationLayerController: () => Object.assign(
    annotationControllerFixture.render,
    {
        cancel: vi.fn(),
        cancelAll: vi.fn(),
        dispose: vi.fn(),
        register: vi.fn(() => vi.fn()),
    },
)}));
vi.mock('@app/modules/pdf-viewer/runtime/rendering/usePdfRendererSearchController', () => ({usePdfRendererSearchController: () => ({
    applySearchHighlights: vi.fn(),
    invalidatePendingRequests: vi.fn(),
    requestScrollToCurrentResult: vi.fn(),
})}));

const { usePdfPageRenderer } = await import(
    '@app/modules/pdf-viewer/runtime/rendering/usePdfPageRenderer'
);

function createDeferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return {
        promise,
        resolve,
    };
}

function createHarness() {
    const root = document.createElement('div');
    const pageContainer = document.createElement('div');
    pageContainer.className = 'page_container';
    pageContainer.dataset.page = '1';
    const textLayer = document.createElement('div');
    textLayer.className = 'text-layer';
    const canvas = document.createElement('canvas');
    pageContainer.append(canvas, textLayer);
    root.append(pageContainer);
    document.body.append(root);

    const page = cast<Awaited<ReturnType<IUsePdfPageRendererOptions['document']['leasePage']>>['page']>({
        rotate: 0,
        getViewport: () => ({
            width: 600,
            height: 800,
            userUnit: 1,
            rawDims: {
                pageWidth: 600,
                pageHeight: 800,
            },
        }),
    });
    const release = vi.fn();
    const pageRenderState = createPdfPageRenderState();
    const onRenderedPageStateChanged = vi.fn();
    const renderer = usePdfPageRenderer(cast<IUsePdfPageRendererOptions>({
        container: ref(root),
        document: {
            pdfDocument: ref({}),
            numPages: ref(1),
            isLoading: ref(false),
            captureFence: () => ({token: 1}),
            isCurrent: () => true,
            leasePage: vi.fn(async () => ({
                page,
                release,
            })),
        },
        viewport: {
            scale: {effectiveScale: ref(1)},
            currentPage: ref(1),
            cancelPendingSearchRevision: ref(0),
            viewportWritePort: {},
            singlePageScroll: {
                viewportAuthority: {
                    phase: ref('idle'),
                    activeIntent: ref(null),
                },
                scrollToPage: vi.fn(),
                beginSearchNavigation: vi.fn(),
                revealSearchNavigationTarget: vi.fn(),
                endSearchNavigation: vi.fn(),
            },
            markUserViewportInteraction: vi.fn(),
            transactionController: {
                beginTransaction: vi.fn(() => null),
                isTransactionCurrent: vi.fn(() => false),
                advanceTransaction: vi.fn(),
                cancelActiveTransaction: vi.fn(),
            },
        },
        pageRenderState,
        outputScale: ref(1),
        showAnnotations: false,
        getRenderVersion: () => 1,
        getRenderDocumentToken: () => 'document-a',
        getCommittedCanvas: () => canvas,
        onRenderedPageStateChanged,
        requestSearchPageRaster: vi.fn(async () => undefined),
    }));
    const renderResult = {
        canvas,
        viewport: page.getViewport({scale: 1}),
        annotationCanvasMap: null,
        scaleX: 1,
        scaleY: 1,
        rawDims: {
            pageWidth: 600,
            pageHeight: 800,
        },
        userUnit: 1,
        totalScaleFactor: 1,
    };
    return {
        canvas,
        onRenderedPageStateChanged,
        pageContainer,
        pageRenderState,
        release,
        renderer,
        renderResult,
        root,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    annotationControllerFixture.render.mockResolvedValue({
        shouldContinue: true,
        annotationLayerInstance: null,
    });
});

describe('usePdfPageRenderer layer hydration ownership', () => {
    it('does not promote or cancel an annotations-first text layer already in flight', async () => {
        const deferred = createDeferred();
        let activeSignal: AbortSignal | undefined;
        rendererFixture.renderTextLayer.mockImplementation(async (...args: unknown[]) => {
            activeSignal = args[6] as AbortSignal;
            await deferred.promise;
        });
        const harness = createHarness();
        let hydration: Promise<void> | null = null;
        try {
            harness.pageRenderState.beginRender(1, 1, 11, 'document-a', 1, 1, harness.pageContainer);
            harness.pageRenderState.commitVisual(1, 1, 11);

            hydration = harness.renderer.renderCommittedPageLayers({
                pageNumber: 1,
                version: 1,
                requestId: 11,
                scale: 1,
                container: harness.pageContainer,
                renderResult: harness.renderResult,
                renderOptions: {},
            });
            await vi.waitFor(() => {
                expect(rendererFixture.renderTextLayer).toHaveBeenCalledOnce();
            });

            expect(harness.pageRenderState.getSlot(1).layerReadiness).toBe('hydrating');
            expect(harness.renderer.resolveLayerPromotionDemand([1])).toBeNull();
            await harness.renderer.renderLayerPromotions({
                start: 1,
                end: 1,
            }, {
                contentIntent: 'layers-only-promotion',
                rasterDemandPages: [1],
                prioritizeTextLayer: true,
            });
            expect(activeSignal?.aborted).toBe(false);

            deferred.resolve();
            await hydration;
            expect(harness.pageRenderState.getSlot(1).textLayerReadiness).toBe('ready');
            expect(harness.pageRenderState.getSlot(1).layerReadiness).toBe('ready');
            expect(harness.pageContainer.dataset.pageLayerReadiness).toBe('ready');
        } finally {
            deferred.resolve();
            await hydration?.catch(() => undefined);
            harness.root.remove();
        }
    });

    it('publishes text readiness before text-first annotation hydration settles', async () => {
        const annotation = createDeferred();
        annotationControllerFixture.render.mockImplementationOnce(async () => {
            await annotation.promise;
            return {
                shouldContinue: true,
                annotationLayerInstance: null,
            };
        });
        rendererFixture.renderTextLayer.mockResolvedValue(undefined);
        const harness = createHarness();
        let hydration: Promise<void> | null = null;
        try {
            harness.pageRenderState.beginRender(1, 1, 11, 'document-a', 1, 1, harness.pageContainer);
            harness.pageRenderState.commitVisual(1, 1, 11);

            hydration = harness.renderer.renderCommittedPageLayers({
                pageNumber: 1,
                version: 1,
                requestId: 11,
                scale: 1,
                container: harness.pageContainer,
                renderResult: harness.renderResult,
                renderOptions: {prioritizeTextLayer: true},
            });

            await vi.waitFor(() => expect(
                harness.pageRenderState.getSlot(1).textLayerReadiness,
            ).toBe('ready'));
            expect(harness.pageRenderState.getSlot(1).layerReadiness).toBe('hydrating');
            expect(harness.onRenderedPageStateChanged).toHaveBeenCalledOnce();

            annotation.resolve();
            await hydration;
            expect(harness.pageRenderState.getSlot(1).layerReadiness).toBe('ready');
        } finally {
            annotation.resolve();
            await hydration?.catch(() => undefined);
            harness.root.remove();
        }
    });

    it('runs a queued text-first promotion after an active owner settles canvas-only', async () => {
        const annotation = createDeferred();
        annotationControllerFixture.render
            .mockImplementationOnce(async () => {
                await annotation.promise;
                return {
                    shouldContinue: false,
                    annotationLayerInstance: null,
                };
            })
            .mockResolvedValue({
                shouldContinue: true,
                annotationLayerInstance: null,
            });
        rendererFixture.renderTextLayer.mockResolvedValue(undefined);
        const harness = createHarness();
        let hydration: Promise<void> | null = null;
        try {
            harness.pageRenderState.beginRender(1, 1, 11, 'document-a', 1, 1, harness.pageContainer);
            harness.pageRenderState.commitVisual(1, 1, 11);
            hydration = harness.renderer.renderCommittedPageLayers({
                pageNumber: 1,
                version: 1,
                requestId: 11,
                scale: 1,
                container: harness.pageContainer,
                renderResult: harness.renderResult,
                renderOptions: {},
            });
            await vi.waitFor(() => expect(annotationControllerFixture.render).toHaveBeenCalledOnce());

            harness.renderer.queuePrioritizedTextLayerPromotions([1], {prioritizeTextLayer: true});
            annotation.resolve();
            await hydration;

            await vi.waitFor(() => expect(rendererFixture.renderTextLayer).toHaveBeenCalledOnce());
            await vi.waitFor(() => expect(
                harness.pageRenderState.getSlot(1).layerReadiness,
            ).toBe('ready'));
            expect(annotationControllerFixture.render).toHaveBeenCalledTimes(2);
        } finally {
            annotation.resolve();
            await hydration?.catch(() => undefined);
            harness.root.remove();
        }
    });

    it('promotes a settled canvas-only page exactly once with text-first priority', async () => {
        rendererFixture.renderTextLayer.mockResolvedValue(undefined);
        const harness = createHarness();
        try {
            harness.pageRenderState.beginRender(1, 1, 11, 'document-a', 1, 1, harness.pageContainer);
            harness.pageRenderState.commitVisual(1, 1, 11);
            harness.pageRenderState.markCanvasOnly(1, 1, 11);
            harness.pageRenderState.completeRender(1, 1, 11);

            const promotion = harness.renderer.resolveLayerPromotionDemand([1]);
            expect(promotion).not.toBeNull();
            await harness.renderer.renderLayerPromotions(promotion!.range, {
                ...promotion!.options,
                prioritizeTextLayer: true,
            });

            expect(rendererFixture.renderTextLayer).toHaveBeenCalledOnce();
            expect(harness.pageRenderState.getSlot(1).layerReadiness).toBe('ready');
            expect(harness.renderer.resolveLayerPromotionDemand([1])).toBeNull();
        } finally {
            harness.root.remove();
        }
    });
});
