import type {
    PDFDict,
    PDFDocument,
} from 'pdf-lib';
import { PDFName } from 'pdf-lib';

export function setBorderWidth(annotDict: PDFDict, doc: PDFDocument, strokeWidth: number) {
    annotDict.set(PDFName.of('Border'), doc.context.obj([
        0,
        0,
        strokeWidth,
    ]));
}
