import {
    describe,
    expect,
    it,
} from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
    buildPrintablePdfData,
    buildPrintSpreadGroups,
    canPrintSourcePdfDirectly,
    parsePrintPageRangeInput,
    shouldPrintPageMetricsDirectly,
    shouldPrintSourcePdfDirectly,
} from '@app/utils/pdf-print';

async function createSourcePdf(pageSizes: Array<[number, number]>) {
    const pdf = await PDFDocument.create();
    for (const [
        index,
        size,
    ] of pageSizes.entries()) {
        const page = pdf.addPage(size);
        page.drawText(`Page ${index + 1}`, {
            x: 12,
            y: Math.max(12, size[1] - 24),
            size: 12,
        });
    }
    return pdf.save();
}

describe('pdf-print', () => {
    it('parses comma-separated page ranges into unique sorted page numbers', () => {
        expect(parsePrintPageRangeInput('1-3, 7, 10-12, 3', 12)).toEqual([
            1,
            2,
            3,
            7,
            10,
            11,
            12,
        ]);
    });

    it('rejects invalid page ranges', () => {
        expect(parsePrintPageRangeInput('0-3', 12)).toBeNull();
        expect(parsePrintPageRangeInput('4-20', 12)).toBeNull();
        expect(parsePrintPageRangeInput('2,a', 12)).toBeNull();
    });

    it('groups pages into printable spreads for each supported layout', () => {
        expect(buildPrintSpreadGroups([
            1,
            2,
            3,
            4,
        ], 'single')).toEqual([
            [1],
            [2],
            [3],
            [4],
        ]);

        expect(buildPrintSpreadGroups([
            1,
            2,
            3,
            4,
        ], 'facing')).toEqual([
            [
                1,
                2,
            ],
            [
                3,
                4,
            ],
        ]);

        expect(buildPrintSpreadGroups([
            1,
            2,
            3,
            4,
        ], 'facing-first-single')).toEqual([
            [1],
            [
                2,
                3,
            ],
            [4],
        ]);
    });

    it('detects when the original PDF can be handed directly to native print', () => {
        expect(canPrintSourcePdfDirectly({
            viewMode: 'single',
            orientation: 'auto',
        })).toBe(true);

        expect(canPrintSourcePdfDirectly({
            pageNumbers: [1],
            viewMode: 'single',
            orientation: 'auto',
        })).toBe(false);

        expect(canPrintSourcePdfDirectly({
            viewMode: 'facing',
            orientation: 'auto',
        })).toBe(false);
    });

    it('refuses direct source-PDF printing for oversized pages that need office-paper fitting', async () => {
        const sourcePdfData = await createSourcePdf([[
            734.4,
            1113.12,
        ]]);

        await expect(shouldPrintSourcePdfDirectly(sourcePdfData, {
            viewMode: 'single',
            orientation: 'auto',
        })).resolves.toBe(false);
    });

    it('allows direct source-PDF printing for office-paper-sized pages', async () => {
        const sourcePdfData = await createSourcePdf([[
            595.28,
            841.89,
        ]]);

        await expect(shouldPrintSourcePdfDirectly(sourcePdfData, {
            viewMode: 'single',
            orientation: 'auto',
        })).resolves.toBe(true);
    });

    it('can decide direct-print safety from loaded page metrics without reparsing the PDF', () => {
        expect(shouldPrintPageMetricsDirectly([{
            width: 612,
            height: 792,
        }], {
            viewMode: 'single',
            orientation: 'auto',
        })).toBe(true);

        expect(shouldPrintPageMetricsDirectly([{
            width: 734.4,
            height: 1113.12,
        }], {
            viewMode: 'single',
            orientation: 'auto',
        })).toBe(false);
    });

    it('builds a spread-based printable PDF for facing pages', async () => {
        const sourcePdfData = await createSourcePdf([
            [
                100,
                200,
            ],
            [
                120,
                200,
            ],
            [
                90,
                180,
            ],
        ]);

        const printablePdfData = await buildPrintablePdfData(sourcePdfData, {
            pageNumbers: [
                1,
                2,
                3,
            ],
            viewMode: 'facing',
            orientation: 'auto',
        });

        expect(printablePdfData).not.toBeNull();

        const printablePdf = await PDFDocument.load(printablePdfData!);
        expect(printablePdf.getPageCount()).toBe(2);
        expect(printablePdf.getPage(0)?.getSize()).toEqual({
            width: 792,
            height: 595.28,
        });
        expect(printablePdf.getPage(1)?.getSize()).toEqual({
            width: 595.28,
            height: 792,
        });
    });

    it('honors the requested print orientation', async () => {
        const sourcePdfData = await createSourcePdf([[
            100,
            200,
        ]]);

        const printablePdfData = await buildPrintablePdfData(sourcePdfData, {
            pageNumbers: [1],
            viewMode: 'single',
            orientation: 'landscape',
        });

        expect(printablePdfData).not.toBeNull();

        const printablePdf = await PDFDocument.load(printablePdfData!);
        expect(printablePdf.getPage(0)?.getSize()).toEqual({
            width: 200,
            height: 100,
        });
    });

    it('returns the original PDF bytes for the default single-page print flow', async () => {
        const sourcePdfData = await createSourcePdf([
            [
                595.28,
                841.89,
            ],
            [
                612,
                792,
            ],
        ]);

        const printablePdfData = await buildPrintablePdfData(sourcePdfData, {
            viewMode: 'single',
            orientation: 'auto',
        });

        expect(printablePdfData).toBe(sourcePdfData);
    });

    it('fits oversized single-page documents onto office paper before printing', async () => {
        const sourcePdfData = await createSourcePdf([[
            734.4,
            1113.12,
        ]]);

        const printablePdfData = await buildPrintablePdfData(sourcePdfData, {
            viewMode: 'single',
            orientation: 'auto',
        });

        expect(printablePdfData).not.toBe(sourcePdfData);

        const printablePdf = await PDFDocument.load(printablePdfData!);
        expect(printablePdf.getPage(0)?.getSize()).toEqual({
            width: 595.28,
            height: 792,
        });
    });

    it('copies only the requested pages for default single-page subset printing', async () => {
        const sourcePdfData = await createSourcePdf([
            [
                595.28,
                841.89,
            ],
            [
                612,
                792,
            ],
            [
                612,
                792,
            ],
        ]);

        const printablePdfData = await buildPrintablePdfData(sourcePdfData, {
            pageNumbers: [
                3,
                1,
            ],
            viewMode: 'single',
            orientation: 'auto',
        });

        expect(printablePdfData).not.toBeNull();

        const printablePdf = await PDFDocument.load(printablePdfData!);
        expect(printablePdf.getPageCount()).toBe(2);
        expect(printablePdf.getPage(0)?.getSize()).toEqual({
            width: 595.28,
            height: 841.89,
        });
        expect(printablePdf.getPage(1)?.getSize()).toEqual({
            width: 612,
            height: 792,
        });
    });
});
