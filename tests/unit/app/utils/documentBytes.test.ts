import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    readDocumentBytes,
    readDocumentBytesIfBelowLimit,
} from '@app/utils/documentBytes';

const mockDocuments = {
    statFile: vi.fn(),
    readFile: vi.fn(),
    readFileRange: vi.fn(),
};

vi.mock('@app/utils/platformDocuments', () => ({ getDocumentsCapability: () => mockDocuments }));

describe('documentBytes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockDocuments.statFile.mockReset();
        mockDocuments.readFile.mockReset();
        mockDocuments.readFileRange.mockReset();
    });

    it('uses direct reads for small files', async () => {
        const bytes = Uint8Array.from([
            1,
            2,
            3,
        ]);
        mockDocuments.statFile.mockResolvedValue({ size: bytes.byteLength });
        mockDocuments.readFile.mockResolvedValue(bytes);

        await expect(readDocumentBytes('/tmp/doc.pdf')).resolves.toEqual(bytes);
        expect(mockDocuments.readFile).toHaveBeenCalledWith('/tmp/doc.pdf');
        expect(mockDocuments.readFileRange).not.toHaveBeenCalled();
    });

    it('assembles large files from chunked range reads', async () => {
        const firstChunk = new Uint8Array(64 * 1024).fill(1);
        const secondChunk = new Uint8Array(64 * 1024).fill(2);
        const finalChunk = Uint8Array.from([
            3,
            4,
        ]);
        const expected = new Uint8Array(
            firstChunk.byteLength + secondChunk.byteLength + finalChunk.byteLength,
        );
        expected.set(firstChunk, 0);
        expected.set(secondChunk, firstChunk.byteLength);
        expected.set(finalChunk, firstChunk.byteLength + secondChunk.byteLength);

        mockDocuments.statFile.mockResolvedValue({ size: expected.byteLength });
        mockDocuments.readFileRange
            .mockResolvedValueOnce(firstChunk)
            .mockResolvedValueOnce(secondChunk)
            .mockResolvedValueOnce(finalChunk);

        await expect(readDocumentBytes('/tmp/doc.pdf', { chunkSize: 64 * 1024 })).resolves.toEqual(expected);
        expect(mockDocuments.readFile).not.toHaveBeenCalled();
        expect(mockDocuments.readFileRange).toHaveBeenNthCalledWith(1, '/tmp/doc.pdf', 0, 64 * 1024);
        expect(mockDocuments.readFileRange).toHaveBeenNthCalledWith(2, '/tmp/doc.pdf', 64 * 1024, 64 * 1024);
        expect(mockDocuments.readFileRange).toHaveBeenNthCalledWith(3, '/tmp/doc.pdf', 128 * 1024, 2);
    });

    it('returns null when the document exceeds the requested limit', async () => {
        mockDocuments.statFile.mockResolvedValue({ size: 100 });

        await expect(readDocumentBytesIfBelowLimit('/tmp/doc.pdf', 64)).resolves.toBeNull();
        expect(mockDocuments.readFile).not.toHaveBeenCalled();
        expect(mockDocuments.readFileRange).not.toHaveBeenCalled();
    });
});
