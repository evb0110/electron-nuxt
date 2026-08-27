import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const resolveDocumentTextCatalogMock = vi.hoisted(() => vi.fn());
const resolveDocumentTextCatalogWindowMock = vi.hoisted(() => vi.fn());

vi.mock('@app/utils/getOcrCapability', () => ({getOcrCapability: () => ({
    resolveDocumentTextCatalog: resolveDocumentTextCatalogMock,
    resolveDocumentTextCatalogWindow: resolveDocumentTextCatalogWindowMock,
})}));
vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {warn: vi.fn()}}));

const {
    loadOcrText,
    prepareDocumentTextCatalogTextPages,
} = await import('@app/utils/ocr/loadOcrText');
const TEST_DOCUMENT_REVISION = 'revision-token';

describe('loadOcrText', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resolveDocumentTextCatalogMock.mockResolvedValue({
            documentRevision: TEST_DOCUMENT_REVISION,
            pageCount: 17,
            pages: Array.from({length: 17}, (_value, index) => ({
                pageNumber: index + 1,
                text: `Page ${index + 1}`,
                source: 'evb-ocr',
                contentDigest: `digest-${index + 1}`,
            })),
            contentDigest: 'snapshot-digest',
        });
        resolveDocumentTextCatalogWindowMock.mockImplementation(async (
            _path: string,
            documentRevision: string,
            firstPage: number,
            lastPage: number,
            pageCount: number,
        ) => ({
            documentRevision,
            pageCount,
            firstPage,
            lastPage,
            pages: [{
                pageNumber: firstPage,
                text: `Page ${firstPage}`,
                source: 'evb-ocr',
                contentDigest: `digest-${firstPage}`,
            }],
            contentDigest: `window-${firstPage}`,
        }));
    });

    it('reads all canonical pages through the production catalog capability', async () => {
        await expect(loadOcrText('/tmp/work.pdf', TEST_DOCUMENT_REVISION)).resolves.toContain('Page 17');
        expect(resolveDocumentTextCatalogMock).toHaveBeenCalledWith('/tmp/work.pdf', TEST_DOCUMENT_REVISION);
    });

    it('does not fall back to renderer-side artifacts', async () => {
        resolveDocumentTextCatalogMock.mockResolvedValue({
            documentRevision: TEST_DOCUMENT_REVISION,
            pageCount: 1,
            pages: [],
            contentDigest: 'empty',
        });
        await expect(loadOcrText('/tmp/work.pdf', TEST_DOCUMENT_REVISION)).resolves.toBeNull();
    });

    it('opens only the first bounded window for a lazy 100,001-page DOCX stream', async () => {
        const pageStream = await prepareDocumentTextCatalogTextPages(
            '/tmp/work.pdf',
            TEST_DOCUMENT_REVISION,
            100_001,
        );
        expect(pageStream).not.toBeNull();
        expect(resolveDocumentTextCatalogWindowMock).toHaveBeenCalledTimes(1);
        expect(resolveDocumentTextCatalogWindowMock).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            TEST_DOCUMENT_REVISION,
            1,
            64,
            100_001,
        );

        const iterator = pageStream![Symbol.asyncIterator]();
        await expect(iterator.next()).resolves.toMatchObject({
            done: false,
            value: 'Page 1',
        });
        expect(resolveDocumentTextCatalogWindowMock).toHaveBeenCalledTimes(1);
    });
});
