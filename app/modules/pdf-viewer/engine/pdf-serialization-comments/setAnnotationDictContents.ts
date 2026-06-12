import type { PDFDict } from 'pdf-lib';
import {
    PDFHexString,
    PDFName,
    PDFString,
} from 'pdf-lib';

export function setAnnotationDictContents(
    dict: PDFDict | null,
    text: string,
    modifiedAt: string,
) {
    if (!dict) {
        return false;
    }

    dict.set(PDFName.of('Contents'), PDFHexString.fromText(text));
    dict.set(PDFName.of('M'), PDFString.of(modifiedAt));
    return true;
}
