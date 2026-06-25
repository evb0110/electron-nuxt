import type { PDFDocument } from 'pdf-lib';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { updateAnnotationTextByRef } from '@app/modules/pdf-viewer/engine/pdf-serialization-comments/updateAnnotationTextByRef';
import { resolveCommentPdfRefInDocument } from '@app/modules/pdf-viewer/engine/pdf-serialization-refs/resolveCommentPdfRefInDocument';
import { parsePdfAnnotationStableKeyRef } from '@app/modules/pdf-viewer/engine/pdf-serialization-refs/parsePdfAnnotationStableKey';

function buildCommentFromEmbeddedUpdateStableKey(
    stableKey: string,
): IAnnotationCommentSummary | null {
    const parsed = parsePdfAnnotationStableKeyRef(stableKey);
    if (!parsed) {
        return null;
    }

    return {
        id: parsed.annotationId,
        stableKey: parsed.stableKey,
        sortIndex: null,
        pageIndex: parsed.pageIndex,
        pageNumber: parsed.pageIndex + 1,
        text: '',
        kindLabel: 'Note',
        subtype: 'FreeText',
        author: null,
        modifiedAt: null,
        color: null,
        uid: null,
        annotationId: parsed.annotationId,
        source: 'pdf',
        hasNote: true,
        markerRect: null,
    };
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
    const unresolvedStableKeys: string[] = [];
    for (const [
        stableKey,
        text,
    ] of pendingUpdates) {
        const comment = commentsByKey.get(stableKey) ?? buildCommentFromEmbeddedUpdateStableKey(stableKey);
        if (!comment) {
            unresolvedStableKeys.push(stableKey);
            continue;
        }

        const targetRef = resolveCommentPdfRefInDocument(doc, comment);
        if (!targetRef) {
            unresolvedStableKeys.push(stableKey);
            continue;
        }

        if (updateAnnotationTextByRef(doc, targetRef, text)) {
            modified = true;
        } else {
            unresolvedStableKeys.push(stableKey);
        }
    }

    if (unresolvedStableKeys.length > 0) {
        throw new Error(`Unable to apply embedded note text updates for ${unresolvedStableKeys.length} annotation(s): ${unresolvedStableKeys.join(', ')}`);
    }

    return modified;
}
