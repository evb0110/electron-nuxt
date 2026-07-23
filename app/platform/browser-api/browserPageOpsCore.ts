import {
    PDFDocument,
    degrees,
} from 'pdf-lib';
import type { PDFPage } from 'pdf-lib';
import type {
    ICropMargins,
    IPageGeometry,
} from '@contracts/shared';
import { normalizeCropMargins } from '@contracts/shared';
import type { IPageMutationWorkerResult } from '@app/platform/browser-api/browserPageOpsWorker.types';
import {
    resolvePdfLibCropBox,
    resolvePdfLibMediaBox,
} from '@pdf-core/pdfPageBoxes';
import { tryRunBrowserPageOpsWithWasm } from '@app/platform/browser-api/tryRunBrowserPageOpsWithWasm';

function toSavedPdfResult(
    pdfDocument: PDFDocument,
): Promise<IPageMutationWorkerResult> {
    return pdfDocument.save().then((data) => ({
        data: new Uint8Array(data),
        pageCount: pdfDocument.getPageCount(),
    }));
}

function getNormalizedPageIndexes(pages: number[]) {
    return pages.map((page) => page - 1);
}

function getPageIndexRange(start: number, end: number) {
    const pageIndexes: number[] = [];
    for (let index = start; index < end; index += 1) {
        pageIndexes.push(index);
    }
    return pageIndexes;
}

function getKeptPageIndexes(pageCount: number, removePages: Set<number>) {
    const keptIndexes: number[] = [];
    for (let index = 0; index < pageCount; index += 1) {
        if (!removePages.has(index + 1)) {
            keptIndexes.push(index);
        }
    }
    return keptIndexes;
}

function toPageBoxGeometry(box: {
    x: number;
    y: number;
    width: number;
    height: number;
}) {
    return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
    };
}

function getCropBoxFromMargins(
    mediaBox: {
        x: number;
        y: number;
        width: number;
        height: number;
    },
    margins: ICropMargins,
) {
    return {
        x: mediaBox.x + margins.left,
        y: mediaBox.y + margins.bottom,
        width: mediaBox.width - margins.left - margins.right,
        height: mediaBox.height - margins.top - margins.bottom,
    };
}

function validatePageNumbers(
    pages: number[],
    label: string,
    options: {
        pageCount: number;
        requireUnique?: boolean;
        requirePermutation?: boolean;
    },
) {
    if (!Array.isArray(pages) || pages.length === 0) {
        throw new Error(`${label}: must be a non-empty array of page numbers`);
    }

    const pageSet = collectValidatedPageNumberSet(pages, label, options);

    if (options.requirePermutation) {
        validatePageNumberPermutation(pageSet, label, options.pageCount);
    }

    return pageSet;
}

function collectValidatedPageNumberSet(
    pages: number[],
    label: string,
    options: {
        pageCount: number;
        requireUnique?: boolean;
    },
) {
    const pageSet = new Set<number>();
    for (const page of pages) {
        validatePageNumber(page, label, options.pageCount);
        if (options.requireUnique && pageSet.has(page)) {
            throw new Error(`${label}: duplicate page number ${page}`);
        }
        pageSet.add(page);
    }
    return pageSet;
}

function validatePageNumber(page: number, label: string, pageCount: number) {
    if (!Number.isInteger(page) || page < 1) {
        throw new Error(`${label}: invalid page number ${page}`);
    }
    if (page > pageCount) {
        throw new Error(`${label}: page number ${page} is out of range 1-${pageCount}`);
    }
}

function validatePageNumberPermutation(pageSet: Set<number>, label: string, pageCount: number) {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        if (!pageSet.has(pageNumber)) {
            throw new Error(`${label}: missing page ${pageNumber} in reorder payload`);
        }
    }
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

async function mutateValidatedPdfPages(
    data: Uint8Array,
    pages: number[],
    label: string,
    mutatePage: (page: PDFPage) => void,
) {
    const pdfDocument = await PDFDocument.load(data);
    validatePageNumbers(pages, label, {
        pageCount: pdfDocument.getPageCount(),
        requireUnique: true,
    });
    for (const pageNumber of pages) {
        const page = pdfDocument.getPage(pageNumber - 1);
        if (!page) {
            continue;
        }

        mutatePage(page);
    }

    return toSavedPdfResult(pdfDocument);
}

