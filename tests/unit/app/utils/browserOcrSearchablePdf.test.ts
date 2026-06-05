import { readFile } from 'fs/promises';
import { resolve } from 'path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createBrowserSearchablePdf } from '@app/utils/browserOcrSearchablePdf';

describe('createBrowserSearchablePdf', () => {
    it('creates a PDF whose text layer includes OCR words', async () => {
        const sourcePdf = await PDFDocument.create();
        sourcePdf.addPage([
            600,
            800,
        ]);
        const sourcePdfBytes = await sourcePdf.save();
        const fontData = new Uint8Array(await readFile(
            resolve(process.cwd(), 'public/pdf/standard_fonts/LiberationSans-Regular.ttf'),
        ));

        const result = await createBrowserSearchablePdf({
            sourcePdfData: sourcePdfBytes,
            fontData,
            pageData: { 1: {
                text: 'Hello OCR',
                words: [
                    {
                        text: 'Hello',
                        x: 120,
                        y: 160,
                        width: 220,
                        height: 48,
                    },
                    {
                        text: 'OCR',
                        x: 360,
                        y: 160,
                        width: 140,
                        height: 48,
                    },
                ],
                imageWidth: 1200,
                imageHeight: 1600,
            } },
        });

        const pdf = await getDocument(
            {
                data: result,
                useWorkerFetch: false,
            },
        ).promise;

        try {
            const page = await pdf.getPage(1);
            const textContent = await page.getTextContent();
            const extractedText = textContent.items
                .map((item) => ('str' in item ? item.str : ''))
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();

            expect(extractedText).toContain('Hello');
            expect(extractedText).toContain('OCR');
        } finally {
            await pdf.destroy();
        }
    });
});
