import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { AnnotationMode } from '@app/services/pdfjs/runtime-lib';
import { usePdfCanvasRenderer } from '@app/composables/pdf/usePdfCanvasRenderer';

vi.mock('@app/services/pdfjs/runtime-lib', () => ({ AnnotationMode: { DISABLE: 0 } }));

describe('usePdfCanvasRenderer', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        delete (globalThis as Record<string, unknown>).document;
    });

    it('disables built-in annotation painting on the page canvas', async () => {
        const canvas = {
            width: 0,
            height: 0,
            style: {} as CSSStyleDeclaration,
            getContext: vi.fn(() => ({})),
            remove: vi.fn(),
        };
        (globalThis as Record<string, unknown>).document = { createElement: vi.fn(() => canvas) };

        const renderTask = {
            cancel: vi.fn(),
            promise: Promise.resolve(),
        };
        const pdfPage = {
            pageNumber: 1,
            getViewport: vi.fn(() => ({
                width: 200,
                height: 100,
                userUnit: 1,
                rawDims: {
                    pageWidth: 200,
                    pageHeight: 100,
                },
            })),
            render: vi.fn(() => renderTask),
        } as const;

        const renderer = usePdfCanvasRenderer({ outputScale: 1 });
        await renderer.renderCanvas(pdfPage as never, 1);

        expect(pdfPage.render).toHaveBeenCalledWith(expect.objectContaining({
            annotationMode: AnnotationMode?.DISABLE ?? 0,
            canvas,
        }));
    });
});
