import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const documentsMock = {
    readFile: vi.fn(),
    statFile: vi.fn(),
    readFileRange: vi.fn(),
};

const yieldToBrowserMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@app/utils/platform', () => ({ getPlatformAPI: () => ({ documents: documentsMock }) }));

vi.mock('@app/platform/browser-api/browser-yield', () => ({ yieldToBrowser: yieldToBrowserMock }));

describe('readDocumentFileFully', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns the direct file read when the capability allows it', async () => {
        documentsMock.readFile.mockResolvedValueOnce(new Uint8Array([
            1,
            2,
            3,
        ]));

        const { readDocumentFileFully } = await import('@app/utils/platform-documents');
        await expect(readDocumentFileFully('browser://small.pdf')).resolves.toEqual(new Uint8Array([
            1,
            2,
            3,
        ]));

        expect(documentsMock.statFile).not.toHaveBeenCalled();
        expect(documentsMock.readFileRange).not.toHaveBeenCalled();
    });

    it('reassembles a large browser document from range reads after the full-read limit error', async () => {
        const largeChunkSize = 4 * 1024 * 1024;
        documentsMock.readFile.mockRejectedValueOnce(new Error(
            'Browser document is too large to load fully into memory (huge.pdf: 128MB > 64MB limit)',
        ));
        documentsMock.statFile.mockResolvedValueOnce({ size: (largeChunkSize * 2) + 1 });
        documentsMock.readFileRange
            .mockResolvedValueOnce(new Uint8Array(largeChunkSize).fill(1))
            .mockResolvedValueOnce(new Uint8Array(largeChunkSize).fill(2))
            .mockResolvedValueOnce(new Uint8Array([3]));

        const { readDocumentFileFully } = await import('@app/utils/platform-documents');
        const result = await readDocumentFileFully('browser://huge.pdf');

        expect(result.byteLength).toBe((largeChunkSize * 2) + 1);
        expect(result[0]).toBe(1);
        expect(result[largeChunkSize - 1]).toBe(1);
        expect(result[largeChunkSize]).toBe(2);
        expect(result[(largeChunkSize * 2) - 1]).toBe(2);
        expect(result.at(-1)).toBe(3);
        expect(documentsMock.statFile).toHaveBeenCalledWith('browser://huge.pdf');
        expect(documentsMock.readFileRange).toHaveBeenCalledTimes(3);
        expect(yieldToBrowserMock).toHaveBeenCalledTimes(2);
    });

    it('yields between fallback chunks for larger range reads', async () => {
        documentsMock.readFile.mockRejectedValueOnce(new Error(
            'Browser document is too large to load fully into memory (huge.pdf: 128MB > 64MB limit)',
        ));
        documentsMock.statFile.mockResolvedValueOnce({ size: (4 * 1024 * 1024 * 2) + 2 });
        documentsMock.readFileRange
            .mockResolvedValueOnce(new Uint8Array(4 * 1024 * 1024).fill(1))
            .mockResolvedValueOnce(new Uint8Array(4 * 1024 * 1024).fill(2))
            .mockResolvedValueOnce(new Uint8Array([
                3,
                4,
            ]));

        const { readDocumentFileFully } = await import('@app/utils/platform-documents');
        const result = await readDocumentFileFully('browser://huge.pdf');

        expect(result.byteLength).toBe((4 * 1024 * 1024 * 2) + 2);
        expect(yieldToBrowserMock).toHaveBeenCalledTimes(2);
    });

    it('does not swallow unrelated read failures', async () => {
        documentsMock.readFile.mockRejectedValueOnce(new Error('Permission denied'));

        const { readDocumentFileFully } = await import('@app/utils/platform-documents');
        await expect(readDocumentFileFully('browser://forbidden.pdf')).rejects.toThrow('Permission denied');

        expect(documentsMock.statFile).not.toHaveBeenCalled();
        expect(documentsMock.readFileRange).not.toHaveBeenCalled();
    });
});
