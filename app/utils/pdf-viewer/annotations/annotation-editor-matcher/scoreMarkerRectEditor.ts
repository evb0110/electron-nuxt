import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { markerRectCenterDistance } from '@app/utils/pdf-viewer/annotations/annotation-rules/markerRectCenterDistance';
import { getCommentText } from '@app/utils/pdf-viewer/pdf-annotation-editor-utils/getCommentText';
import { toMarkerRectFromEditor } from '@app/utils/pdf-viewer/pdf-annotation-editor-utils/toMarkerRectFromEditor';

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
