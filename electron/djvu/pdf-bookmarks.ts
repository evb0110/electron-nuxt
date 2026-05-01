import {
    readFile,
    stat,
    writeFile,
} from 'fs/promises';
import { PDFDocument } from 'pdf-lib';
import type { IPdfBookmarkEntry } from '@contracts/pdf';
import { writePdfBookmarkOutlines } from '@contracts/pdf-bookmarks';

async function embedBookmarksIntoPdf(
    pdfData: Uint8Array,
    bookmarks: IPdfBookmarkEntry[],
): Promise<Uint8Array> {
    if (bookmarks.length === 0) {
        return pdfData;
    }

    const doc = await PDFDocument.load(pdfData, { updateMetadata: false });
    writePdfBookmarkOutlines(doc, bookmarks);
    return new Uint8Array(await doc.save());
}

export async function embedBookmarksIntoPdfFile(
    inputPdfPath: string,
    outputPdfPath: string,
    bookmarks: IPdfBookmarkEntry[],
): Promise<number> {
    const pdfData = await readFile(inputPdfPath);
    const updatedPdfData = await embedBookmarksIntoPdf(pdfData, bookmarks);
    await writeFile(outputPdfPath, updatedPdfData);
    const outputStats = await stat(outputPdfPath);
    return outputStats.size;
}
