import {
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
    AnnotationEditorType: {},
    DrawLayer: class MockDrawLayer {
        destroy() {}
    },
}));

vi.mock('@app/utils/platformShell', () => ({ getShellCapability: () => ({ openExternal: vi.fn(async () => {}) }) }));

describe('usePdfAnnotationLayerRenderer', () => {
    it('passes the shared annotation canvas map to PDF.js so stamp appearances can render after reload', async () => {
        annotationLayerCtor.mockClear();
        annotationLayerRender.mockClear();

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
});
