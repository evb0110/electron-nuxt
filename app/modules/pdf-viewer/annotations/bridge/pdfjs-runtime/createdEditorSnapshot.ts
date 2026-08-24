// PDF.js-private editor bookkeeping. Creating an annotation editor is
// asynchronous and pdf.js exposes no handle to the one it just made, so the
// bridge diffs the page's editors around the call to find it.
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { isEditorCommentDeleted } from '@app/modules/pdf-viewer/annotations/bridge/pdfjsAnnotationFacade';

export interface IEditorSnapshot {editorsBeforeIds: Set<string>;}

type TGetEditorsForPage = (pageIndex: number) => IPdfjsEditor[];
type TGetEditorIdentity = (editor: IPdfjsEditor, pageIndex: number) => string;

export function captureEditorSnapshot(
    pageIndex: number,
    getEditorsForPage: TGetEditorsForPage,
    getEditorIdentity: TGetEditorIdentity,
): IEditorSnapshot {
    const editorsBefore = getEditorsForPage(pageIndex);
    return {editorsBeforeIds: new Set<string>(editorsBefore.map(editor => getEditorIdentity(editor, pageIndex)))};
}

export function pickCreatedEditorCandidate(
    pageIndex: number,
    snapshot: IEditorSnapshot,
    getEditorsForPage: TGetEditorsForPage,
    getEditorIdentity: TGetEditorIdentity,
) {
    const editorsAfter = getEditorsForPage(pageIndex).filter(editor => !isEditorCommentDeleted(editor));
    return editorsAfter.find(editor => (
        !snapshot.editorsBeforeIds.has(getEditorIdentity(editor, pageIndex))
    )) ?? null;
}
