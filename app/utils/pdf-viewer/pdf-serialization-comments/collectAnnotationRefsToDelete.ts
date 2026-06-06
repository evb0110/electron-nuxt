import type { PDFDocument } from 'pdf-lib';
import {
    PDFDict,
    PDFName,
    PDFRef,
} from 'pdf-lib';
import { getPdfDictSubtype } from '@app/utils/pdfDict';
import { normalizeAnnotationSubtypeToken } from '@app/utils/textNormalization';

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
