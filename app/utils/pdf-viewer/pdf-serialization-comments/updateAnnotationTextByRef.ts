import type { PDFDocument } from 'pdf-lib';
import {
    PDFDict,
    PDFName,
    PDFRef,
} from 'pdf-lib';
import { getPdfDictSubtype } from '@app/utils/pdfDict';
import { normalizeAnnotationSubtypeToken } from '@app/utils/textNormalization';
import { toPdfDateString } from '@app/utils/pdfDate';
import { setAnnotationDictContents } from '@app/utils/pdf-viewer/pdf-serialization-comments/setAnnotationDictContents';

export function updateAnnotationTextByRef(
    doc: PDFDocument,
    targetRef: PDFRef,
    text: string,
) {
    const targetDict = doc.context.lookupMaybe(targetRef, PDFDict);
    if (!targetDict) {
        return false;
    }

    const modifiedAt = toPdfDateString(new Date());
    const targetSubtype = normalizeAnnotationSubtypeToken(getPdfDictSubtype(targetDict));

    // FreeText /Contents is safe to update because rewriteFreeTextNoteRects
    // replaces the AP stream with a blank Form XObject, preventing the text
    // from rendering on the canvas.  The Popup reads /Contents from its
    // parent (the FreeText dict), so this also updates the popup text.
    let updated = setAnnotationDictContents(targetDict, text, modifiedAt);

    const popupValue = targetDict.get(PDFName.of('Popup'));
    if (popupValue instanceof PDFRef) {
        updated = setAnnotationDictContents(doc.context.lookupMaybe(popupValue, PDFDict) ?? null, text, modifiedAt) || updated;
    } else if (popupValue instanceof PDFDict) {
        updated = setAnnotationDictContents(popupValue, text, modifiedAt) || updated;
    }

    if (targetSubtype === 'popup') {
        const parentValue = targetDict.get(PDFName.of('Parent'));
        const parentDict = parentValue instanceof PDFRef
            ? doc.context.lookupMaybe(parentValue, PDFDict) ?? null
            : parentValue instanceof PDFDict
                ? parentValue
                : null;
        if (parentDict) {
            updated = setAnnotationDictContents(parentDict, text, modifiedAt) || updated;
        }
    }

    return updated;
}
