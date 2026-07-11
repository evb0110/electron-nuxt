import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { searchDocumentTextProvider } from '@app/utils/document-viewer/providers/searchDocumentTextProvider';

describe('searchDocumentTextProvider', () => {
    it('searches pages sequentially and returns bounded context', async () => {
        const getPageText = vi.fn()
            .mockResolvedValueOnce('first page')
            .mockResolvedValueOnce('A searchable DjVu phrase appears here.');

        const results = await searchDocumentTextProvider({
            provider: {getPageText},
            pageCount: 2,
            query: 'djvu',
            signal: new AbortController().signal,
        });

        expect(results).toEqual([{
            pageNumber: 2,
            excerpt: 'A searchable DjVu phrase appears here.',
        }]);
        expect(getPageText).toHaveBeenCalledTimes(2);
    });

    it('stops before reading a page when cancelled', async () => {
        const controller = new AbortController();
        controller.abort();
        const getPageText = vi.fn();

        await expect(searchDocumentTextProvider({
            provider: {getPageText},
            pageCount: 3,
            query: 'text',
            signal: controller.signal,
        })).rejects.toMatchObject({name: 'AbortError'});
        expect(getPageText).not.toHaveBeenCalled();
    });
});
