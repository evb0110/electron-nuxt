import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    PDFDocument,
    PDFName,
    rgb,
    StandardFonts,
} from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
    assembleSearchablePdf,
    stripTesseractImageLayer,
} from '@electron/ocr/worker/pdfAssembler';

async function addHiddenTextLayer(
    pdf: PDFDocument,
    page: ReturnType<PDFDocument['addPage']>,
    text: string,
) {
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const fontName = page.node.newFontDictionary('OcrFont', font.ref);
    const encodedText = font.encodeText(text).toString();
    const stream = [
        'BT',
        `3 Tr 1 0 0 1 20 100 Tm ${fontName} 12 Tf ${encodedText} Tj`,
        'ET',
        '',
    ].join('\n');
    page.node.addContentStream(pdf.context.register(pdf.context.flateStream(stream)));
}

async function createPdfWithVisibleAndHiddenText(filePath: string, spec: {
    visibleText?: string;
    hiddenText?: string;
    size?: [number, number];
}) {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage(spec.size ?? [
        200,
        200,
    ]);
    page.drawRectangle({
        x: 10,
        y: 10,
        width: 50,
        height: 30,
        color: rgb(0.8, 0.8, 0.8),
    });
    if (spec.visibleText) {
        page.drawText(spec.visibleText, {
            x: 20,
            y: 140,
            size: 18,
        });
    }
    if (spec.hiddenText) {
        await addHiddenTextLayer(pdf, page, spec.hiddenText);
    }
    await writeFile(filePath, await pdf.save());
}

async function createPdfWithPages(filePath: string, pages: Array<{
    text?: string;
    hiddenText?: string;
    size: [number, number];
}>) {
    const pdf = await PDFDocument.create();
    for (const pageSpec of pages) {
        const page = pdf.addPage(pageSpec.size);
        page.drawRectangle({
            x: 10,
            y: 10,
            width: 50,
            height: 30,
            color: rgb(0.8, 0.8, 0.8),
        });
        if (pageSpec.text) {
            page.drawText(pageSpec.text, {
                x: 20,
                y: Math.max(40, pageSpec.size[1] / 2),
                size: 18,
            });
        }
        if (pageSpec.hiddenText) {
            await addHiddenTextLayer(pdf, page, pageSpec.hiddenText);
        }
    }
    await writeFile(filePath, await pdf.save());
}

function countTextOccurrences(text: string, needle: string) {
    return text.split(needle).length - 1;
}

async function getPdfPageSizes(filePath: string) {
    const pdf = await PDFDocument.load(await readFile(filePath));
    return pdf.getPages().map((page) => {
        const size = page.getSize();
        return [
            size.width,
            size.height,
        ] as const;
    });
}

async function extractPdfText(filePath: string) {
    const pdf = await getDocument({
        data: new Uint8Array(await readFile(filePath)),
        useWorkerFetch: false,
    }).promise;

    try {
        const parts: string[] = [];
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            const page = await pdf.getPage(pageNumber);
            const textContent = await page.getTextContent();
            parts.push(textContent.items
                .map(item => ('str' in item ? item.str : ''))
                .join(' '));
        }
        return parts.join('\n').replace(/\s+/g, ' ').trim();
    } finally {
        await pdf.destroy();
    }
}

