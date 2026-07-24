import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { savePdfBytesAs } from '@app/services/pdf-file/savePdfBytesAs';
import {requireDocumentRevisionToken} from '@contracts';

const mocks = vi.hoisted(() => ({
    documentFiles: {
        getDocumentRevision: vi.fn(),
        savePdfAs: vi.fn(),
        savePdfDataAs: undefined as undefined | ReturnType<typeof vi.fn>,
        writeFile: vi.fn(),
    },
    documentPdf: { validatePdfData: vi.fn() },
    documentWorkingCopy: {
        cleanupFile: vi.fn(),
        createWorkingCopyFromData: vi.fn(),
    },
}));

vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentFilesCapability: () => mocks.documentFiles,
    getDocumentPdfCapability: () => mocks.documentPdf,
    getDocumentWorkingCopyCapability: () => mocks.documentWorkingCopy,
}));

const SERIALIZED_SAVE_OPTIONS = { expectedDocumentRevisionToken: requireDocumentRevisionToken('drt1:test:serialized-base') };
const STAGED_REVISION = {
    authority: 'browser-working-copy' as const,
    contentRevision: 1,
    documentRef: '/tmp/staged.pdf',
    mintedAt: 1,
    token: requireDocumentRevisionToken('drt1:test:staged-base'),
    version: 1,
};

describe('savePdfBytesAs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.documentFiles.savePdfAs.mockResolvedValue('/tmp/saved.pdf');
        mocks.documentFiles.savePdfDataAs = undefined;
        mocks.documentFiles.getDocumentRevision.mockResolvedValue(STAGED_REVISION);
        mocks.documentFiles.writeFile.mockResolvedValue(undefined);
        mocks.documentPdf.validatePdfData.mockResolvedValue({
            isValid: true,
            errors: [],
        });
        mocks.documentWorkingCopy.cleanupFile.mockResolvedValue(undefined);
        mocks.documentWorkingCopy.createWorkingCopyFromData.mockResolvedValue('/tmp/staged.pdf');
    });

    afterEach(() => {
        mocks.documentFiles.savePdfDataAs = undefined;
    });

    it('uses split file save-data fast path when available', async () => {
        const savePdfDataAs = vi.fn(async () => ({
            path: '/tmp/fast.pdf',
            validation: {
                isValid: true,
                errors: [],
            },
        }));
        mocks.documentFiles.savePdfDataAs = savePdfDataAs;
        const data = new Uint8Array([1]);
        const options = { optimizeLossless: true };

        const result = await savePdfBytesAs('/tmp/active.pdf', data, options, SERIALIZED_SAVE_OPTIONS);

        expect(result.path).toBe('/tmp/fast.pdf');
        expect(savePdfDataAs).toHaveBeenCalledWith(
            '/tmp/active.pdf',
            data,
            options,
            SERIALIZED_SAVE_OPTIONS,
            undefined,
        );
        expect(mocks.documentPdf.validatePdfData).not.toHaveBeenCalled();
        expect(mocks.documentWorkingCopy.createWorkingCopyFromData).not.toHaveBeenCalled();
    });

    it('stages fallback Save As bytes without mutating the active working copy', async () => {
        const data = new Uint8Array([
            1,
            2,
            3,
        ]);

        const result = await savePdfBytesAs('/tmp/active.pdf', data);

        expect(result.path).toBe('/tmp/saved.pdf');
        expect(mocks.documentFiles.writeFile).not.toHaveBeenCalled();
        expect(mocks.documentPdf.validatePdfData).toHaveBeenCalledWith(data);
        expect(mocks.documentWorkingCopy.createWorkingCopyFromData).toHaveBeenCalledWith(
            'active.pdf',
            data,
        );
        expect(mocks.documentFiles.getDocumentRevision).toHaveBeenCalledWith('/tmp/staged.pdf');
        expect(mocks.documentFiles.savePdfAs).toHaveBeenCalledWith(
            '/tmp/staged.pdf',
            undefined,
            { expectedDocumentRevisionToken: STAGED_REVISION.token },
        );
        expect(mocks.documentWorkingCopy.cleanupFile).toHaveBeenCalledWith('/tmp/staged.pdf');
    });

    it('returns invalid fallback validation without staging or saving', async () => {
        mocks.documentPdf.validatePdfData.mockResolvedValueOnce({
            isValid: false,
            errors: ['broken'],
        });
        const data = new Uint8Array([9]);

        const result = await savePdfBytesAs('/tmp/active.pdf', data);

        expect(result).toEqual({
            path: null,
            validation: {
                isValid: false,
                errors: ['broken'],
            },
        });
        expect(mocks.documentWorkingCopy.createWorkingCopyFromData).not.toHaveBeenCalled();
        expect(mocks.documentFiles.savePdfAs).not.toHaveBeenCalled();
        expect(mocks.documentWorkingCopy.cleanupFile).not.toHaveBeenCalled();
    });

    it('leaves the active working copy untouched when fallback Save As fails', async () => {
        mocks.documentFiles.savePdfAs.mockRejectedValueOnce(new Error('canceled'));

        await expect(savePdfBytesAs('/tmp/active.pdf', new Uint8Array([1]))).rejects.toThrow('canceled');

        expect(mocks.documentFiles.writeFile).not.toHaveBeenCalled();
        expect(mocks.documentWorkingCopy.cleanupFile).toHaveBeenCalledWith('/tmp/staged.pdf');
    });
});
