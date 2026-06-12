import {
    PDFDict,
    PDFDocument,
    PDFName,
    PDFRef,
} from 'pdf-lib';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { updateAnnotationTextByRef } from '@app/modules/pdf-viewer/engine/pdf-serialization-comments/updateAnnotationTextByRef';
import { resolveCommentPdfRefInDocument } from '@app/modules/pdf-viewer/engine/pdf-serialization-refs/resolveCommentPdfRefInDocument';
import { getPdfDictSubtype } from '@app/utils/pdfDict';
import { normalizeAnnotationSubtypeToken } from '@app/utils/textNormalization';
import { applyFreeTextNoteRects } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-free-text/applyFreeTextNoteRects';

export async function updateEmbeddedAnnotationText(
    data: Uint8Array,
    comment: IAnnotationCommentSummary,
    text: string,
) {
    const doc = await PDFDocument.load(data, { updateMetadata: false });
    const targetRef = resolveCommentPdfRefInDocument(doc, comment);
    if (!targetRef) {
        return null;
    }

    const targetDict = doc.context.lookupMaybe(targetRef, PDFDict);
    const targetSubtype = normalizeAnnotationSubtypeToken(getPdfDictSubtype(targetDict ?? null));
    const parentValue = targetDict?.get(PDFName.of('Parent'));
    const parentDict = parentValue instanceof PDFRef
        ? doc.context.lookupMaybe(parentValue, PDFDict) ?? null
        : parentValue instanceof PDFDict
            ? parentValue
            : null;
    const parentSubtype = normalizeAnnotationSubtypeToken(getPdfDictSubtype(parentDict));
    const freeTextRef = targetSubtype === 'freetext'
        ? targetRef
        : targetSubtype === 'popup' && parentSubtype === 'freetext' && parentValue instanceof PDFRef
            ? parentValue
            : null;

    if (freeTextRef) {
        applyFreeTextNoteRects(doc, [{
            ...comment,
            annotationId: `${freeTextRef.objectNumber}R${freeTextRef.generationNumber}`,
        }]);
    }

    if (!updateAnnotationTextByRef(doc, targetRef, text)) {
        return null;
    }

    return new Uint8Array(await doc.save());
}
