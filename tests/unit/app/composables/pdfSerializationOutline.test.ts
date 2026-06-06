import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDFDocument,
    PDFName,
} from 'pdf-lib';
import { applyPageLabels } from '@app/utils/pdf-viewer/serialization/pdf-serialization-outline/applyPageLabels';

describe('pdfSerializationOutline', () => {
    it('removes existing page label metadata when all pages are reset to default numbering', async () => {
        const doc = await PDFDocument.create();
        doc.addPage();
        doc.addPage();
        doc.catalog.set(PDFName.of('PageLabels'), doc.context.obj({Nums: doc.context.obj([])}));

        const changed = applyPageLabels(
            doc,
            true,
            [{
                startPage: 1,
                style: 'D',
                prefix: '',
                startNumber: 1,
            }],
            2,
        );

        expect(changed).toBe(true);
        expect(doc.catalog.has(PDFName.of('PageLabels'))).toBe(false);
    });
});
