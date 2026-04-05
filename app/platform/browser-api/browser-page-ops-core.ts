import {
    degrees,
    PDFDocument,
    PDFName,
} from 'pdf-lib';
import type {
    ICropMargins,
    IPageGeometry,
} from '@contracts/shared';
import type { IPageMutationWorkerResult } from '@app/platform/browser-api/browser-page-ops-worker.types';

function toSavedPdfResult(
    pdfDocument: PDFDocument,
): Promise<IPageMutationWorkerResult> {
    return pdfDocument.save().then((data) => ({
        data: new Uint8Array(data),
        pageCount: pdfDocument.getPageCount(),
    }));
}

function getNormalizedPageIndexes(pageCount: number, pages: number[]) {
    return pages
        .map((page) => page - 1)
        .filter((index) => index >= 0 && index < pageCount);
}

async function copySelectedPages(options: {
    sourcePdf: PDFDocument;
    targetPdf?: PDFDocument;
    pageIndexes: number[];
}) {
    const {
        sourcePdf,
        pageIndexes,
    } = options;
    const targetPdf = options.targetPdf ?? await PDFDocument.create();
    const copiedPages = await targetPdf.copyPages(sourcePdf, pageIndexes);
    copiedPages.forEach((page) => targetPdf.addPage(page));
    return {
        copiedPages,
        targetPdf,
    };
}

export async function deletePdfPages(
    data: Uint8Array,
    pages: number[],
): Promise<IPageMutationWorkerResult> {
    const sourcePdf = await PDFDocument.load(data);
    const removeIndexes = new Set(getNormalizedPageIndexes(sourcePdf.getPageCount(), pages));
    const keptIndexes = sourcePdf
        .getPageIndices()
        .filter((index) => !removeIndexes.has(index));
    const { targetPdf } = await copySelectedPages({
        sourcePdf,
        pageIndexes: keptIndexes,
    });
    return toSavedPdfResult(targetPdf);
}

export async function extractPdfPages(
    data: Uint8Array,
    pages: number[],
): Promise<IPageMutationWorkerResult> {
    const sourcePdf = await PDFDocument.load(data);
    const selectedIndexes = getNormalizedPageIndexes(
        sourcePdf.getPageCount(),
        pages,
    );
    const { targetPdf } = await copySelectedPages({
        sourcePdf,
        pageIndexes: selectedIndexes,
    });
    return toSavedPdfResult(targetPdf);
}

export async function reorderPdfPages(
    data: Uint8Array,
    newOrder: number[],
): Promise<IPageMutationWorkerResult> {
    const sourcePdf = await PDFDocument.load(data);
    const selectedIndexes = getNormalizedPageIndexes(
        sourcePdf.getPageCount(),
        newOrder,
    );
    const { targetPdf } = await copySelectedPages({
        sourcePdf,
        pageIndexes: selectedIndexes,
    });
    return toSavedPdfResult(targetPdf);
}

export async function insertPdfPages(
    data: Uint8Array,
    insertionData: Uint8Array,
    afterPage: number,
): Promise<IPageMutationWorkerResult> {
    const destinationPdf = await PDFDocument.load(data);
    const insertionPdf = await PDFDocument.load(insertionData);
    const nextPdf = await PDFDocument.create();
    const beforeIndexes = destinationPdf
        .getPageIndices()
        .filter((index) => index < afterPage);
    const afterIndexes = destinationPdf
        .getPageIndices()
        .filter((index) => index >= afterPage);

    await copySelectedPages({
        sourcePdf: destinationPdf,
        targetPdf: nextPdf,
        pageIndexes: beforeIndexes,
    });
    await copySelectedPages({
        sourcePdf: insertionPdf,
        targetPdf: nextPdf,
        pageIndexes: insertionPdf.getPageIndices(),
    });
    await copySelectedPages({
        sourcePdf: destinationPdf,
        targetPdf: nextPdf,
        pageIndexes: afterIndexes,
    });

    return toSavedPdfResult(nextPdf);
}

export async function rotatePdfBytes(
    data: Uint8Array,
    pages: number[],
    angle: 90 | 180 | 270,
): Promise<IPageMutationWorkerResult> {
    const pdfDocument = await PDFDocument.load(data);
    for (const pageNumber of pages) {
        const page = pdfDocument.getPage(pageNumber - 1);
        if (!page) {
            continue;
        }

        const currentRotation = page.getRotation().angle;
        page.setRotation(
            degrees(((currentRotation + angle) % 360) as 0 | 90 | 180 | 270),
        );
    }

    return toSavedPdfResult(pdfDocument);
}

export async function cropPdfBytes(
    data: Uint8Array,
    pages: number[],
    margins: ICropMargins,
): Promise<IPageMutationWorkerResult> {
    const pdfDocument = await PDFDocument.load(data);
    for (const pageNumber of pages) {
        const page = pdfDocument.getPage(pageNumber - 1);
        if (!page) {
            continue;
        }

        const mediaBox = page.getMediaBox();
        const cropX = mediaBox.x + margins.left;
        const cropY = mediaBox.y + margins.bottom;
        const cropWidth = mediaBox.width - margins.left - margins.right;
        const cropHeight = mediaBox.height - margins.top - margins.bottom;
        if (cropWidth <= 0 || cropHeight <= 0) {
            continue;
        }

        page.setCropBox(cropX, cropY, cropWidth, cropHeight);
    }

    return toSavedPdfResult(pdfDocument);
}

export async function removeCropPdfBytes(
    data: Uint8Array,
    pages: number[],
): Promise<IPageMutationWorkerResult> {
    const pdfDocument = await PDFDocument.load(data);
    for (const pageNumber of pages) {
        const page = pdfDocument.getPage(pageNumber - 1);
        if (!page) {
            continue;
        }

        const mediaBox = page.getMediaBox();
        const cropBox = page.getCropBox();
        if (
            cropBox.x === mediaBox.x &&
            cropBox.y === mediaBox.y &&
            cropBox.width === mediaBox.width &&
            cropBox.height === mediaBox.height
        ) {
            page.node.delete(PDFName.of('CropBox'));
            continue;
        }

        page.setCropBox(
            mediaBox.x,
            mediaBox.y,
            mediaBox.width,
            mediaBox.height,
        );
    }

    return toSavedPdfResult(pdfDocument);
}

export async function getPageGeometryFromPdfBytes(
    data: Uint8Array,
    pageNumber: number,
): Promise<IPageGeometry> {
    const pdfDocument = await PDFDocument.load(data);
    const page = pdfDocument.getPage(pageNumber - 1);
    if (!page) {
        throw new Error(`Page ${pageNumber} not found`);
    }

    const mediaBox = page.getMediaBox();
    const resolvedCropBox = page.getCropBox();
    const cropBox =
        resolvedCropBox.x === mediaBox.x &&
        resolvedCropBox.y === mediaBox.y &&
        resolvedCropBox.width === mediaBox.width &&
        resolvedCropBox.height === mediaBox.height
            ? null
            : resolvedCropBox;

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
        rotation: page.getRotation().angle,
    };
}
