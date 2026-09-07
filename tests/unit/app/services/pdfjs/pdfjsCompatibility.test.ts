import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    adaptPdfjsDocument,
    adaptPdfjsPage,
    adaptPdfjsViewport,
} from '@app/services/pdfjs/pdfjsCompatibility';
import type {IPdfViewport} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';

function createViewport(scale: number) {
    return {
        convertToViewportPoint: (x: number, y: number) => [
            x * scale,
            y * scale,
        ],
        clone: (options?: {scale?: number}) => createViewport(options?.scale ?? scale),
    };
}

describe('PDF.js compatibility adapters', () => {
    it('adds rectangle conversion and preserves adaptation through viewport clones', () => {
        const viewport = adaptPdfjsViewport(createViewport(2));

        expect(viewport.convertToViewportRectangle([
            1,
            2,
            3,
            4,
        ])).toEqual([
            2,
            4,
            6,
            8,
        ]);

        const clone = viewport.clone({scale: 3}) as IPdfViewport;
        expect(clone.convertToViewportRectangle([
            1,
            2,
            3,
            4,
        ])).toEqual([
            3,
            6,
            9,
            12,
        ]);
    });

    it('adapts every viewport returned by a PDF.js page', () => {
        const rawPage = {getViewport: vi.fn(({scale}: {scale: number}) => createViewport(scale))};
        const page = adaptPdfjsPage(rawPage);

        const viewport = page.getViewport({scale: 4}) as IPdfViewport;
        expect(viewport.convertToViewportRectangle([
            1,
            1,
            2,
            2,
        ])).toEqual([
            4,
            4,
            8,
            8,
        ]);
    });

    it('maps v6 document cleanup to the loading task destroy lifecycle', async () => {
        const cleanup = vi.fn(async () => {});
        const destroyLoadingTask = vi.fn(async () => {});
        const rawPage = {getViewport: vi.fn(() => createViewport(1))};
        const rawDocument = {
            cleanup,
            getPage: vi.fn(async () => rawPage),
        };
        const document = adaptPdfjsDocument(rawDocument, destroyLoadingTask);

        const page = await document.getPage(1);
        expect(page.getViewport({scale: 1}).convertToViewportRectangle([
            0,
            0,
            2,
            2,
        ])).toEqual([
            0,
            0,
            2,
            2,
        ]);

        await document.destroy();
        expect(cleanup).toHaveBeenCalledOnce();
        expect(destroyLoadingTask).toHaveBeenCalledOnce();
    });
});
