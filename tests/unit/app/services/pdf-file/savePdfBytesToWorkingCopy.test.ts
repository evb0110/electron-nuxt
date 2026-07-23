import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { savePdfBytesToWorkingCopy } from '@app/services/pdf-file/savePdfBytesToWorkingCopy';
import {requireDocumentRevisionToken} from '@contracts';

const mocks = vi.hoisted(() => ({
    documentFiles: {
        saveFileStructured: vi.fn(),
        savePdfData: undefined as undefined | ReturnType<typeof vi.fn>,
        writeFile: vi.fn(),
    },
    documentPdf: { validatePdfData: vi.fn() },
    legacyDocuments: {
        saveFileStructured: vi.fn(() => {
            throw new Error('legacy saveFileStructured should not be used');
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

const SERIALIZED_SAVE_OPTIONS = { expectedDocumentRevisionToken: requireDocumentRevisionToken('drt1:test:serialized-base') };

describe('savePdfBytesToWorkingCopy', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.documentFiles.saveFileStructured.mockResolvedValue({
            ok: true,
            externalWriteCommitted: true,
            workingCopyRefreshed: true,
            validation: null,
        });
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

        const result = await savePdfBytesToWorkingCopy('/tmp/working.pdf', data, SERIALIZED_SAVE_OPTIONS);

        expect(result).toBe(validation);
        expect(savePdfData).toHaveBeenCalledWith(
            '/tmp/working.pdf',
            data,
            SERIALIZED_SAVE_OPTIONS,
            undefined,
        );
        expect(mocks.documentPdf.validatePdfData).not.toHaveBeenCalled();
        expect(mocks.documentFiles.writeFile).not.toHaveBeenCalled();
        expect(mocks.documentFiles.saveFileStructured).not.toHaveBeenCalled();
        expect(mocks.legacyDocuments.savePdfData).not.toHaveBeenCalled();
    });

    it('validates before writing and saving through split capabilities', async () => {
        const data = new Uint8Array([
            1,
            2,
            3,
        ]);

        const result = await savePdfBytesToWorkingCopy('/tmp/working.pdf', data, SERIALIZED_SAVE_OPTIONS);

        expect(result).toEqual({
            isValid: true,
            errors: [],
        });
        expect(mocks.documentPdf.validatePdfData).toHaveBeenCalledWith(data);
        expect(mocks.documentFiles.writeFile).toHaveBeenCalledWith('/tmp/working.pdf', data, SERIALIZED_SAVE_OPTIONS);
        expect(mocks.documentFiles.saveFileStructured).toHaveBeenCalledWith('/tmp/working.pdf', SERIALIZED_SAVE_OPTIONS);
        expect(mocks.legacyDocuments.validatePdfData).not.toHaveBeenCalled();
        expect(mocks.legacyDocuments.writeFile).not.toHaveBeenCalled();
        expect(mocks.legacyDocuments.saveFileStructured).not.toHaveBeenCalled();
    });

    it('returns a failed validation result when the target save is canceled', async () => {
        mocks.documentFiles.saveFileStructured.mockResolvedValueOnce({
            ok: false,
            reason: 'user-canceled',
            externalWriteCommitted: false,
            validation: null,
        });
        const data = new Uint8Array([
            4,
            5,
            6,
        ]);

        const result = await savePdfBytesToWorkingCopy('/tmp/working.pdf', data, SERIALIZED_SAVE_OPTIONS);

        expect(result).toEqual({
            isValid: false,
            errors: [],
        });
        expect(mocks.documentPdf.validatePdfData).toHaveBeenCalledWith(data);
        expect(mocks.documentFiles.writeFile).toHaveBeenCalledWith('/tmp/working.pdf', data, SERIALIZED_SAVE_OPTIONS);
        expect(mocks.documentFiles.saveFileStructured).toHaveBeenCalledWith('/tmp/working.pdf', SERIALIZED_SAVE_OPTIONS);
    });

    it('returns a failed validation result with the structured save failure message', async () => {
        mocks.documentFiles.saveFileStructured.mockResolvedValueOnce({
            ok: false,
            reason: 'write-failed',
            message: 'Browser write permission was not granted for this file.',
            externalWriteCommitted: false,
            validation: null,
        });
        const data = new Uint8Array([
            7,
            8,
            9,
        ]);

        const result = await savePdfBytesToWorkingCopy('/tmp/working.pdf', data, SERIALIZED_SAVE_OPTIONS);

        expect(result).toEqual({
            isValid: false,
            errors: ['Browser write permission was not granted for this file.'],
        });
        expect(mocks.documentPdf.validatePdfData).toHaveBeenCalledWith(data);
        expect(mocks.documentFiles.writeFile).toHaveBeenCalledWith('/tmp/working.pdf', data, SERIALIZED_SAVE_OPTIONS);
        expect(mocks.documentFiles.saveFileStructured).toHaveBeenCalledWith('/tmp/working.pdf', SERIALIZED_SAVE_OPTIONS);
    });

    it('returns a failed validation result with the structured save failure reason when no message is available', async () => {
        mocks.documentFiles.saveFileStructured.mockResolvedValueOnce({
            ok: false,
            reason: 'working-copy-missing',
            externalWriteCommitted: false,
            validation: null,
        });

        const result = await savePdfBytesToWorkingCopy(
            '/tmp/working.pdf',
            new Uint8Array([10]),
            SERIALIZED_SAVE_OPTIONS,
        );

        expect(result).toEqual({
            isValid: false,
            errors: ['working-copy-missing'],
        });
        expect(mocks.documentFiles.writeFile).toHaveBeenCalledWith(
            '/tmp/working.pdf',
            new Uint8Array([10]),
            SERIALIZED_SAVE_OPTIONS,
        );
        expect(mocks.documentFiles.saveFileStructured).toHaveBeenCalledWith('/tmp/working.pdf', SERIALIZED_SAVE_OPTIONS);
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
        expect(mocks.documentFiles.saveFileStructured).not.toHaveBeenCalled();
    });
});
