import { PDFDocument } from 'pdf-lib';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { collectAnnotationRefsToDelete } from '@app/utils/pdf-viewer/pdf-serialization-comments/collectAnnotationRefsToDelete';
import { removeAnnotationRefsFromPages } from '@app/utils/pdf-viewer/pdf-serialization-comments/removeAnnotationRefsFromPages';
import { resolveCommentPdfRefInDocument } from '@app/utils/pdf-viewer/pdf-serialization-refs/resolveCommentPdfRefInDocument';

export async function deleteEmbeddedAnnotation(
    data: Uint8Array,
    comment: IAnnotationCommentSummary,
) {
    const doc = await PDFDocument.load(data, { updateMetadata: false });
    const targetRef = resolveCommentPdfRefInDocument(doc, comment);
    if (!targetRef) {
        return null;
    }

    const refsToDelete = collectAnnotationRefsToDelete(doc, targetRef);
    if (!removeAnnotationRefsFromPages(doc, refsToDelete)) {
        return null;
    }

    return new Uint8Array(await doc.save());
}
