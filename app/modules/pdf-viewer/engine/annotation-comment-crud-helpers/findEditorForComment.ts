import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import {
    clamp,
    range,
} from 'es-toolkit/math';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { getCommentCandidateIds } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationSummaryIdentity';
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
            const editorIds = new Set([
                editorIdentity,
                normalizedEditor.uid,
                normalizedEditor.annotationElementId,
                normalizedEditor.id === null || normalizedEditor.id === undefined
                    ? null
                    : String(normalizedEditor.id),
            ].filter((value): value is string => Boolean(value)));
            if (candidateIds.some(candidateId => editorIds.has(candidateId))) {
                return normalizedEditor;
            }
        }
    }

    return null;
}
