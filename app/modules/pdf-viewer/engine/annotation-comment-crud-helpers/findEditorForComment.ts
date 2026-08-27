import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { getCommentCandidateIds } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationSummaryIdentity';
import {
    getEditorById,
    getEditorsOnPage,
} from '@app/services/pdfjs/annotationEditorAdapter';
import { getAnnotationEditorPageSearchOrder } from '@app/modules/pdf-viewer/engine/annotation-comment-crud-helpers/getAnnotationEditorPageSearchOrder';

interface IFindEditorForCommentOptions {
    annotationPageIndexes?: Iterable<number> | null;
    mountedPageIndexes?: Iterable<number> | null;
}

function getEditorIds(
    editor: IPdfjsEditor,
    pageIndex: number,
    getEditorIdentity: (editor: IPdfjsEditor, pageIndex: number) => string,
) {
    return new Set([
        getEditorIdentity(editor, pageIndex),
        editor.uid,
        editor.annotationElementId,
        editor.id === null || editor.id === undefined
            ? null
            : String(editor.id),
    ].filter((value): value is string => Boolean(value)));
}

export function findEditorForComment(
    uiManager: AnnotationEditorUIManager | null,
    numPages: number,
    comment: IAnnotationCommentSummary,
    getEditorIdentity: (editor: IPdfjsEditor, pageIndex: number) => string,
    options: IFindEditorForCommentOptions = {},
) {
    if (!uiManager || numPages <= 0) {
        return null;
    }

    const candidateIds = getCommentCandidateIds(comment);
    if (candidateIds.length === 0) {
        return null;
    }

    for (const candidateId of candidateIds) {
        const byGlobalId = getEditorById(uiManager, candidateId);
        if (!byGlobalId) {
            continue;
        }
        const pageIndex = Number.isSafeInteger(byGlobalId.parentPageIndex)
            ? byGlobalId.parentPageIndex as number
            : comment.pageIndex;
        const editorIds = getEditorIds(byGlobalId, pageIndex, getEditorIdentity);
        if (candidateIds.some(id => editorIds.has(id))) {
            return byGlobalId;
        }
    }

    for (const pageIndex of getAnnotationEditorPageSearchOrder({
        annotationPageIndexes: options.annotationPageIndexes,
        mountedPageIndexes: options.mountedPageIndexes,
        numPages,
        preferredPageIndex: comment.pageIndex,
    })) {
        for (const normalizedEditor of getEditorsOnPage(uiManager, pageIndex)) {
            const editorIds = getEditorIds(normalizedEditor, pageIndex, getEditorIdentity);
            if (candidateIds.some(candidateId => editorIds.has(candidateId))) {
                return normalizedEditor;
            }
        }
    }

    return null;
}
