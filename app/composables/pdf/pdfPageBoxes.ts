import type {
    PDFDict,
    PDFDocument,
} from 'pdf-lib';
import {
    PDFArray,
    PDFName,
    PDFNumber,
} from 'pdf-lib';

const CROP_BOX_NAME = PDFName.of('CropBox');
const MEDIA_BOX_NAME = PDFName.of('MediaBox');
const RECT_NAME = PDFName.of('Rect');

export function numberFromPdfBox(box: PDFArray, index: number) {
    const value = box.get(index);
    return value instanceof PDFNumber ? value.asNumber() : null;
}

export function resolvePdfPageView(page: ReturnType<PDFDocument['getPages']>[number]) {
    const fallbackSize = page.getSize();
    if (fallbackSize.width <= 0 || fallbackSize.height <= 0) {
        return null;
    }

    const fallbackView: [number, number, number, number] = [
        0,
        0,
        fallbackSize.width,
        fallbackSize.height,
    ];

    const box = (
        page.node.lookupMaybe(CROP_BOX_NAME, PDFArray)
        ?? page.node.lookupMaybe(MEDIA_BOX_NAME, PDFArray)
    );
    if (!(box instanceof PDFArray) || box.size() < 4) {
        return fallbackView;
    }

    const x1 = numberFromPdfBox(box, 0);
    const y1 = numberFromPdfBox(box, 1);
    const x2 = numberFromPdfBox(box, 2);
    const y2 = numberFromPdfBox(box, 3);
    if (
        x1 === null
        || y1 === null
        || x2 === null
        || y2 === null
    ) {
        return fallbackView;
    }

    const minX = Math.min(x1, x2);
    const minY = Math.min(y1, y2);
    const maxX = Math.max(x1, x2);
    const maxY = Math.max(y1, y2);
    if ((maxX - minX) <= 0 || (maxY - minY) <= 0) {
        return fallbackView;
    }

    return [
        minX,
        minY,
        maxX,
        maxY,
    ] as [number, number, number, number];
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
