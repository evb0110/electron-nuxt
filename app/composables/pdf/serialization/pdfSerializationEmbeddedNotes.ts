import type {
    PDFDocument,
    PDFRef,
} from 'pdf-lib';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import {
    collectAnnotationRefsToDelete,
    removeAnnotationRefsFromPages,
    updateAnnotationTextByRef,
} from '@app/composables/pdf/pdfSerializationComments';
import {
    parsePdfJsAnnotationRef,
    resolveCommentPdfRefInDocument,
} from '@app/composables/pdf/pdfSerializationRefs';
import { refToTag } from './pdfSerializationShared';

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

export function applyEmbeddedNoteTextUpdates(
    doc: PDFDocument,
    comments: IAnnotationCommentSummary[],
    pendingUpdates: Array<readonly [string, string]>,
) {
    if (pendingUpdates.length === 0) {
        return false;
    }

    const commentsByKey = new Map<string, IAnnotationCommentSummary>();
    comments.forEach((comment) => {
        const match = pendingUpdates.some(([stableKey]) => stableKey === comment.stableKey);
        if (match) {
            commentsByKey.set(comment.stableKey, comment);
        }
    });

    let modified = false;
    for (const [
        stableKey,
        text,
    ] of pendingUpdates) {
        const comment = commentsByKey.get(stableKey) ?? buildCommentFromEmbeddedUpdateStableKey(stableKey);
        if (!comment) {
            continue;
        }

        const targetRef = resolveCommentPdfRefInDocument(doc, comment);
        if (!targetRef) {
            continue;
        }

        if (updateAnnotationTextByRef(doc, targetRef, text)) {
            modified = true;
        }
    }

    return modified;
}

function buildCommentFromEmbeddedUpdateStableKey(
    stableKey: string,
): IAnnotationCommentSummary | null {
    const match = stableKey.trim().match(/^ann:(\d+):(\d+R(?:\d+)?)$/iu);
    if (!match?.[1] || !match[2]) {
        return null;
    }

    const pageIndex = Number(match[1]);
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || !parsePdfJsAnnotationRef(match[2])) {
        return null;
    }

    return {
        id: match[2],
        stableKey,
        sortIndex: null,
        pageIndex,
        pageNumber: pageIndex + 1,
        text: '',
        kindLabel: 'Note',
        subtype: 'FreeText',
        author: null,
        modifiedAt: null,
        color: null,
        uid: null,
        annotationId: match[2],
        source: 'pdf',
        hasNote: true,
        markerRect: null,
    };
}
