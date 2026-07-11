import {
    copyFile,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import { assembleSearchablePdfStreaming } from '@electron/ocr/worker/assembleSearchablePdfStreaming';

let tempDir: string | null = null;

async function createPdf(path: string, pageCount: number) {
    const pdf = await PDFDocument.create();
    for (let page = 1; page <= pageCount; page += 1) {
        const pdfPage = pdf.addPage([
            200 + page,
            300 + page,
        ]);
        pdfPage.drawText(`page-${page}`);
    }
    await writeFile(path, await pdf.save());
}

afterEach(async () => {
    if (tempDir) {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
        tempDir = null;
    }
});

describe('streaming OCR PDF assembly', () => {
    it('replaces selected pages through qpdf without buffering the full source', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'evb-ocr-streaming-test-'));
        const originalPath = join(tempDir, 'original.pdf');
        const replacementPath = join(tempDir, 'replacement.pdf');
        await createPdf(originalPath, 3);
        await createPdf(replacementPath, 1);

        const outputPath = await assembleSearchablePdfStreaming({
            qpdfBinary: process.env.QPDF_BINARY ?? 'qpdf',
            originalPdfPath: originalPath,
            ocrPageEntries: [[
                2,
                replacementPath,
            ]],
            pageCount: 3,
            tempDir,
            sessionId: 'test',
            trackTempFile: path => path,
            mutatePage: (_originalPage, ocrPage, output) => copyFile(ocrPage, output).then(() => undefined),
        });

        const output = await PDFDocument.load(await readFile(outputPath));
        expect(output.getPageCount()).toBe(3);
        expect(output.getPages().map(page => page.getSize())).toEqual([
            {
                width: 201,
                height: 301,
            },
            {
                width: 201,
                height: 301,
            },
            {
                width: 203,
                height: 303,
            },
        ]);
    });
});
