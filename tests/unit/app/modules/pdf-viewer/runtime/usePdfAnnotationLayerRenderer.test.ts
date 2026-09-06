import { requirePageNumber } from '@contracts/pageNumbers';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    AnnotationEditorUIManager,
    PDFPageProxy,
} from 'pdfjs-dist';
import {
    ref,
    shallowRef,
} from 'vue';
import { usePdfAnnotationLayerRenderer } from '@app/modules/pdf-viewer/runtime/rendering/usePdfAnnotationLayerRenderer';
import type {PDFDocumentProxy} from '@app/types/pdfContracts';
import {createPdfDocumentProxy} from '@tests/helpers/createPdfDocumentProxy';

type TPdfViewport = ReturnType<PDFPageProxy['getViewport']>;

function createPageProxy(getAnnotations: PDFPageProxy['getAnnotations']): PDFPageProxy {
    // Annotation rendering uses getAnnotations in this unit. PDF.js supplies
    // the remaining page proxy members.
    return {getAnnotations} as PDFPageProxy;
}

function createViewport(width = 200, height = 300): TPdfViewport {
    // The layer renderer reads only viewport dimensions and rotation here.
    return {
        width,
        height,
        rotation: 0,
    } as TPdfViewport;
}

function createAnnotationLayerDiv(innerHTML = ''): HTMLElement {
    // The PDF.js layer mock reads the HTML string and annotation descendants.
    return Object.assign(Object.create(null), {
        innerHTML,
        querySelectorAll: vi.fn(() => []),
    });
}

function createAnnotationUiManagerRef(
    annotationUiManager: object,
) {
    // Forward PDF.js manager mutations to the local object while keeping the
    // object identity that the guard tests inspect.
    const managerProxy = new Proxy(Object.create(null), {
        get: (_target, property) => Reflect.get(annotationUiManager, property),
        set: (_target, property, value) => Reflect.set(annotationUiManager, property, value),
    });
    return shallowRef(managerProxy);
}

const annotationLayerCtor = vi.fn();
const annotationLayerRender = vi.fn(async (_options: unknown) => {});

vi.mock('@app/services/pdfjs/runtimeLib', () => ({
    default: {version: '5.7.284'},
    AnnotationLayer: class MockAnnotationLayer {
        constructor(options: unknown) {
            annotationLayerCtor(options);
        }

        render(options: unknown) {
            return annotationLayerRender(options);
        }
    },
    AnnotationEditorLayer: class MockAnnotationEditorLayer {
        disable() {}
        destroy() {}
    },
    AnnotationEditorUIManager: class MockAnnotationEditorUIManager {
        readonly kind = 'mock';

        get currentLayer() {
            return null;
        }
    },
    AnnotationEditorType: {},
    DrawLayer: class MockDrawLayer {
        destroy() {}
    },
}));

vi.mock('@app/utils/getShellCapability', () => ({ getShellCapability: () => ({ openExternal: vi.fn(async () => {}) }) }));

