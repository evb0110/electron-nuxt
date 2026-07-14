export type {
    IOcrWord,
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@contracts/shared';
export type {
    IPdfSearchExcerpt,
    IPdfSearchResult,
    ISearchMatchOptions,
} from '@contracts/search';
export type { TPageIndex } from '@contracts/pageNumbers';
export type {
    IPdfPageLabelRange,
    TPdfPageLabelStyle as TPageLabelStyle,
} from '@contracts/pdfPageLabels';
export type {
    IPdfConformanceProfile,
    IPdfValidationResult,
    TPdfSaveMode,
} from '@contracts/pdfConformance';
export type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
export type {
    PDFDocumentProxy,
    PDFPageProxy,
} from 'pdfjs-dist';
