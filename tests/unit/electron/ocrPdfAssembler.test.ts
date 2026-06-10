import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { assembleSearchablePdf } from '@electron/ocr/worker/pdfAssembler';

const QPDF_BINARY = process.platform === 'win32'
    ? join(process.cwd(), 'resources/qpdf/win32-x64/bin/qpdf.exe')
    : join(process.cwd(), `resources/qpdf/${process.platform}-${process.arch}/bin/qpdf`);
const HAS_QPDF = existsSync(QPDF_BINARY);

async function createPdfWithText(filePath: string, text: string) {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([
        200,
        200,
    ]);
    page.drawText(text, {
        x: 20,
        y: 100,
        size: 18,
    });
    await writeFile(filePath, await pdf.save());
}

async function createPdfWithPages(filePath: string, pages: Array<{
    text: string;
    size: [number, number];
}>) {
    const pdf = await PDFDocument.create();
    for (const pageSpec of pages) {
        const page = pdf.addPage(pageSpec.size);
        page.drawText(pageSpec.text, {
            x: 20,
            y: Math.max(40, pageSpec.size[1] / 2),
            size: 18,
        });
    }
    await writeFile(filePath, await pdf.save());
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

describe.skipIf(!HAS_QPDF)('assembleSearchablePdf', () => {
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

    it('replaces OCR page contents instead of adding text over the existing layer', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-assembler-'));
        const originalPath = join(tempDir, 'original.pdf');
        const ocrPath = join(tempDir, 'ocr.pdf');
        await createPdfWithText(originalPath, 'OLD TEXT');
        await createPdfWithText(ocrPath, 'NEW OCR');
        const ocrPages = new Map<number, string>();
        ocrPages.set(1, ocrPath);

        const outputPath = await assembleSearchablePdf(
            QPDF_BINARY,
            originalPath,
            ocrPages,
            1,
            tempDir,
            'test-session',
            vi.fn(),
            path => path,
        );

        const extractedText = await extractPdfText(outputPath);

        expect(extractedText).toContain('NEW OCR');
        expect(extractedText).not.toContain('OLD TEXT');
    });

    it('replaces a previously OCRed page instead of stacking another text layer', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-assembler-'));
        const originalPath = join(tempDir, 'original.pdf');
        const firstOcrPath = join(tempDir, 'ocr-first.pdf');
        const secondOcrPath = join(tempDir, 'ocr-second.pdf');
        await createPdfWithText(originalPath, 'ORIGINAL TEXT');
        await createPdfWithText(firstOcrPath, 'FIRST OCR');
        await createPdfWithText(secondOcrPath, 'SECOND OCR');

        const firstOcrPages = new Map<number, string>();
        firstOcrPages.set(1, firstOcrPath);
        const secondOcrPages = new Map<number, string>();
        secondOcrPages.set(1, secondOcrPath);
        const firstOutputPath = await assembleSearchablePdf(
            QPDF_BINARY,
            originalPath,
            firstOcrPages,
            1,
            tempDir,
            'first-session',
            vi.fn(),
            path => path,
        );
        const secondOutputPath = await assembleSearchablePdf(
            QPDF_BINARY,
            firstOutputPath,
            secondOcrPages,
            1,
            tempDir,
            'second-session',
            vi.fn(),
            path => path,
        );

        const extractedText = await extractPdfText(secondOutputPath);

        expect(extractedText).toContain('SECOND OCR');
        expect(extractedText).not.toContain('FIRST OCR');
        expect(extractedText).not.toContain('ORIGINAL TEXT');
    });

    it('keeps untouched original page ranges around replacement pages', async () => {
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
                text: 'TWO OLD',
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
            text: 'TWO OCR',
            size: [
                220,
                180,
            ],
        }]);

        const ocrPages = new Map<number, string>();
        ocrPages.set(2, ocrPath);

        const outputPath = await assembleSearchablePdf(
            QPDF_BINARY,
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
        expect(extractedText).toContain('TWO OCR');
        expect(extractedText).toContain('THREE ORIGINAL');
        expect(extractedText).not.toContain('TWO OLD');
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
