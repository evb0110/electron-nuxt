import type { PDFDocument } from 'pdf-lib';
import {
    PDFDict,
    PDFHexString,
    PDFName,
    PDFRef,
    PDFStream,
    PDFString,
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

            const subtype = normalizeAnnotationSubtypeToken(getPdfDictSubtype(dict));
            const name = dict.get(PDFName.of('NM'));
            const isManagedPlacedImage = subtype === 'stamp'
                && (name instanceof PDFHexString || name instanceof PDFString)
                && name.decodeText().startsWith('placed-image-');
            if (isManagedPlacedImage) {
                const appearanceRef = dict
                    .lookupMaybe(PDFName.of('AP'), PDFDict)
                    ?.get(PDFName.of('N'));
                if (appearanceRef instanceof PDFRef) {
                    enqueueRef(appearanceRef);
                    const appearance = doc.context.lookupMaybe(appearanceRef, PDFStream);
                    const resources = appearance?.dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
                    const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
                    xobjects?.values().forEach((value) => {
                        if (value instanceof PDFRef) {
                            enqueueRef(value);
                        }
                    });
                }
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
