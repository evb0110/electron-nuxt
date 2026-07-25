import {
    readFile,
    writeFile,
} from 'fs/promises';
import {PDFDocument} from 'pdf-lib';
import type {
    ICropMargins,
    IPageGeometry,
} from '@contracts/shared';
import { normalizeCropMargins } from '@contracts/shared';
import {
    resolvePdfLibCropBox,
    resolvePdfLibMediaBox,
} from '@pdf-core';
import { createLogger } from '@electron/utils/createLogger';
import {
    cleanupTempOutput,
    makeTempPdfOutputPath,
    replaceTempOutput,
} from '@electron/features/page-ops/main/tempOutput';
import {
    tryCropPagesWithNativePageOps,
    tryRemoveCropWithNativePageOps,
} from '@electron/features/page-ops/main/nativeCrop';

const log = createLogger('page-ops-crop');

function assertValidRequestedPages(pages: number[], totalPages: number) {
    if (pages.length === 0) {
        throw new Error('At least one page must be selected');
    }

    for (const pageNumber of pages) {
        if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > totalPages) {
            throw new Error(`Page ${pageNumber} is outside the document page range 1-${totalPages}`);
        }
    }
}

async function savePdfAtomically(pdfDoc: PDFDocument, workingCopyPath: string) {
    const tempPath = makeTempPdfOutputPath(workingCopyPath);
    try {
        const outputBytes = await pdfDoc.save();
        await writeFile(tempPath, outputBytes);
        await replaceTempOutput(tempPath, workingCopyPath);
    } catch (err) {
        await cleanupTempOutput(tempPath, log, 'temp file');
        throw err;
    }
}

async function mutatePdfPages(
    workingCopyPath: string,
    mutate: (pages: ReturnType<PDFDocument['getPages']>) => void,
    signal?: AbortSignal,
) {
    if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new DOMException('Operation aborted', 'AbortError');
    }
    const pdfBytes = await readFile(workingCopyPath);
    if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new DOMException('Operation aborted', 'AbortError');
    }
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPages();
    mutate(pages);
    await savePdfAtomically(pdfDoc, workingCopyPath);
}

function resolveCropBoxes(
    allPages: ReturnType<PDFDocument['getPages']>,
    pages: number[],
    margins: ICropMargins,
) {
    assertValidRequestedPages(pages, allPages.length);

    return pages.map((pageNum) => {
        const mediaBox = resolvePdfLibMediaBox(allPages[pageNum - 1]!);
        const width = mediaBox.width - margins.left - margins.right;
        const height = mediaBox.height - margins.top - margins.bottom;

        if (width <= 0 || height <= 0) {
            throw new Error(`Crop margins consume page ${pageNum}`);
        }

        return {
            pageNum,
            x: mediaBox.x + margins.left,
            y: mediaBox.y + margins.bottom,
            width,
            height,
        };
    });
}

export async function cropPagesLocal(
    workingCopyPath: string,
    pages: number[],
    margins: ICropMargins,
    signal?: AbortSignal,
) {
    const normalizedMargins = normalizeCropMargins(margins);

    if (await tryCropPagesWithNativePageOps(workingCopyPath, pages, normalizedMargins, signal)) {
        return;
    }

    await mutatePdfPages(workingCopyPath, (allPages) => {
        const cropBoxes = resolveCropBoxes(allPages, pages, normalizedMargins);
        for (const cropBox of cropBoxes) {
            allPages[cropBox.pageNum - 1]!.setCropBox(cropBox.x, cropBox.y, cropBox.width, cropBox.height);
        }
    }, signal);
}

export async function removeCropFromPagesLocal(
    workingCopyPath: string,
    pages: number[],
    signal?: AbortSignal,
) {
    if (await tryRemoveCropWithNativePageOps(workingCopyPath, pages, signal)) {
        return;
    }

    await mutatePdfPages(workingCopyPath, (allPages) => {
        assertValidRequestedPages(pages, allPages.length);
        for (const pageNum of pages) {
            const page = allPages[pageNum - 1]!;

            const mediaBox = resolvePdfLibMediaBox(page);
            page.setCropBox(mediaBox.x, mediaBox.y, mediaBox.width, mediaBox.height);
        }
    }, signal);
}

export async function getPageGeometryLocal(
    workingCopyPath: string,
    pageNumber: number,
): Promise<IPageGeometry> {
    const pdfBytes = await readFile(workingCopyPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const allPages = pdfDoc.getPages();
    const page = allPages[pageNumber - 1];

    if (!page) {
        throw new Error(`Page ${pageNumber} not found`);
    }

    const mediaBox = resolvePdfLibMediaBox(page);
    const cropBox = resolvePdfLibCropBox(page, mediaBox);
    const rotation = page.getRotation().angle;

    return {
        mediaBox: {
            x: mediaBox.x,
            y: mediaBox.y,
            width: mediaBox.width,
            height: mediaBox.height,
        },
        cropBox: cropBox
            ? {
                x: cropBox.x,
                y: cropBox.y,
                width: cropBox.width,
                height: cropBox.height,
            }
            : null,
        rotation,
    };
}
