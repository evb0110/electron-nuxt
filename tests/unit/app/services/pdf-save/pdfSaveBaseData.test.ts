import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { getEmbeddedMutationBaseData } from '@app/services/pdf-save/pdfSaveBaseData';

describe('getEmbeddedMutationBaseData', () => {
    it('uses source bytes when there are no live PDF.js annotation changes', async () => {
        const saveDocument = vi.fn(async () => new Uint8Array([9]));
        const getSourcePdfData = vi.fn(async () => new Uint8Array([6]));

        const result = await getEmbeddedMutationBaseData({
            hasAnnotationChanges: () => false,
            saveDocument,
            getSourcePdfData,
        });

        expect(result).toEqual(new Uint8Array([6]));
        expect(getSourcePdfData).toHaveBeenCalledOnce();
        expect(saveDocument).not.toHaveBeenCalled();
    });

    it('materializes live PDF.js annotation changes before embedded mutations', async () => {
        const saveDocument = vi.fn(async () => new Uint8Array([9]));
        const getSourcePdfData = vi.fn(async () => new Uint8Array([6]));

        const result = await getEmbeddedMutationBaseData({
            hasAnnotationChanges: () => true,
            saveDocument,
            getSourcePdfData,
        });

        expect(result).toEqual(new Uint8Array([9]));
        expect(saveDocument).toHaveBeenCalledOnce();
        expect(getSourcePdfData).not.toHaveBeenCalled();
    });
});
