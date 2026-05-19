import {
    readFile,
    writeFile,
} from 'fs/promises';
import {
    PDFDocument,
    PDFName,
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
import { ensureWorkingCopyDirectory } from '@electron/ipc/workingCopyCreation';

const log = createLogger('page-ops-crop');

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
    left: {
        x: number;
        y: number;
        width: number;
        height: number;
    },
    right: {
        x: number;
        y: number;
        width: number;
        height: number;
    },
) {
    return left.x === right.x
        && left.y === right.y
        && left.width === right.width
        && left.height === right.height;
}

async function savePdfAtomically(pdfDoc: PDFDocument, workingCopyPath: string) {
    if (!await ensureWorkingCopyDirectory(workingCopyPath)) {
        throw new Error('Working copy path is not managed');
    }
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
    if (!await ensureWorkingCopyDirectory(workingCopyPath)) {
        throw new Error('Working copy path is not managed');
    }
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

            const mediaBox = page.getMediaBox();
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

            const mediaBox = page.getMediaBox();
            const cropBox = page.getCropBox();

            if (boxesEqual(cropBox, mediaBox)) {
                page.node.delete(PDFName.of('CropBox'));
                continue;
            }

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

    const mediaBox = page.getMediaBox();
    const resolvedCropBox = page.getCropBox();
    const cropBox = boxesEqual(resolvedCropBox, mediaBox) ? null : resolvedCropBox;
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
