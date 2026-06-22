import type {
    PDFDocument,
    PDFRef,
} from 'pdf-lib';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { collectAnnotationRefsToDelete } from '@app/modules/pdf-viewer/engine/pdf-serialization-comments/collectAnnotationRefsToDelete';
import { removeAnnotationRefsFromPages } from '@app/modules/pdf-viewer/engine/pdf-serialization-comments/removeAnnotationRefsFromPages';
import { resolveCommentPdfRefInDocument } from '@app/modules/pdf-viewer/engine/pdf-serialization-refs/resolveCommentPdfRefInDocument';
import { formatPdfJsAnnotationRef } from '@app/utils/pdfAnnotationRefs';

export function applyEmbeddedAnnotationDeletes(
    doc: PDFDocument,
    comments: IAnnotationCommentSummary[],
) {
    if (comments.length === 0) {
        return false;
    }

    const refsToDeleteByTag = new Map<string, PDFRef>();
    const unresolvedDeleteKeys: string[] = [];
    for (const comment of comments) {
        const targetRef = resolveCommentPdfRefInDocument(doc, comment);
        if (!targetRef) {
            unresolvedDeleteKeys.push(comment.stableKey ?? comment.id ?? comment.annotationId ?? 'unknown');
            continue;
        }

        const refsToDelete = collectAnnotationRefsToDelete(doc, targetRef);
        if (refsToDelete.length === 0) {
            unresolvedDeleteKeys.push(comment.stableKey ?? comment.id ?? comment.annotationId ?? formatPdfJsAnnotationRef(targetRef));
            continue;
        }

        refsToDelete.forEach((ref) => {
            refsToDeleteByTag.set(formatPdfJsAnnotationRef(ref), ref);
        });
    }

    if (unresolvedDeleteKeys.length > 0) {
        throw new Error(`Unable to resolve embedded annotation deletes for ${unresolvedDeleteKeys.length} annotation(s): ${unresolvedDeleteKeys.join(', ')}`);
    }

    if (refsToDeleteByTag.size === 0 || !removeAnnotationRefsFromPages(doc, [...refsToDeleteByTag.values()])) {
        const deleteKeys = comments
            .map(comment => comment.stableKey ?? comment.id ?? comment.annotationId ?? 'unknown')
            .join(', ');
        throw new Error(`Unable to apply embedded annotation deletes for ${comments.length} annotation(s): ${deleteKeys}`);
    }

    return true;
}
