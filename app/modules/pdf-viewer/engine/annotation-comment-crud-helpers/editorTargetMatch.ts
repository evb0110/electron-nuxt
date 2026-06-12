import type { IPdfjsEditor } from '@app/types/pdfjs';

export interface IEditorTargetMatch {
    editor: IPdfjsEditor;
    pageIndex: number;
    targetAnnotationId: string | null;
}
