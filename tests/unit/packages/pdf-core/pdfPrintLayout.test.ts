import {
    degrees,
    PDFDocument,
} from 'pdf-lib';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { buildPrintablePdfData } from '@pdf-core';

async function createRotatedSourcePdf(rotations: readonly number[]) {
    const sourcePdf = await PDFDocument.create();

    for (const rotation of rotations) {
        const page = sourcePdf.addPage([
            100,
            200,
        ]);
        page.setRotation(degrees(rotation));
        page.drawRectangle({
            x: 10,
            y: 20,
            width: 30,
            height: 50,
        });
    }

    return sourcePdf.save();
}

describe('pdf print layout', () => {
    it('uses the displayed dimensions of a rotated page for single-page printing', async () => {
        const sourcePdfData = await createRotatedSourcePdf([90]);

        const printablePdfData = await buildPrintablePdfData(sourcePdfData, {
            pageNumbers: [1],
            viewMode: 'single',
            orientation: 'auto',
        });

        const printablePdf = await PDFDocument.load(printablePdfData!);
        expect(printablePdf.getPage(0)?.getSize()).toEqual({
            width: 841.89,
            height: 595.28,
        });
    });

    it('uses the displayed dimensions of rotated pages for facing-page printing', async () => {
        const sourcePdfData = await createRotatedSourcePdf([
            90,
            90,
        ]);

        const printablePdfData = await buildPrintablePdfData(sourcePdfData, {
            pageNumbers: [
                1,
                2,
            ],
            viewMode: 'facing',
            orientation: 'auto',
        });

        const printablePdf = await PDFDocument.load(printablePdfData!);
        expect(printablePdf.getPage(0)?.getSize()).toEqual({
            width: 841.89,
            height: 595.28,
        });
    });
});
