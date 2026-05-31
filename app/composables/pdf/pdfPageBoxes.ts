import type {
    PDFDict,
    PDFDocument,
} from 'pdf-lib';
import {
    PDFArray,
    PDFName,
    PDFNumber,
} from 'pdf-lib';
import { resolvePdfLibPageView } from '@pdf-core/pdfPageBoxes';

const RECT_NAME = PDFName.of('Rect');

export function numberFromPdfBox(box: PDFArray, index: number) {
    const value = box.get(index);
    return value instanceof PDFNumber ? value.asNumber() : null;
}

export function resolvePdfPageView(page: ReturnType<PDFDocument['getPages']>[number]) {
    try {
        return resolvePdfLibPageView(page);
    } catch {
        return null;
    }
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
