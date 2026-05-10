import {
    readFile,
    stat,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import { PDFDocument } from 'pdf-lib';
import type { TWorkerLog } from '@electron/ocr/worker/types';
import { runOcrCommand } from '@electron/ocr/worker/run-command';
import { abortErrorFromSignal } from '@electron/utils/abort';

const QPDF_TIMEOUT_MS = 2 * 60 * 1000;
const PDF_ASSEMBLER_MAX_INPUT_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_OCR_PDF_ASSEMBLER_MAX_INPUT_MB ?? '1024', 10);
    if (!Number.isFinite(parsed) || parsed < 64) {
        return 1024 * 1024 * 1024;
    }
    return parsed * 1024 * 1024;
})();

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

async function readBoundedFile(path: string, label: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    const fileStat = await stat(path);
    if (fileStat.size > PDF_ASSEMBLER_MAX_INPUT_BYTES) {
        throw new Error(`${label} is too large to assemble safely (${fileStat.size} bytes)`);
    }
    const bytes = await readFile(path);
    throwIfAborted(signal);
    return bytes;
}

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
    signal?: AbortSignal,
): Promise<string> {
    log('debug', `Replacing ${ocrPdfMap.size} page(s) with rasterized OCR pages`);

    const originalPdfBytes = await readBoundedFile(originalPdfPath, 'Original PDF', signal);
    const originalPdf = await PDFDocument.load(originalPdfBytes, { updateMetadata: false });
    const outputDoc = await PDFDocument.create();

    for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
        throwIfAborted(signal);
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
        const pageImage = await outputDoc.embedPng(await readBoundedFile(imagePath, `OCR page image ${pageNum}`, signal));
        outputPage.drawImage(pageImage, {
            x: 0,
            y: 0,
            width,
            height,
        });

        const ocrPdfBytes = await readBoundedFile(ocrPath, `OCR PDF page ${pageNum}`, signal);
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

    throwIfAborted(signal);
    const replacementPdfPath = trackTempFile(join(tempDir, `${sessionId}-merged.pdf`));
    await writeFile(replacementPdfPath, await outputDoc.save());
    throwIfAborted(signal);
    return replacementPdfPath;
}
