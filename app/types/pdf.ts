import type {
    IPdfValidationResult,
    TDocumentRef,
    TPdfSaveMode,
} from '@contracts/platformApi';
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
    IPdfConformanceProfile,
    IPdfValidationResult,
    TPdfSaveMode,
} from '@contracts/platformApi';

export type {IPdfBookmarkEntry} from '@contracts/pdf';

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

export interface ISearchExcerpt {
    prefix: boolean;
    suffix: boolean;
    before: string;
    match: string;
    after: string;
}

export interface IPdfSearchMatch {
    pageIndex: number;
    pageMatchIndex?: number; // Ordinal on page (0, 1, 2...) - used for direct match mapping from backend
    matchIndex: number;
    startOffset: number;
    endOffset: number;
    excerpt?: ISearchExcerpt;
    words?: IOcrWord[];
    pageWidth?: number;
    pageHeight?: number;
}

export interface IPdfPageMatches {
    pageIndex: number;
    pageText: string; // Full page text for reference
    searchQuery: string; // The query that generated these matches
    signatureToken?: string;
    searchOptions?: {
        matchCase?: boolean;
        wholeWord?: boolean;
        useRegex?: boolean;
    };
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

export const PAGE_LABEL_STYLE_VALUES = [
    'D',
    'R',
    'r',
    'A',
    'a',
] as const;

export type TPageLabelStyle = typeof PAGE_LABEL_STYLE_VALUES[number] | null;

export interface IPdfPageLabelRange {
    startPage: number;
    style: TPageLabelStyle;
    prefix: string;
    startNumber: number;
}

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
