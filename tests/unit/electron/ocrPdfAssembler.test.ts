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
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { assembleSearchablePdf } from '@electron/ocr/worker/pdf-assembler';

const ONE_PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/atXxKAAAAAASUVORK5CYII=',
    'base64',
);

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

async function extractPdfText(filePath: string) {
    const pdf = await getDocument({
        data: new Uint8Array(await readFile(filePath)),
        useWorkerFetch: false,
        isEvalSupported: false,
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

    it('replaces OCR page contents instead of adding text over the existing layer', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-assembler-'));
        const originalPath = join(tempDir, 'original.pdf');
        const ocrPath = join(tempDir, 'ocr.pdf');
        const imagePath = join(tempDir, 'page.png');
        await createPdfWithText(originalPath, 'OLD TEXT');
        await createPdfWithText(ocrPath, 'NEW OCR');
        await writeFile(imagePath, ONE_PIXEL_PNG);
        const ocrPages = new Map<number, string>();
        ocrPages.set(1, ocrPath);
        const pageImages = new Map<number, string>();
        pageImages.set(1, imagePath);

        const outputPath = await assembleSearchablePdf(
            originalPath,
            ocrPages,
            pageImages,
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
        const imagePath = join(tempDir, 'page.png');
        await createPdfWithText(originalPath, 'ORIGINAL TEXT');
        await createPdfWithText(firstOcrPath, 'FIRST OCR');
        await createPdfWithText(secondOcrPath, 'SECOND OCR');
        await writeFile(imagePath, ONE_PIXEL_PNG);

        const pageImages = new Map<number, string>();
        pageImages.set(1, imagePath);
        const firstOcrPages = new Map<number, string>();
        firstOcrPages.set(1, firstOcrPath);
        const secondOcrPages = new Map<number, string>();
        secondOcrPages.set(1, secondOcrPath);
        const firstOutputPath = await assembleSearchablePdf(
            originalPath,
            firstOcrPages,
            pageImages,
            1,
            tempDir,
            'first-session',
            vi.fn(),
            path => path,
        );
        const secondOutputPath = await assembleSearchablePdf(
            firstOutputPath,
            secondOcrPages,
            pageImages,
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
});