describe('assembleSearchablePdf', () => {
    let tempDir: string | null = null;

    afterEach(async () => {
        if (tempDir) {
            await rm(tempDir, {
                recursive: true,
                force: true,
            });
            tempDir = null;
        }
    });

    it('preserves visible page content while replacing the hidden OCR text layer', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-assembler-'));
        const originalPath = join(tempDir, 'original.pdf');
        const ocrPath = join(tempDir, 'ocr.pdf');
        await createPdfWithVisibleAndHiddenText(originalPath, {
            visibleText: 'VISIBLE ORIGINAL',
            hiddenText: 'OLD OCR',
        });
        await createPdfWithVisibleAndHiddenText(ocrPath, { hiddenText: 'NEW OCR' });
        const ocrPages = new Map<number, string>();
        ocrPages.set(1, ocrPath);

        const outputPath = await assembleSearchablePdf(
            'qpdf-not-used',
            originalPath,
            ocrPages,
            1,
            tempDir,
            'test-session',
            vi.fn(),
            path => path,
        );

        const extractedText = await extractPdfText(outputPath);

        expect(extractedText).toContain('VISIBLE ORIGINAL');
        expect(extractedText).toContain('NEW OCR');
        expect(extractedText).not.toContain('OLD OCR');
    });

    it('assembles OCR output when original page resources are malformed', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-assembler-'));
        const originalPath = join(tempDir, 'original.pdf');
        const firstOcrPath = join(tempDir, 'ocr-first.pdf');
        const secondOcrPath = join(tempDir, 'ocr-second.pdf');
        const originalPdf = await PDFDocument.create();
        const firstPage = originalPdf.addPage([
            200,
            200,
        ]);
        firstPage.node.set(PDFName.of('Resources'), PDFName.of('Nope'));
        const secondPage = originalPdf.addPage([
            200,
            200,
        ]);
        secondPage.node.set(PDFName.of('Resources'), originalPdf.context.obj({
            Font: PDFName.of('Nope'),
            XObject: PDFName.of('Nope'),
        }));
        await writeFile(originalPath, await originalPdf.save());
        await createPdfWithVisibleAndHiddenText(firstOcrPath, { hiddenText: 'FIRST OCR' });
        await createPdfWithVisibleAndHiddenText(secondOcrPath, { hiddenText: 'SECOND OCR' });

        const ocrPages = new Map<number, string>();
        ocrPages.set(1, firstOcrPath);
        ocrPages.set(2, secondOcrPath);

        const outputPath = await assembleSearchablePdf(
            'qpdf-not-used',
            originalPath,
            ocrPages,
            2,
            tempDir,
            'malformed-resources-session',
            vi.fn(),
            path => path,
        );

        const extractedText = await extractPdfText(outputPath);

        expect(extractedText).toContain('FIRST OCR');
        expect(extractedText).toContain('SECOND OCR');
    });

    it('replaces previous OCR page text when applying OCR again', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-assembler-'));
        const originalPath = join(tempDir, 'original.pdf');
        const firstOcrPath = join(tempDir, 'ocr-first.pdf');
        const secondOcrPath = join(tempDir, 'ocr-second.pdf');
        await createPdfWithVisibleAndHiddenText(originalPath, {
            visibleText: 'VISIBLE ORIGINAL',
            hiddenText: 'ORIGINAL OCR',
        });
        await createPdfWithVisibleAndHiddenText(firstOcrPath, { hiddenText: 'FIRST OCR' });
        await createPdfWithVisibleAndHiddenText(secondOcrPath, { hiddenText: 'SECOND OCR' });

        const firstOcrPages = new Map<number, string>();
        firstOcrPages.set(1, firstOcrPath);
        const secondOcrPages = new Map<number, string>();
        secondOcrPages.set(1, secondOcrPath);
        const firstOutputPath = await assembleSearchablePdf(
            'qpdf-not-used',
            originalPath,
            firstOcrPages,
            1,
            tempDir,
            'first-session',
            vi.fn(),
            path => path,
        );
        const secondOutputPath = await assembleSearchablePdf(
            'qpdf-not-used',
            firstOutputPath,
            secondOcrPages,
            1,
            tempDir,
            'second-session',
            vi.fn(),
            path => path,
        );

        const extractedText = await extractPdfText(secondOutputPath);

        expect(extractedText).toContain('VISIBLE ORIGINAL');
        expect(extractedText).toContain('SECOND OCR');
        expect(countTextOccurrences(extractedText, 'SECOND OCR')).toBe(1);
        expect(extractedText).not.toContain('FIRST OCR');
        expect(extractedText).not.toContain('ORIGINAL OCR');
    });

    it('keeps original page ranges and replaces selected page OCR text', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-assembler-'));
        const originalPath = join(tempDir, 'original.pdf');
        const ocrPath = join(tempDir, 'ocr-page-2.pdf');
        await createPdfWithPages(originalPath, [
            {
                text: 'ONE ORIGINAL',
                size: [
                    180,
                    240,
                ],
            },
            {
                text: 'TWO VISIBLE',
                hiddenText: 'TWO OLD OCR',
                size: [
                    220,
                    180,
                ],
            },
            {
                text: 'THREE ORIGINAL',
                size: [
                    260,
                    260,
                ],
            },
        ]);
        await createPdfWithPages(ocrPath, [{
            hiddenText: 'TWO OCR',
            size: [
                220,
                180,
            ],
        }]);

        const ocrPages = new Map<number, string>();
        ocrPages.set(2, ocrPath);

        const outputPath = await assembleSearchablePdf(
            'qpdf-not-used',
            originalPath,
            ocrPages,
            3,
            tempDir,
            'range-session',
            vi.fn(),
            path => path,
        );

        const extractedText = await extractPdfText(outputPath);
        const pageSizes = await getPdfPageSizes(outputPath);

        expect(extractedText).toContain('ONE ORIGINAL');
        expect(extractedText).toContain('TWO VISIBLE');
        expect(extractedText).toContain('TWO OCR');
        expect(extractedText).not.toContain('TWO OLD OCR');
        expect(extractedText).toContain('THREE ORIGINAL');
        expect(pageSizes).toEqual([
            [
                180,
                240,
            ],
            [
                220,
                180,
            ],
            [
                260,
                260,
            ],
        ]);
    });
});

describe('stripTesseractImageLayer', () => {
    it('removes the generated page image while keeping the hidden text stream', () => {
        const qdfSource = [
            '50 0 obj',
            '<<',
            '  /Contents 404 0 R',
            '  /Resources <<',
            '    /Font << /f-0-0 73 0 R >>',
            '    /XObject <<',
            '      /Im1 407 0 R',
            '    >>',
            '  >>',
            '>>',
            'endobj',
            '404 0 obj',
            '<< /Length 123 >>',
            'stream',
            'q 423.8 0 0 640.8 0 0 cm /Im1 Do Q',
            'BT',
            '3 Tr 1 0 0 1 28 100.8 Tm /f-0-0 8 Tf [ <04200438043C> ] TJ',
            'ET',
            'endstream',
            'endobj',
        ].join('\n');

        const stripped = stripTesseractImageLayer(qdfSource);

        expect(stripped).not.toContain('/Im1 Do');
        expect(stripped).not.toContain('/XObject');
        expect(stripped).toContain('3 Tr');
        expect(stripped).toContain('<04200438043C>');
    });
});
