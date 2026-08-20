export type TDocumentOperationKind =
    | 'save'
    | 'save-as'
    | 'repair-save'
    | 'optimize-pdf'
    | 'page-operation'
    | 'ocr-apply'
    | 'raster-export'
    | 'recovery-snapshot'
    | 'split-capture';
