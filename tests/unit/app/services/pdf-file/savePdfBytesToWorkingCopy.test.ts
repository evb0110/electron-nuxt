import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { savePdfBytesToWorkingCopy } from '@app/services/pdf-file/savePdfBytesToWorkingCopy';

const mocks = vi.hoisted(() => ({
    documentFiles: {
        saveFile: vi.fn(),
        savePdfData: undefined as undefined | ReturnType<typeof vi.fn>,
        writeFile: vi.fn(),
    },
    documentPdf: { validatePdfData: vi.fn() },
    legacyDocuments: {
        saveFile: vi.fn(() => {
            throw new Error('legacy saveFile should not be used');
        }),
        savePdfData: vi.fn(() => {
            throw new Error('legacy savePdfData should not be used');
        }),
        validatePdfData: vi.fn(() => {
            throw new Error('legacy validatePdfData should not be used');
        }),
        writeFile: vi.fn(() => {
            throw new Error('legacy writeFile should not be used');
        }),
    },
}));

vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentFilesCapability: () => mocks.documentFiles,
    getDocumentPdfCapability: () => mocks.documentPdf,
    getDocumentsCapability: () => mocks.legacyDocuments,
}));

describe('savePdfBytesToWorkingCopy', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.documentFiles.saveFile.mockResolvedValue(true);
        mocks.documentFiles.savePdfData = undefined;
        mocks.documentFiles.writeFile.mockResolvedValue(true);
        mocks.documentPdf.validatePdfData.mockResolvedValue({
            isValid: true,
            errors: [],
        });
    });

    afterEach(() => {
        mocks.documentFiles.savePdfData = undefined;
    });

    it('uses split file save-data fast path when available', async () => {
        const validation = {
            isValid: true,
            errors: [],
        };
        const savePdfData = vi.fn(async () => validation);
        mocks.documentFiles.savePdfData = savePdfData;
        const data = new Uint8Array([1]);

        const result = await savePdfBytesToWorkingCopy('/tmp/working.pdf', data);

        expect(result).toBe(validation);
        expect(savePdfData).toHaveBeenCalledWith('/tmp/working.pdf', data);
        expect(mocks.documentPdf.validatePdfData).not.toHaveBeenCalled();
        expect(mocks.documentFiles.writeFile).not.toHaveBeenCalled();
        expect(mocks.documentFiles.saveFile).not.toHaveBeenCalled();
        expect(mocks.legacyDocuments.savePdfData).not.toHaveBeenCalled();
    });

    it('validates before writing and saving through split capabilities', async () => {
        const data = new Uint8Array([
            1,
            2,
            3,
        ]);

        const result = await savePdfBytesToWorkingCopy('/tmp/working.pdf', data);

        expect(result).toEqual({
            isValid: true,
            errors: [],
        });
        expect(mocks.documentPdf.validatePdfData).toHaveBeenCalledWith(data);
        expect(mocks.documentFiles.writeFile).toHaveBeenCalledWith('/tmp/working.pdf', data);
        expect(mocks.documentFiles.saveFile).toHaveBeenCalledWith('/tmp/working.pdf');
        expect(mocks.legacyDocuments.validatePdfData).not.toHaveBeenCalled();
        expect(mocks.legacyDocuments.writeFile).not.toHaveBeenCalled();
        expect(mocks.legacyDocuments.saveFile).not.toHaveBeenCalled();
    });

    it('returns a failed validation result when the target save is canceled', async () => {
        mocks.documentFiles.saveFile.mockResolvedValueOnce(false);
        const data = new Uint8Array([
            4,
            5,
            6,
        ]);

        const result = await savePdfBytesToWorkingCopy('/tmp/working.pdf', data);

        expect(result).toEqual({
            isValid: false,
            errors: [],
        });
        expect(mocks.documentPdf.validatePdfData).toHaveBeenCalledWith(data);
        expect(mocks.documentFiles.writeFile).toHaveBeenCalledWith('/tmp/working.pdf', data);
        expect(mocks.documentFiles.saveFile).toHaveBeenCalledWith('/tmp/working.pdf');
    });

    it('returns invalid validation without writing or saving', async () => {
        mocks.documentPdf.validatePdfData.mockResolvedValueOnce({
            isValid: false,
            errors: ['broken'],
        });

        const result = await savePdfBytesToWorkingCopy('/tmp/working.pdf', new Uint8Array([9]));

        expect(result).toEqual({
            isValid: false,
            errors: ['broken'],
        });
        expect(mocks.documentFiles.writeFile).not.toHaveBeenCalled();
        expect(mocks.documentFiles.saveFile).not.toHaveBeenCalled();
    });
});
