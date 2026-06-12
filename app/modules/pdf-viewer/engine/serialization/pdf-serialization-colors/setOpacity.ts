import type { PDFDict } from 'pdf-lib';
import {
    PDFName,
    PDFNumber,
} from 'pdf-lib';

export function setOpacity(annotDict: PDFDict, opacity: number) {
    annotDict.set(PDFName.of('CA'), PDFNumber.of(opacity));
}
