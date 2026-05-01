import type {PDFDocument} from 'pdf-lib';
import {
    PDFArray,
    PDFDict,
    PDFHexString,
    PDFName,
    PDFRef,
    PDFString,
} from 'pdf-lib';
import { getPdfDictSubtype } from '@app/utils/pdf-dict';
import { normalizeAnnotationSubtypeToken } from '@app/utils/text-normalization';
import { toPdfDateString } from '@app/utils/pdf-date';

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

export function collectAnnotationRefsToDelete(doc: PDFDocument, targetRef: PDFRef) {
    const refs = new Map<string, PDFRef>();
    const enqueueRef = (ref: PDFRef | null) => {
        if (!ref) {
            return false;
        }
        const key = ref.toString();
        if (refs.has(key)) {
            return false;
        }
        refs.set(key, ref);
        return true;
    };

    enqueueRef(targetRef);

    let pending = [targetRef];
    while (pending.length > 0) {
        const currentBatch = pending;
        pending = [];
        currentBatch.forEach((ref) => {
            const dict = doc.context.lookupMaybe(ref, PDFDict);
            if (!dict) {
                return;
            }

            const popupValue = dict.get(PDFName.of('Popup'));
            if (popupValue instanceof PDFRef && enqueueRef(popupValue)) {
                pending.push(popupValue);
            }

            const parentValue = dict.get(PDFName.of('Parent'));
            if (parentValue instanceof PDFRef) {
                const parentDict = doc.context.lookupMaybe(parentValue, PDFDict);
                const parentSubtype = normalizeAnnotationSubtypeToken(getPdfDictSubtype(parentDict ?? null));
                if ((parentSubtype === 'freetext' || parentSubtype === 'popup') && enqueueRef(parentValue)) {
                    pending.push(parentValue);
                }
            }
        });
    }

    return Array.from(refs.values());
}

export function removeAnnotationRefsFromPages(doc: PDFDocument, refsToRemove: PDFRef[]) {
    if (refsToRemove.length === 0) {
        return false;
    }

    const refTags = new Set(refsToRemove.map(ref => ref.toString()));
    let removed = false;

    doc.getPages().forEach((page) => {
        const annots = page.node.Annots();
        if (!(annots instanceof PDFArray)) {
            return;
        }

        for (let index = annots.size() - 1; index >= 0; index -= 1) {
            const value = annots.get(index);
            if (!(value instanceof PDFRef)) {
                continue;
            }
            if (!refTags.has(value.toString())) {
                continue;
            }
            annots.remove(index);
            removed = true;
        }
    });

    return removed;
}
