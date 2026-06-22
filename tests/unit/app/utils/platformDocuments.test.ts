import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    BROWSER_DOCUMENT_FULL_READ_TOO_LARGE,
    BrowserDocumentReadError,
} from '@app/platform/browser/browserDocumentReadError';

const documentsMock = vi.hoisted(() => ({
    readFile: vi.fn(),
    statFile: vi.fn(),
    readFileRange: vi.fn(),
}));

const getPlatformApiMock = vi.hoisted(() => vi.fn<() => unknown>(() => ({ documents: documentsMock })));
const yieldToBrowserMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@app/utils/platform', () => ({ getPlatformAPI: () => getPlatformApiMock() }));

vi.mock('@app/utils/yieldToBrowser', () => ({ yieldToBrowser: yieldToBrowserMock }));

describe('platformDocuments', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getPlatformApiMock.mockReturnValue({ documents: documentsMock });
    });

    it('returns the shared documents capability from the platform api', async () => {
        const documentsCapability = { savePdfAs: vi.fn() };
        getPlatformApiMock.mockReturnValueOnce({ documents: documentsCapability });

        const { getDocumentsCapability } = await import('@app/utils/platformDocuments');

        expect(getDocumentsCapability()).toBe(documentsCapability);
    });

    it('detects when native print is unavailable for the active platform capability', async () => {
        const { isNativePrintCapabilityUnavailable } = await import('@app/utils/platformDocuments');

        expect(isNativePrintCapabilityUnavailable({
            success: false,
            error: 'Printing via the native desktop dialog is unavailable in the browser capability',
        })).toBe(true);
        expect(isNativePrintCapabilityUnavailable({
            success: false,
            error: 'Printer offline',
        })).toBe(false);
        expect(isNativePrintCapabilityUnavailable({
            success: false,
            canceled: true,
        })).toBe(false);
    });

    it('refreshes the working copy after save-as only for browser-backed saved refs', async () => {
        const { shouldRefreshWorkingCopyAfterSaveAs } = await import('@app/utils/platformDocuments');

        expect(shouldRefreshWorkingCopyAfterSaveAs('browser://documents/source.pdf', 'browser://documents/working.pdf')).toBe(true);
        expect(shouldRefreshWorkingCopyAfterSaveAs('/tmp/source.pdf', '/tmp/working.pdf')).toBe(false);
        expect(shouldRefreshWorkingCopyAfterSaveAs('browser://documents/working.pdf', 'browser://documents/working.pdf')).toBe(false);
        expect(shouldRefreshWorkingCopyAfterSaveAs(null, 'browser://documents/working.pdf')).toBe(false);
    });

    it('returns the direct file read when the capability allows it', async () => {
        documentsMock.readFile.mockResolvedValueOnce(new Uint8Array([
            1,
            2,
            3,
        ]));

        const { readDocumentFileFully } = await import('@app/utils/platformDocuments');
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
        documentsMock.readFile.mockRejectedValueOnce(new BrowserDocumentReadError(
            BROWSER_DOCUMENT_FULL_READ_TOO_LARGE,
            'Browser document is too large to load fully into memory (huge.pdf: 128MB > 64MB limit)',
        ));
        documentsMock.statFile.mockResolvedValueOnce({ size: (largeChunkSize * 2) + 1 });
        documentsMock.readFileRange
            .mockResolvedValueOnce(new Uint8Array(largeChunkSize).fill(1))
            .mockResolvedValueOnce(new Uint8Array(largeChunkSize).fill(2))
            .mockResolvedValueOnce(new Uint8Array([3]));

        const { readDocumentFileFully } = await import('@app/utils/platformDocuments');
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

    it('fails the fallback read when a range read returns no bytes before EOF', async () => {
        documentsMock.readFile.mockRejectedValueOnce(new BrowserDocumentReadError(
            BROWSER_DOCUMENT_FULL_READ_TOO_LARGE,
            'Browser document is too large to load fully into memory (huge.pdf: 128MB > 64MB limit)',
        ));
        documentsMock.statFile.mockResolvedValueOnce({ size: 4 });
        documentsMock.readFileRange.mockResolvedValueOnce(new Uint8Array());

        const { readDocumentFileFully } = await import('@app/utils/platformDocuments');
        await expect(readDocumentFileFully('browser://huge.pdf')).rejects.toThrow(
            'Range read returned no bytes before EOF at offset 0 of 4',
        );

        expect(documentsMock.readFileRange).toHaveBeenCalledTimes(1);
        expect(yieldToBrowserMock).not.toHaveBeenCalled();
    });

    it('does not swallow unrelated read failures', async () => {
        documentsMock.readFile.mockRejectedValueOnce(new Error('Permission denied'));

        const { readDocumentFileFully } = await import('@app/utils/platformDocuments');
        await expect(readDocumentFileFully('browser://forbidden.pdf')).rejects.toThrow('Permission denied');

        expect(documentsMock.statFile).not.toHaveBeenCalled();
        expect(documentsMock.readFileRange).not.toHaveBeenCalled();
    });

    it('does not fall back for unrelated errors that reuse the old browser limit text', async () => {
        documentsMock.readFile.mockRejectedValueOnce(new Error(
            'Browser document is too large to load fully into memory (not actually typed)',
        ));

        const { readDocumentFileFully } = await import('@app/utils/platformDocuments');
        await expect(readDocumentFileFully('browser://huge.pdf')).rejects.toThrow(
            'Browser document is too large to load fully into memory',
        );

        expect(documentsMock.statFile).not.toHaveBeenCalled();
        expect(documentsMock.readFileRange).not.toHaveBeenCalled();
    });
});
