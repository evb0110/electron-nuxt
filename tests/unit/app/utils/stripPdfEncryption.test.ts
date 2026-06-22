import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDFDocument,
    PDFName,
} from 'pdf-lib';
import { stripPdfEncryption } from '@app/utils/stripPdfEncryption';

describe('stripPdfEncryption', () => {
    it('returns original bytes when the Encrypt trailer ref resolves to a non-dictionary object', async () => {
        const doc = await PDFDocument.create();
        doc.addPage();
        doc.context.trailerInfo.Encrypt = doc.context.register(PDFName.of('Nope'));
        const bytes = new Uint8Array(await doc.save({ updateFieldAppearances: false }));

        await expect(stripPdfEncryption(bytes)).resolves.toBe(bytes);
    });
});
