import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { markerRectCenterDistance } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/markerRectCenterDistance';
import { getCommentText } from '@app/modules/pdf-viewer/engine/pdf-annotation-editor-utils/getCommentText';
import { toMarkerRectFromEditor } from '@app/modules/pdf-viewer/engine/pdf-annotation-editor-utils/toMarkerRectFromEditor';

interface IMarkerRectEditorMatch {
    editor: IPdfjsEditor;
    pageIndex: number;
    distance: number;
    textScore: number;
}

export function scoreMarkerRectEditor(
    comment: IAnnotationCommentSummary,
    editor: IPdfjsEditor,
    pageIndex: number,
    targetText: string,
): IMarkerRectEditorMatch {
    const distance = markerRectCenterDistance(
        comment.markerRect,
        toMarkerRectFromEditor(editor),
    );
    const editorText = getCommentText(editor).trim();
    const textScore = (
        targetText.length > 0
        && editorText.length > 0
        && targetText === editorText
    ) ? 1 : 0;
    return {
        editor,
        pageIndex,
        distance,
        textScore,
    };
}
