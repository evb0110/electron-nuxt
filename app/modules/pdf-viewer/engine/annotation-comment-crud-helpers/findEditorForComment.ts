import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import {
    clamp,
    range,
} from 'es-toolkit/math';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { editorIdsLikelyMatch } from '@app/modules/pdf-viewer/engine/annotation-comment-identity/editorIdsLikelyMatch';
import { getCommentCandidateIds } from '@app/modules/pdf-viewer/engine/annotation-comment-identity/getCommentCandidateIds';
import { getEditorsOnPage } from '@app/services/pdfjs/annotationEditorAdapter';

function getPreferredPageScanOrder(pageIndex: number, numPages: number) {
    const preferredPage = clamp(pageIndex, 0, Math.max(0, numPages - 1));
    return [
        preferredPage,
        ...range(numPages).filter(index => index !== preferredPage),
    ];
}

export function findEditorForComment(
    uiManager: AnnotationEditorUIManager | null,
    numPages: number,
    comment: IAnnotationCommentSummary,
    getEditorIdentity: (editor: IPdfjsEditor, pageIndex: number) => string,
) {
    if (!uiManager || numPages <= 0) {
        return null;
    }

    const candidateIds = getCommentCandidateIds(comment);
    if (candidateIds.length === 0) {
        return null;
    }

    for (const pageIndex of getPreferredPageScanOrder(comment.pageIndex, numPages)) {
        for (const normalizedEditor of getEditorsOnPage(uiManager, pageIndex)) {
            const editorIdentity = getEditorIdentity(normalizedEditor, pageIndex);
            if (
                candidateIds.some(candidateId => (
                    editorIdsLikelyMatch(editorIdentity, candidateId)
                    || editorIdsLikelyMatch(normalizedEditor.uid ?? null, candidateId)
                    || editorIdsLikelyMatch(normalizedEditor.annotationElementId ?? null, candidateId)
                    || editorIdsLikelyMatch(normalizedEditor.id ?? null, candidateId)
                ))
            ) {
                return normalizedEditor;
            }
        }
    }

    return null;
}
