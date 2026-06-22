import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { savePdfBytesAs } from '@app/services/pdf-file/savePdfBytesAs';

const mocks = vi.hoisted(() => ({documentsCapability: {
    cleanupFile: vi.fn(),
    createWorkingCopyFromData: vi.fn(),
    savePdfAs: vi.fn(),
    savePdfDataAs: undefined,
    validatePdfData: vi.fn(),
    writeFile: vi.fn(),
}}));

vi.mock('@app/utils/platformDocuments', () => ({ getDocumentsCapability: () => mocks.documentsCapability }));

describe('savePdfBytesAs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.documentsCapability.cleanupFile.mockResolvedValue(undefined);
        mocks.documentsCapability.createWorkingCopyFromData.mockResolvedValue('/tmp/staged.pdf');
        mocks.documentsCapability.savePdfAs.mockResolvedValue('/tmp/saved.pdf');
        mocks.documentsCapability.savePdfDataAs = undefined;
        mocks.documentsCapability.validatePdfData.mockResolvedValue({
            isValid: true,
            errors: [],
        });
        mocks.documentsCapability.writeFile.mockResolvedValue(undefined);
    });

    it('stages fallback Save As bytes without mutating the active working copy', async () => {
        const data = new Uint8Array([
            1,
            2,
            3,
        ]);

        const result = await savePdfBytesAs('/tmp/active.pdf', data);

        expect(result.path).toBe('/tmp/saved.pdf');
        expect(mocks.documentsCapability.writeFile).not.toHaveBeenCalled();
        expect(mocks.documentsCapability.createWorkingCopyFromData).toHaveBeenCalledWith(
            'active.pdf',
            data,
        );
        expect(mocks.documentsCapability.savePdfAs).toHaveBeenCalledWith('/tmp/staged.pdf');
        expect(mocks.documentsCapability.cleanupFile).toHaveBeenCalledWith('/tmp/staged.pdf');
    });

    it('leaves the active working copy untouched when fallback Save As fails', async () => {
        mocks.documentsCapability.savePdfAs.mockRejectedValueOnce(new Error('canceled'));

        await expect(savePdfBytesAs('/tmp/active.pdf', new Uint8Array([1]))).rejects.toThrow('canceled');

        expect(mocks.documentsCapability.writeFile).not.toHaveBeenCalled();
        expect(mocks.documentsCapability.cleanupFile).toHaveBeenCalledWith('/tmp/staged.pdf');
    });
});
