import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const resolveDocumentTextCatalogMock = vi.hoisted(() => vi.fn());

vi.mock('@app/utils/getOcrCapability', () => ({getOcrCapability: () => ({resolveDocumentTextCatalog: resolveDocumentTextCatalogMock})}));
vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {warn: vi.fn()}}));

const { loadOcrText } = await import('@app/utils/ocr/loadOcrText');
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
});
