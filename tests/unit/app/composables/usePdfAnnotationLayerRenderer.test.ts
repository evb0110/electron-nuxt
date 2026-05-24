import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { usePdfAnnotationLayerRenderer } from '@app/composables/pdf/usePdfAnnotationLayerRenderer';

const annotationLayerCtor = vi.fn();
const annotationLayerRender = vi.fn(async (_options: unknown) => {});

vi.mock('@app/services/pdfjs/runtimeLib', () => ({
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
    },
    AnnotationEditorUIManager: class MockAnnotationEditorUIManager {
        readonly kind = 'mock';
    },
    AnnotationEditorType: {},
    DrawLayer: class MockDrawLayer {
        destroy() {}
    },
}));

vi.mock('@app/utils/platformShell', () => ({ getShellCapability: () => ({ openExternal: vi.fn(async () => {}) }) }));

describe('usePdfAnnotationLayerRenderer', () => {
    beforeEach(() => {
        annotationLayerCtor.mockClear();
        annotationLayerRender.mockClear();
    });

    it('passes the shared annotation canvas map to PDF.js so stamp appearances can render after reload', async () => {
        const renderer = usePdfAnnotationLayerRenderer({
            numPages: ref(3),
            currentPage: ref(1),
            pdfDocument: ref({ annotationStorage: {} } as never),
            showAnnotations: ref(true),
            annotationUiManager: ref(null),
            annotationL10n: ref(null),
        });

        const viewport = {
            width: 200,
            height: 300,
            rotation: 0,
        };
        const pdfPage = {getAnnotations: vi.fn(async () => [{
            id: 'stamp-1',
            annotationType: 13,
            rect: [
                0,
                0,
                10,
                10,
            ],
            noHTML: false,
        }])} as never;
        const annotationLayerDiv = { innerHTML: '' } as HTMLDivElement;
        const annotationCanvasMap = new Map<string, HTMLCanvasElement>([[
            'stamp-1',
            {} as HTMLCanvasElement,
        ]]);

        await renderer.renderAnnotationLayer(
            pdfPage,
            annotationLayerDiv,
            viewport as never,
            1,
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
            pdfDocument: ref({ annotationStorage: {} } as never),
            showAnnotations: ref(true),
            annotationUiManager: ref(null),
            annotationL10n: ref(null),
        });
        const viewport = {
            width: 200,
            height: 300,
            rotation: 0,
        };
        const pdfPage = {getAnnotations: vi.fn(() => annotations.promise)} as never;
        const annotationLayerDiv = {
            innerHTML: '<section class="underlineAnnotation"></section>',
            querySelectorAll: vi.fn(() => []),
        };

        const renderPromise = renderer.renderAnnotationLayer(
            pdfPage,
            annotationLayerDiv as never,
            viewport as never,
            1,
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
            pdfDocument: ref({ annotationStorage: {} } as never),
            showAnnotations: ref(true),
            hiddenAnnotationIds: ref(new Set(['hidden-1'])),
            annotationUiManager: ref(annotationUiManager as never),
            annotationL10n: ref(null),
        });
        const viewport = {
            width: 200,
            height: 300,
            rotation: 0,
        };
        const pdfPage = {getAnnotations: vi.fn(async () => [])} as never;
        const annotationLayerDiv = {
            innerHTML: '',
            querySelectorAll: vi.fn(() => []),
        };

        const firstPromise = renderer.renderAnnotationLayer(
            pdfPage,
            annotationLayerDiv as never,
            viewport as never,
            1,
        );
        const secondPromise = renderer.renderAnnotationLayer(
            pdfPage,
            annotationLayerDiv as never,
            viewport as never,
            2,
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
});
