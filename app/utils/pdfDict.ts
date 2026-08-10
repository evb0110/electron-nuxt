import type { PDFDict } from 'pdf-lib';
import {
    PDFHexString,
    PDFName,
    PDFString,
} from 'pdf-lib';

export function getPdfStringValue(value: unknown) {
    if (value instanceof PDFHexString || value instanceof PDFString) {
        return value.decodeText();
    }
    return '';
}

export function getPdfDictSubtype(dict: PDFDict | null) {
    if (!dict) {
        return null;
    }
    const subtype = dict.lookupMaybe(PDFName.of('Subtype'), PDFName);
    if (!(subtype instanceof PDFName)) {
        return null;
    }
    return subtype.decodeText();
}

export function getPdfDictContents(dict: PDFDict | null) {
    if (!dict) {
        return '';
    }
    return getPdfStringValue(dict.get(PDFName.of('Contents')));
}
