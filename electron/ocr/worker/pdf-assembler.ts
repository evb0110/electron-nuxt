import {
    readFile,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import { PDFDocument } from 'pdf-lib';
import type { TWorkerLog } from '@electron/ocr/worker/types';
import { runOcrCommand } from '@electron/ocr/worker/run-command';

const QPDF_TIMEOUT_MS = 2 * 60 * 1000;

export async function getPageCount(
    qpdfBinary: string,
    pdfPath: string,
    fallback: number,
): Promise<number> {
    try {
        const result = await runOcrCommand(qpdfBinary, [
            '--show-npages',
            pdfPath,
        ], {
            timeoutMs: QPDF_TIMEOUT_MS,
            commandLabel: 'qpdf(show-npages)',
        });
        const parsed = parseInt((result.stdout ?? '').trim(), 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    } catch {
        // Use fallback
    }
    return fallback;
}

export async function assembleSearchablePdf(
    originalPdfPath: string,
    ocrPdfMap: Map<number, string>,
    pageImageMap: Map<number, string>,
    pageCount: number,
    tempDir: string,
    sessionId: string,
    log: TWorkerLog,
    trackTempFile: (path: string) => string,
): Promise<string> {
    log('debug', `Replacing ${ocrPdfMap.size} page(s) with rasterized OCR pages`);

    const originalPdfBytes = await readFile(originalPdfPath);
    const originalPdf = await PDFDocument.load(originalPdfBytes, { updateMetadata: false });
    const outputDoc = await PDFDocument.create();

    for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
        const ocrPath = ocrPdfMap.get(pageNum);
        const imagePath = pageImageMap.get(pageNum);
        if (!ocrPath || !imagePath) {
            const [copiedPage] = await outputDoc.copyPages(originalPdf, [pageNum - 1]);
            if (copiedPage) {
                outputDoc.addPage(copiedPage);
            }
            continue;
        }

        const sourcePage = originalPdf.getPage(pageNum - 1);
        const {
            width,
            height,
        } = sourcePage.getSize();

        const outputPage = outputDoc.addPage([
            width,
            height,
        ]);
        const pageImage = await outputDoc.embedPng(await readFile(imagePath));
        outputPage.drawImage(pageImage, {
            x: 0,
            y: 0,
            width,
            height,
        });

        const ocrPdfBytes = await readFile(ocrPath);
        const ocrPdf = await PDFDocument.load(ocrPdfBytes, { updateMetadata: false });
        const ocrPage = ocrPdf.getPage(0);
        const embeddedOcrPage = await outputDoc.embedPage(ocrPage);
        outputPage.drawPage(embeddedOcrPage, {
            x: 0,
            y: 0,
            width,
            height,
        });
    }

    const replacementPdfPath = trackTempFile(join(tempDir, `${sessionId}-merged.pdf`));
    await writeFile(replacementPdfPath, await outputDoc.save());
    return replacementPdfPath;
}
