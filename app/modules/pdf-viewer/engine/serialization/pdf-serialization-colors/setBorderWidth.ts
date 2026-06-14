import type { PDFDocument } from 'pdf-lib';
import {
    PDFDict,
    PDFName,
} from 'pdf-lib';

const BORDER_NAME = PDFName.of('Border');
const BORDER_STYLE_NAME = PDFName.of('BS');
const BORDER_STYLE_WIDTH_NAME = PDFName.of('W');

function setBorderStyleWidth(annotDict: PDFDict, doc: PDFDocument, strokeWidth: number) {
    const borderStyle = annotDict.lookupMaybe(BORDER_STYLE_NAME, PDFDict);
    if (borderStyle) {
        borderStyle.set(BORDER_STYLE_WIDTH_NAME, doc.context.obj(strokeWidth));
        return;
    }

    annotDict.set(BORDER_STYLE_NAME, doc.context.obj({ W: strokeWidth }));
}

export function setBorderWidth(annotDict: PDFDict, doc: PDFDocument, strokeWidth: number) {
    annotDict.set(BORDER_NAME, doc.context.obj([
        0,
        0,
        strokeWidth,
    ]));
    setBorderStyleWidth(annotDict, doc, strokeWidth);
}
