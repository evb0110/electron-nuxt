import {
    readFile,
    stat,
    writeFile,
} from 'fs/promises';
import { PDFDocument } from 'pdf-lib';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import { writePdfBookmarkOutlines } from '@pdf-core/writePdfBookmarkOutlines';

async function embedBookmarksIntoPdf(
    pdfData: Uint8Array,
    bookmarks: IPdfBookmarkEntry[],
) {
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
) {
    const pdfData = await readFile(inputPdfPath);
    const updatedPdfData = await embedBookmarksIntoPdf(pdfData, bookmarks);
    await writeFile(outputPdfPath, updatedPdfData);
    const outputStats = await stat(outputPdfPath);
    return outputStats.size;
}