export async function deletePdfPages(
    data: Uint8Array,
    pages: number[],
): Promise<IPageMutationWorkerResult> {
    const wasmResult = await tryRunBrowserPageOpsWithWasm('deletePages', {
        data,
        pages,
    });
    if (wasmResult) {
        return wasmResult;
    }

    const sourcePdf = await PDFDocument.load(data);
    const removePages = validatePageNumbers(pages, 'deletePages', {
        pageCount: sourcePdf.getPageCount(),
        requireUnique: true,
    });
    if (removePages.size === sourcePdf.getPageCount()) {
        throw new Error('deletePages: cannot delete every page');
    }
    const keptIndexes = getKeptPageIndexes(sourcePdf.getPageCount(), removePages);
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
    const wasmResult = await tryRunBrowserPageOpsWithWasm('extractPages', {
        data,
        pages,
    });
    if (wasmResult) {
        return wasmResult;
    }

    const sourcePdf = await PDFDocument.load(data);
    validatePageNumbers(pages, 'extractPages', {
        pageCount: sourcePdf.getPageCount(),
        requireUnique: true,
    });
    const selectedIndexes = getNormalizedPageIndexes(pages);
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
    const wasmResult = await tryRunBrowserPageOpsWithWasm('reorderPages', {
        data,
        newOrder,
    });
    if (wasmResult) {
        return wasmResult;
    }

    const sourcePdf = await PDFDocument.load(data);
    validatePageNumbers(newOrder, 'reorderPages', {
        pageCount: sourcePdf.getPageCount(),
        requireUnique: true,
        requirePermutation: true,
    });
    const selectedIndexes = getNormalizedPageIndexes(newOrder);
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
    const wasmResult = await tryRunBrowserPageOpsWithWasm('insertPages', {
        data,
        insertionData,
        afterPage,
    });
    if (wasmResult) {
        return wasmResult;
    }

    const destinationPdf = await PDFDocument.load(data);
    const insertionPdf = await PDFDocument.load(insertionData);
    if (!Number.isInteger(afterPage) || afterPage < 0 || afterPage > destinationPdf.getPageCount()) {
        throw new Error('Invalid afterPage');
    }
    const nextPdf = await PDFDocument.create();
    const beforeIndexes = getPageIndexRange(0, afterPage);
    const afterIndexes = getPageIndexRange(afterPage, destinationPdf.getPageCount());

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
    const wasmResult = await tryRunBrowserPageOpsWithWasm('rotate', {
        data,
        pages,
        angle,
    });
    if (wasmResult) {
        return wasmResult;
    }

    return mutateValidatedPdfPages(data, pages, 'rotatePages', (page) => {
        const currentRotation = page.getRotation().angle;
        page.setRotation(
            degrees(((currentRotation + angle) % 360)),
        );
    });
}

export async function cropPdfBytes(
    data: Uint8Array,
    pages: number[],
    margins: ICropMargins,
): Promise<IPageMutationWorkerResult> {
    const normalizedMargins = normalizeCropMargins(margins);
    const pdfDocument = await PDFDocument.load(data);
    validatePageNumbers(pages, 'cropPages', {
        pageCount: pdfDocument.getPageCount(),
        requireUnique: true,
    });
    const selectedPages = pages.map((pageNumber) => {
        const page = pdfDocument.getPage(pageNumber - 1);
        const cropBox = getCropBoxFromMargins(resolvePdfLibMediaBox(page), normalizedMargins);
        if (cropBox.width <= 0 || cropBox.height <= 0) {
            throw new Error(`Crop margins consume page ${pageNumber}`);
        }
        return {
            cropBox,
            page,
        };
    });
    const wasmResult = await tryRunBrowserPageOpsWithWasm('crop', {
        data,
        pages,
        margins: normalizedMargins,
    });
    if (wasmResult) {
        return wasmResult;
    }

    selectedPages.forEach(({
        cropBox,
        page,
    }) => {
        page.setCropBox(
            cropBox.x,
            cropBox.y,
            cropBox.width,
            cropBox.height,
        );
    });
    return toSavedPdfResult(pdfDocument);
}

export async function removeCropPdfBytes(
    data: Uint8Array,
    pages: number[],
): Promise<IPageMutationWorkerResult> {
    const wasmResult = await tryRunBrowserPageOpsWithWasm('removeCrop', {
        data,
        pages,
    });
    if (wasmResult) {
        return wasmResult;
    }

    return mutateValidatedPdfPages(data, pages, 'removeCrop', (page) => {
        const mediaBox = resolvePdfLibMediaBox(page);
        page.setCropBox(
            mediaBox.x,
            mediaBox.y,
            mediaBox.width,
            mediaBox.height,
        );
    });
}

export async function getPageGeometryFromPdfBytes(
    data: Uint8Array,
    pageNumber: number,
): Promise<IPageGeometry> {
    const wasmResult = await tryRunBrowserPageOpsWithWasm('getPageGeometry', {
        data,
        pageNumber,
    });
    if (wasmResult) {
        return wasmResult;
    }

    const pdfDocument = await PDFDocument.load(data);
    const page = pdfDocument.getPage(pageNumber - 1);
    if (!page) {
        throw new Error(`Page ${pageNumber} not found`);
    }

    const mediaBox = resolvePdfLibMediaBox(page);
    const cropBox = resolvePdfLibCropBox(page, mediaBox);

    return {
        mediaBox: toPageBoxGeometry(mediaBox),
        cropBox: cropBox
            ? toPageBoxGeometry(cropBox)
            : null,
        rotation: page.getRotation().angle,
    };
}
