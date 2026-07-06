import {
    readFile,
    stat,
    writeFile,
} from 'fs/promises';
import { PDFDocument } from 'pdf-lib';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import { writePdfBookmarkOutlines } from '@pdf-core';

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException('Operation aborted', 'AbortError');
    }
}

export async function embedBookmarksIntoPdfDataWithPdfLib(
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

export async function embedBookmarksIntoPdfFileWithPdfLib(
    inputPdfPath: string,
    outputPdfPath: string,
    bookmarks: IPdfBookmarkEntry[],
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    const pdfData = await readFile(inputPdfPath);
    throwIfAborted(signal);
    const updatedPdfData = await embedBookmarksIntoPdfDataWithPdfLib(pdfData, bookmarks);
    throwIfAborted(signal);
    await writeFile(outputPdfPath, updatedPdfData);
    const outputStats = await stat(outputPdfPath);
    return outputStats.size;
}
