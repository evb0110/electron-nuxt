import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IPdfSearchExcerpt,
    ISearchMatchOptions,
} from '@contracts/search';
import type { TPageIndex } from '@contracts/pageNumbers';
import type { TPdfPageLabelStyle } from '@contracts/pdfPageLabels';
import type {
    IPdfValidationResult,
    TPdfSaveMode,
} from '@contracts/pdfConformance';
import type {
    PDFDocumentProxy,
    PDFPageProxy,
} from 'pdfjs-dist';
import type { IOcrWord } from '@contracts/shared';

export type {
    IOcrWord,
    TFitMode,
    TZoomMode,
    TPdfViewMode,
} from '@contracts/shared';
export type {
    IPdfSearchExcerpt,
    ISearchMatchOptions,
} from '@contracts/search';
export type { TPageIndex } from '@contracts/pageNumbers';
export { PDF_PAGE_LABEL_STYLE_VALUES as PAGE_LABEL_STYLE_VALUES } from '@contracts/pdfPageLabels';
export type { IPdfPageLabelRange } from '@contracts/pdfPageLabels';
export type {
    IPdfConformanceProfile,
    IPdfValidationResult,
    TPdfSaveMode,
} from '@contracts/pdfConformance';

export type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';

export interface IContentInsets {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

export interface IPdfPageMetric {
    width: number;
    height: number;
}

export interface IPageRange {
    start: number;
    end: number;
}

export interface IScrollSnapshot {
    width: number;
    height: number;
    centerX: number;
    centerY: number;
    anchorPage?: number | null;
    anchorInsidePage?: boolean;
    anchorOffsetRatio?: number;
    anchorViewportX?: number;
    anchorViewportY?: number;
    anchorContentXRatio?: number;
    anchorContentYRatio?: number;
    anchorPageXRatio?: number;
    anchorPageYRatio?: number;
    anchorPageYOutsideEdge?: TAnchorPageOutsideEdge;
    anchorPageYOutsideOffsetPx?: number | null;
}

export type TAnchorPageOutsideEdge = 'inside' | 'above' | 'below';

export interface IPdfPathSource {
    kind: 'path';
    path: TDocumentRef;
    size: number;
}

export type TPdfSource = Blob | IPdfPathSource;

export interface IPdfSearchMatch {
    pageIndex: TPageIndex;
    pageMatchIndex?: number; // Ordinal on page (0, 1, 2...) - used for direct match mapping from backend
    matchIndex: number;
    startOffset: number;
    endOffset: number;
    excerpt?: IPdfSearchExcerpt;
    words?: IOcrWord[];
    pageWidth?: number;
    pageHeight?: number;
}

export interface IPdfPageMatches {
    pageIndex: TPageIndex;
    pageText: string; // Full page text for reference
    searchQuery: string; // The query that generated these matches
    signatureToken?: string;
    searchOptions?: ISearchMatchOptions;
    matches: Array<{
        matchIndex: number;
        start: number;
        end: number;
        words?: IOcrWord[];
        pageWidth?: number;
        pageHeight?: number;
    }>;
}

export type TSearchDirection = 'next' | 'previous';

export type TPageLabelStyle = TPdfPageLabelStyle;

export interface IPdfPageRange {
    startPage: number;
    endPage: number;
}

/**
 * The shape returned by `PageViewport.rawDims` at runtime.
 * pdf.js types declare the getter as `Object`, but the actual
 * value always carries the original (unscaled) page dimensions.
 */
export interface IPdfRawDims {
    pageWidth: number;
    pageHeight: number;
}

export interface IPdfSaveResult {
    finalBytes: Uint8Array;
    saveMode: TPdfSaveMode;
    warnings: string[];
    validation: IPdfValidationResult;
}

export interface IPdfPersistResult {
    success: boolean;
    outPath: TDocumentRef | null;
    saveMode: TPdfSaveMode;
    didSaveAs: boolean;
}

export type {
    PDFDocumentProxy, PDFPageProxy,
};
