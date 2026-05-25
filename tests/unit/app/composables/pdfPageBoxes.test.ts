import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDFDocument,
    PDFName,
} from 'pdf-lib';
import { resolvePdfPageView } from '@app/composables/pdf/pdfPageBoxes';

describe('pdfPageBoxes', () => {
    it('resolves page view as CropBox intersected with MediaBox', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([
            300,
            500,
        ]);
        page.setCropBox(-20, 30, 260, 520);

        expect(resolvePdfPageView(page)).toEqual([
            0,
            30,
            240,
            500,
        ]);
    });

    it('resolves inherited crop boxes like PDF.js', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([
            300,
            500,
        ]);
        page.node.Parent()?.set(PDFName.of('CropBox'), pdfDocument.context.obj([
            10,
            20,
            290,
            480,
        ]));

        expect(resolvePdfPageView(page)).toEqual([
            10,
            20,
            290,
            480,
        ]);
    });


    it('falls back to MediaBox when CropBox does not overlap it', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([
            300,
            500,
        ]);
        page.setCropBox(400, 600, 50, 50);

        expect(resolvePdfPageView(page)).toEqual([
            0,
            0,
            300,
            500,
        ]);
    });
});
