import type { TPageIndex } from '@contracts/pageNumbers';

import type { IPdfjsEditor } from '@app/types/pdfjs';

export interface IEditorTargetMatch {
    editor: IPdfjsEditor;
    pageIndex: TPageIndex;
    targetAnnotationId: string | null;
}
