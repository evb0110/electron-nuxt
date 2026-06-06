import type { PDFArray } from 'pdf-lib';
import { PDFNumber } from 'pdf-lib';

export function numberFromPdfBox(box: PDFArray, index: number) {
    const value = box.get(index);
    return value instanceof PDFNumber ? value.asNumber() : null;
}
