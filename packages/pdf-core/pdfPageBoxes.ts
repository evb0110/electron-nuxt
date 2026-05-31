import type {
    PDFDocument,
    PDFPage,
} from 'pdf-lib';

export interface IPdfPageBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

export type TPdfRect = [number, number, number, number];

export function arePdfPageBoxesEqual(left: IPdfPageBox, right: IPdfPageBox) {
    return left.x === right.x
        && left.y === right.y
        && left.width === right.width
        && left.height === right.height;
}

export function normalizePdfPageBox(box: IPdfPageBox): IPdfPageBox | null {
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

export function intersectPdfPageBoxes(left: IPdfPageBox, right: IPdfPageBox): IPdfPageBox | null {
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

export function resolvePdfLibMediaBox(page: PDFPage): IPdfPageBox {
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

export function resolvePdfLibCropBox(page: PDFPage, mediaBox: IPdfPageBox): IPdfPageBox | null {
    const cropBox = normalizePdfPageBox(page.getCropBox());
    if (!cropBox || arePdfPageBoxesEqual(cropBox, mediaBox)) {
        return null;
    }

    const effectiveCropBox = intersectPdfPageBoxes(cropBox, mediaBox);
    if (!effectiveCropBox || arePdfPageBoxesEqual(effectiveCropBox, mediaBox)) {
        return null;
    }

    return effectiveCropBox;
}

export function toPdfRect(box: IPdfPageBox): TPdfRect {
    return [
        box.x,
        box.y,
        box.x + box.width,
        box.y + box.height,
    ];
}

export function fromPdfRect(rect: TPdfRect): IPdfPageBox | null {
    return normalizePdfPageBox({
        x: rect[0],
        y: rect[1],
        width: rect[2] - rect[0],
        height: rect[3] - rect[1],
    });
}

export function resolvePdfLibPageView(page: ReturnType<PDFDocument['getPages']>[number]): TPdfRect {
    const mediaBox = resolvePdfLibMediaBox(page);
    const cropBox = resolvePdfLibCropBox(page, mediaBox);
    return toPdfRect(cropBox ?? mediaBox);
}
