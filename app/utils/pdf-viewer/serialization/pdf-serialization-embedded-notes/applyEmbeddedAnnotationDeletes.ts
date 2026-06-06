import type {
    PDFDocument,
    PDFRef,
} from 'pdf-lib';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { collectAnnotationRefsToDelete } from '@app/utils/pdf-viewer/pdf-serialization-comments/collectAnnotationRefsToDelete';
import { removeAnnotationRefsFromPages } from '@app/utils/pdf-viewer/pdf-serialization-comments/removeAnnotationRefsFromPages';
import { resolveCommentPdfRefInDocument } from '@app/utils/pdf-viewer/pdf-serialization-refs/resolveCommentPdfRefInDocument';
import { refToTag } from '@app/utils/pdf-viewer/serialization/pdf-serialization-shared/refToTag';

export function applyEmbeddedAnnotationDeletes(
    doc: PDFDocument,
    comments: IAnnotationCommentSummary[],
) {
    if (comments.length === 0) {
        return false;
    }

    const refsToDeleteByTag = new Map<string, PDFRef>();
    for (const comment of comments) {
        const targetRef = resolveCommentPdfRefInDocument(doc, comment);
        if (!targetRef) {
            continue;
        }

        collectAnnotationRefsToDelete(doc, targetRef).forEach((ref) => {
            refsToDeleteByTag.set(refToTag(ref), ref);
        });
    }

    if (refsToDeleteByTag.size === 0) {
        return false;
    }

    return removeAnnotationRefsFromPages(doc, [...refsToDeleteByTag.values()]);
}
