import {
    readFile,
    writeFile,
} from 'fs/promises';
import {
    PDFDocument,
    type PDFPage,
} from 'pdf-lib';
import type {
    ICropMargins,
    IPageGeometry,
} from '@contracts/shared';
import { createLogger } from '@electron/utils/logger';
import {
    cleanupTempOutput,
    makeTempPdfOutputPath,
    replaceTempOutput,
} from '@electron/features/page-ops/main/tempOutput';

const log = createLogger('page-ops-crop');

interface IPdfPageBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

function isValidCropMargin(value: number) {
    return Number.isFinite(value) && value >= 0;
}

function assertValidMargins(margins: ICropMargins) {
    if (
        !isValidCropMargin(margins.top)
        || !isValidCropMargin(margins.bottom)
        || !isValidCropMargin(margins.left)
        || !isValidCropMargin(margins.right)
    ) {
        throw new Error('Invalid crop margins');
    }
}

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

function boxesEqual(
    left: IPdfPageBox,
    right: IPdfPageBox,
) {
    return left.x === right.x
        && left.y === right.y
        && left.width === right.width
        && left.height === right.height;
}

function normalizePdfPageBox(box: IPdfPageBox): IPdfPageBox | null {
    const minX = Math.min(box.x, box.x + box.width);
    const minY = Math.min(box.y, box.y + box.height);
    const maxX = Math.max(box.x, box.x + box.width);
    const maxY = Math.max(box.y, box.y + box.height);
    const width = maxX - minX;
    const height = maxY - minY;

    if (width <= 0 || height <= 0) {
        return null;
    }

    return {
        x: minX,
        y: minY,
        width,
        height,
    };
}

function intersectPdfPageBoxes(left: IPdfPageBox, right: IPdfPageBox) {
    const minX = Math.max(left.x, right.x);
    const minY = Math.max(left.y, right.y);
    const maxX = Math.min(left.x + left.width, right.x + right.width);
    const maxY = Math.min(left.y + left.height, right.y + right.height);
    const width = maxX - minX;
    const height = maxY - minY;

    if (width <= 0 || height <= 0) {
        return null;
    }

    return {
        x: minX,
        y: minY,
        width,
        height,
    };
}

function resolvePdfJsMediaBox(page: PDFPage): IPdfPageBox {
    const mediaBox = normalizePdfPageBox(page.getMediaBox())
        ?? normalizePdfPageBox({
            x: 0,
            y: 0,
            ...page.getSize(),
        });
    if (!mediaBox) {
        throw new Error('PDF page has an invalid media box');
    }

    return mediaBox;
}

function resolvePdfJsCropBox(page: PDFPage, mediaBox: IPdfPageBox) {
    const cropBox = normalizePdfPageBox(page.getCropBox());
    if (!cropBox || boxesEqual(cropBox, mediaBox)) {
        return null;
    }

    const effectiveCropBox = intersectPdfPageBoxes(cropBox, mediaBox);
    if (!effectiveCropBox || boxesEqual(effectiveCropBox, mediaBox)) {
        return null;
    }

    return effectiveCropBox;
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
) {
    const pdfBytes = await readFile(workingCopyPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPages();
    mutate(pages);
    await savePdfAtomically(pdfDoc, workingCopyPath);
}

export async function cropPagesLocal(
    workingCopyPath: string,
    pages: number[],
    margins: ICropMargins,
) {
    assertValidMargins(margins);

    await mutatePdfPages(workingCopyPath, (allPages) => {
        assertValidRequestedPages(pages, allPages.length);
        for (const pageNum of pages) {
            const page = allPages[pageNum - 1]!;

            const mediaBox = resolvePdfJsMediaBox(page);
            const cropX = mediaBox.x + margins.left;
            const cropY = mediaBox.y + margins.bottom;
            const cropWidth = mediaBox.width - margins.left - margins.right;
            const cropHeight = mediaBox.height - margins.top - margins.bottom;

            if (cropWidth <= 0 || cropHeight <= 0) {
                log.debug(`Skipping page ${pageNum}: crop dimensions invalid (${cropWidth}x${cropHeight})`);
                continue;
            }

            page.setCropBox(cropX, cropY, cropWidth, cropHeight);
        }
    });
}

export async function removeCropFromPagesLocal(
    workingCopyPath: string,
    pages: number[],
) {
    await mutatePdfPages(workingCopyPath, (allPages) => {
        assertValidRequestedPages(pages, allPages.length);
        for (const pageNum of pages) {
            const page = allPages[pageNum - 1]!;

            const mediaBox = resolvePdfJsMediaBox(page);
            page.setCropBox(mediaBox.x, mediaBox.y, mediaBox.width, mediaBox.height);
        }
    });
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

    const mediaBox = resolvePdfJsMediaBox(page);
    const cropBox = resolvePdfJsCropBox(page, mediaBox);
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
