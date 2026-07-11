import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    flattenDocumentOutline,
    searchDocumentText,
} from '@app/utils/document-viewer/providers/documentSourceNavigation';
import type {IDocumentPageSource} from '@app/utils/document-viewer/source/documentPageSource';

function createSource(): IDocumentPageSource {
    return {
        kind: 'djvu',
        documentRef: '/tmp/book.djvu',
        pageCount: 3,
        textProvider: {getPageText: vi.fn(async page => page === 2 ? 'A searchable DjVu chapter' : 'other text')},
        getPageMetrics: vi.fn(),
        renderPage: vi.fn(),
        dispose: vi.fn(),
    };
}

describe('document source navigation providers', () => {
    it('flattens nested source outlines without losing navigation destinations', () => {
        expect(flattenDocumentOutline([{
            title: 'Part',
            pageNumber: 1,
            children: [{
                title: 'Chapter',
                pageNumber: 2,
                children: [],
            }],
        }])).toEqual([
            {
                title: 'Part',
                pageNumber: 1,
                depth: 0,
            },
            {
                title: 'Chapter',
                pageNumber: 2,
                depth: 1,
            },
        ]);
    });

    it('searches source text page-by-page and returns navigation-level results', async () => {
        const source = createSource();
        const results = await searchDocumentText(source, 'SEARCHABLE', new AbortController().signal);

        expect(results).toEqual([{
            pageNumber: 2,
            excerpt: 'A searchable DjVu chapter',
        }]);
        expect(source.textProvider?.getPageText).toHaveBeenCalledTimes(3);
    });

    it('honors cancellation before reading another source page', async () => {
        const source = createSource();
        const controller = new AbortController();
        controller.abort();
        await expect(searchDocumentText(source, 'text', controller.signal)).rejects.toThrow();
        expect(source.textProvider?.getPageText).not.toHaveBeenCalled();
    });
});
