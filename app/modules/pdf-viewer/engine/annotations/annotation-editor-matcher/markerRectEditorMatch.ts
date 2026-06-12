import type { IPdfjsEditor } from '@app/types/pdfjs';

export interface IMarkerRectEditorMatch {
    editor: IPdfjsEditor;
    pageIndex: number;
    distance: number;
    textScore: number;
}
