import type {
    PDFDict,
    PDFDocument,
} from 'pdf-lib';
import {
    PDFArray,
    PDFName,
    PDFNumber,
} from 'pdf-lib';

const RECT_NAME = PDFName.of('Rect');

type TPdfRect = [number, number, number, number];

export function numberFromPdfBox(box: PDFArray, index: number) {
    const value = box.get(index);
    return value instanceof PDFNumber ? value.asNumber() : null;
}

function normalizePdfRect(rect: TPdfRect): TPdfRect | null {
    const [
        x1,
        y1,
        x2,
        y2,
    ] = rect;
    const minX = Math.min(x1, x2);
    const minY = Math.min(y1, y2);
    const maxX = Math.max(x1, x2);
    const maxY = Math.max(y1, y2);

    if ((maxX - minX) <= 0 || (maxY - minY) <= 0) {
        return null;
    }

    return [
        minX,
        minY,
        maxX,
        maxY,
    ];
}

function arePdfRectsEqual(left: TPdfRect, right: TPdfRect) {
    return left[0] === right[0]
        && left[1] === right[1]
        && left[2] === right[2]
        && left[3] === right[3];
}

function intersectPdfRects(left: TPdfRect, right: TPdfRect): TPdfRect | null {
    const minX = Math.max(left[0], right[0]);
    const minY = Math.max(left[1], right[1]);
    const maxX = Math.min(left[2], right[2]);
    const maxY = Math.min(left[3], right[3]);

    if ((maxX - minX) <= 0 || (maxY - minY) <= 0) {
        return null;
    }

    return [
        minX,
        minY,
        maxX,
        maxY,
    ];
}

function normalizePdfPageBox(box: {
    x: number;
    y: number;
    width: number;
    height: number;
}) {
    return normalizePdfRect([
        box.x,
        box.y,
        box.x + box.width,
        box.y + box.height,
    ]);
}

export function resolvePdfPageView(page: ReturnType<PDFDocument['getPages']>[number]) {
    const fallbackSize = page.getSize();
    if (fallbackSize.width <= 0 || fallbackSize.height <= 0) {
        return null;
    }

    const fallbackView: TPdfRect = [
        0,
        0,
        fallbackSize.width,
        fallbackSize.height,
    ];

    const mediaBox = normalizePdfPageBox(page.getMediaBox()) ?? fallbackView;
    const cropBox = normalizePdfPageBox(page.getCropBox());
    if (!cropBox || arePdfRectsEqual(cropBox, mediaBox)) {
        return mediaBox;
    }

    return intersectPdfRects(cropBox, mediaBox) ?? mediaBox;
}

export function readPdfRectFromDict(dict: PDFDict): [number, number, number, number] | null {
    const rect = dict.lookupMaybe(RECT_NAME, PDFArray);
    if (!(rect instanceof PDFArray) || rect.size() < 4) {
        return null;
    }

    const x1 = numberFromPdfBox(rect, 0);
    const y1 = numberFromPdfBox(rect, 1);
    const x2 = numberFromPdfBox(rect, 2);
    const y2 = numberFromPdfBox(rect, 3);
    if (
        x1 === null
        || y1 === null
        || x2 === null
        || y2 === null
    ) {
        return null;
    }

    return [
        x1,
        y1,
        x2,
        y2,
    ];
}