describe('usePdfAnnotationLayerRenderer', () => {
    beforeEach(() => {
        annotationLayerCtor.mockClear();
        annotationLayerRender.mockClear();
    });

    it('passes the shared annotation canvas map to PDF.js so stamp appearances can render after reload', async () => {
        const renderer = usePdfAnnotationLayerRenderer({
            numPages: ref(3),
            currentPage: ref(1),
            pdfDocument: shallowRef<PDFDocumentProxy | null>(createPdfDocumentProxy()),
            showAnnotations: ref(true),
            annotationUiManager: shallowRef<AnnotationEditorUIManager | null>(null),
            annotationL10n: ref(null),
        });

        const viewport = createViewport();
        const pdfPage = createPageProxy(vi.fn(async () => [{
            id: 'stamp-1',
            annotationType: 13,
            rect: [
                0,
                0,
                10,
                10,
            ],
            noHTML: false,
        }]));
        const annotationLayerDiv = createAnnotationLayerDiv();
        const annotationCanvasMap = new Map<string, HTMLCanvasElement>([[
            'stamp-1',
            {} as HTMLCanvasElement,
        ]]);

        await renderer.renderAnnotationLayer(
            pdfPage,
            annotationLayerDiv,
            viewport,
            requirePageNumber(1),
            annotationCanvasMap,
        );

        expect(annotationLayerCtor).toHaveBeenCalledWith(expect.objectContaining({
            annotationCanvasMap,
            div: annotationLayerDiv,
            page: pdfPage,
            viewport,
        }));
        expect(annotationLayerRender).toHaveBeenCalledWith(expect.objectContaining({
            annotations: expect.arrayContaining([expect.objectContaining({ id: 'stamp-1' })]),
            div: annotationLayerDiv,
            page: pdfPage,
            viewport,
        }));
    });

    it('keeps the current annotation DOM mounted while PDF.js fetches replacement annotations', async () => {
        const annotations = Promise.withResolvers<unknown[]>();
        const renderer = usePdfAnnotationLayerRenderer({
            numPages: ref(3),
            currentPage: ref(1),
            pdfDocument: shallowRef<PDFDocumentProxy | null>(createPdfDocumentProxy()),
            showAnnotations: ref(true),
            annotationUiManager: shallowRef<AnnotationEditorUIManager | null>(null),
            annotationL10n: ref(null),
        });
        const viewport = createViewport();
        const pdfPage = createPageProxy(vi.fn(() => annotations.promise));
        const annotationLayerDiv = createAnnotationLayerDiv('<section class="underlineAnnotation"></section>');

        const renderPromise = renderer.renderAnnotationLayer(
            pdfPage,
            annotationLayerDiv,
            viewport,
            requirePageNumber(1),
        );
        await Promise.resolve();

        expect(annotationLayerDiv.innerHTML).toContain('underlineAnnotation');

        annotations.resolve([{
            id: 'underline-1',
            annotationType: 10,
            noHTML: false,
        }]);
        await renderPromise;
    });

    it('aborts annotation rendering on document switch before mutating DOM', async () => {
        const annotations = Promise.withResolvers<unknown[]>();
        let documentVersion = 1;
        const abortController = new AbortController();
        const renderer = usePdfAnnotationLayerRenderer({
            numPages: ref(3),
            currentPage: ref(1),
            pdfDocument: shallowRef<PDFDocumentProxy | null>(createPdfDocumentProxy()),
            showAnnotations: ref(true),
            annotationUiManager: shallowRef<AnnotationEditorUIManager | null>(null),
            annotationL10n: ref(null),
            getDocumentVersion: () => documentVersion,
        });
        const viewport = createViewport();
        const pdfPage = createPageProxy(vi.fn(() => annotations.promise));
        const annotationLayerDiv = createAnnotationLayerDiv('<section class="existingAnnotation"></section>');

        const renderPromise = renderer.renderAnnotationLayer(
            pdfPage,
            annotationLayerDiv,
            viewport,
            requirePageNumber(1),
            null,
            {
                documentVersion: 1,
                signal: abortController.signal,
            },
        ).catch(error => error as Error);
        await Promise.resolve();

        documentVersion = 2;
        abortController.abort();

        const error = await renderPromise;
        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) {
            throw new TypeError('Expected annotation layer render to reject');
        }
        expect(error.name).toBe('AbortError');
        expect(annotationLayerRender).not.toHaveBeenCalled();
        expect(annotationLayerDiv.innerHTML).toContain('existingAnnotation');

        annotations.resolve([]);
    });

    it('serializes hidden annotation UI manager guards and restores original methods', async () => {
        const firstRender = Promise.withResolvers<undefined>();
        const secondRender = Promise.withResolvers<undefined>();
        const originalRenderAnnotationElement = vi.fn();
        const originalSetMissingCanvas = vi.fn();
        const annotationUiManager = {
            renderAnnotationElement: originalRenderAnnotationElement,
            setMissingCanvas: originalSetMissingCanvas,
        };
        annotationLayerRender
            .mockImplementationOnce(async () => {
                annotationUiManager.renderAnnotationElement({ data: { id: 'hidden-1' } });
                await firstRender.promise;
            })
            .mockImplementationOnce(async () => {
                annotationUiManager.renderAnnotationElement({ data: { id: 'visible-1' } });
                await secondRender.promise;
            });

        const renderer = usePdfAnnotationLayerRenderer({
            numPages: ref(3),
            currentPage: ref(1),
            pdfDocument: shallowRef<PDFDocumentProxy | null>(createPdfDocumentProxy()),
            showAnnotations: ref(true),
            hiddenAnnotationIds: ref(new Set(['hidden-1'])),
            annotationUiManager: createAnnotationUiManagerRef(annotationUiManager),
            annotationL10n: ref(null),
        });
        const viewport = createViewport();
        const pdfPage = createPageProxy(vi.fn(async () => []));
        const annotationLayerDiv = createAnnotationLayerDiv();

        const firstPromise = renderer.renderAnnotationLayer(
            pdfPage,
            annotationLayerDiv,
            viewport,
            requirePageNumber(1),
        );
        const secondPromise = renderer.renderAnnotationLayer(
            pdfPage,
            annotationLayerDiv,
            viewport,
            requirePageNumber(2),
        );

        await vi.waitFor(() => {
            expect(annotationLayerRender).toHaveBeenCalledTimes(1);
        });
        expect(originalRenderAnnotationElement).not.toHaveBeenCalled();

        firstRender.resolve(undefined);
        await vi.waitFor(() => {
            expect(annotationLayerRender).toHaveBeenCalledTimes(2);
        });
        secondRender.resolve(undefined);
        await Promise.all([
            firstPromise,
            secondPromise,
        ]);

        expect(originalRenderAnnotationElement).toHaveBeenCalledTimes(1);
        expect(originalRenderAnnotationElement).toHaveBeenCalledWith({ data: { id: 'visible-1' } });
        expect(annotationUiManager.renderAnnotationElement).toBe(originalRenderAnnotationElement);
        expect(annotationUiManager.setMissingCanvas).toBe(originalSetMissingCanvas);
    });

    it('releases hidden annotation UI manager guards when a render is aborted', async () => {
        const stuckRender = Promise.withResolvers<undefined>();
        const originalRenderAnnotationElement = vi.fn();
        const originalSetMissingCanvas = vi.fn();
        const annotationUiManager = {
            renderAnnotationElement: originalRenderAnnotationElement,
            setMissingCanvas: originalSetMissingCanvas,
        };
        annotationLayerRender
            .mockImplementationOnce(async () => {
                await stuckRender.promise;
            })
            .mockResolvedValueOnce(undefined);

        const renderer = usePdfAnnotationLayerRenderer({
            numPages: ref(3),
            currentPage: ref(1),
            pdfDocument: shallowRef<PDFDocumentProxy | null>(createPdfDocumentProxy()),
            showAnnotations: ref(true),
            hiddenAnnotationIds: ref(new Set(['hidden-1'])),
            annotationUiManager: createAnnotationUiManagerRef(annotationUiManager),
            annotationL10n: ref(null),
        });
        const viewport = createViewport();
        const pdfPage = createPageProxy(vi.fn(async () => []));
        const annotationLayerDiv = createAnnotationLayerDiv();
        const abortController = new AbortController();

        const abortedRender = renderer.renderAnnotationLayer(
            pdfPage,
            annotationLayerDiv,
            viewport,
            requirePageNumber(1),
            null,
            { signal: abortController.signal },
        ).catch(error => error as Error);
        await vi.waitFor(() => {
            expect(annotationLayerRender).toHaveBeenCalledTimes(1);
        });

        abortController.abort();
        const abortError = await abortedRender;
        expect(abortError).toBeInstanceOf(Error);
        expect(abortError).toMatchObject({ name: 'AbortError' });
        expect(annotationUiManager.renderAnnotationElement).not.toBe(originalRenderAnnotationElement);
        expect(annotationUiManager.setMissingCanvas).not.toBe(originalSetMissingCanvas);

        const quarantinedRender = await renderer.renderAnnotationLayer(
            pdfPage,
            annotationLayerDiv,
            viewport,
            requirePageNumber(2),
        );
        expect(quarantinedRender).toBeNull();
        expect(annotationLayerRender).toHaveBeenCalledTimes(1);

        stuckRender.resolve(undefined);
        await vi.waitFor(() => {
            expect(annotationUiManager.renderAnnotationElement).toBe(originalRenderAnnotationElement);
        });

        const nextRender = renderer.renderAnnotationLayer(
            pdfPage,
            annotationLayerDiv,
            viewport,
            requirePageNumber(3),
        );
        await vi.waitFor(() => {
            expect(annotationLayerRender).toHaveBeenCalledTimes(2);
        });
        await nextRender;

        expect(annotationUiManager.renderAnnotationElement).toBe(originalRenderAnnotationElement);
        expect(annotationUiManager.setMissingCanvas).toBe(originalSetMissingCanvas);
    });

    it('keeps queued guards serialized when a waiting render is aborted', async () => {
        const activeRender = Promise.withResolvers<undefined>();
        const originalRenderAnnotationElement = vi.fn();
        const annotationUiManager = { renderAnnotationElement: originalRenderAnnotationElement };
        annotationLayerRender
            .mockImplementationOnce(async () => {
                await activeRender.promise;
            })
            .mockResolvedValueOnce(undefined);
        const renderer = usePdfAnnotationLayerRenderer({
            numPages: ref(3),
            currentPage: ref(1),
            pdfDocument: shallowRef<PDFDocumentProxy | null>(createPdfDocumentProxy()),
            showAnnotations: ref(true),
            hiddenAnnotationIds: ref(new Set(['hidden-1'])),
            annotationUiManager: createAnnotationUiManagerRef(annotationUiManager),
            annotationL10n: ref(null),
        });
        const viewport = createViewport();
        const pdfPage = createPageProxy(vi.fn(async () => []));
        const annotationLayerDiv = createAnnotationLayerDiv();
        const waitingAbortController = new AbortController();

        const firstRender = renderer.renderAnnotationLayer(
            pdfPage,
            annotationLayerDiv,
            viewport,
            requirePageNumber(1),
        );
        await vi.waitFor(() => {
            expect(annotationLayerRender).toHaveBeenCalledTimes(1);
        });
        const waitingRender = renderer.renderAnnotationLayer(
            pdfPage,
            annotationLayerDiv,
            viewport,
            requirePageNumber(2),
            null,
            { signal: waitingAbortController.signal },
        ).catch(error => error as Error);
        await vi.waitFor(() => {
            expect(annotationLayerCtor).toHaveBeenCalledTimes(2);
        });
        waitingAbortController.abort();
        expect(await waitingRender).toMatchObject({ name: 'AbortError' });

        const thirdRender = renderer.renderAnnotationLayer(
            pdfPage,
            annotationLayerDiv,
            viewport,
            requirePageNumber(3),
        );
        await Promise.resolve();
        expect(annotationLayerRender).toHaveBeenCalledTimes(1);

        activeRender.resolve(undefined);
        await Promise.all([
            firstRender,
            thirdRender,
        ]);
        expect(annotationLayerRender).toHaveBeenCalledTimes(2);
        expect(annotationUiManager.renderAnnotationElement).toBe(originalRenderAnnotationElement);
    });

    it('parses a page proxy annotations once across re-renders of the same page', async () => {
        const renderer = usePdfAnnotationLayerRenderer({
            numPages: ref(3),
            currentPage: ref(1),
            pdfDocument: shallowRef<PDFDocumentProxy | null>(createPdfDocumentProxy()),
            showAnnotations: ref(true),
            annotationUiManager: shallowRef<AnnotationEditorUIManager | null>(null),
            annotationL10n: ref(null),
        });
        const annotationLayerDiv = createAnnotationLayerDiv();
        const createPage = () => createPageProxy(vi.fn(async () => [{
            id: 'link-1',
            annotationType: 2,
            rect: [
                0,
                0,
                10,
                10,
            ],
            noHTML: false,
        }]));
        const pdfPage = createPage();
        const reloadedPdfPage = createPage();
        const renderAt = (page: PDFPageProxy, scale: number) => renderer.renderAnnotationLayer(
            page,
            annotationLayerDiv,
            createViewport(200 * scale, 300 * scale),
            requirePageNumber(1),
        );

        await renderAt(pdfPage, 1);
        await renderAt(pdfPage, 2);
        await renderAt(reloadedPdfPage, 2);

        expect(pdfPage.getAnnotations).toHaveBeenCalledTimes(1);
        expect(reloadedPdfPage.getAnnotations).toHaveBeenCalledTimes(1);
        expect(annotationLayerRender).toHaveBeenCalledTimes(3);
    });
});
