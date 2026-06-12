import type {
    ComputedRef,
    Ref,
} from 'vue';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    IShapePoint,
    ITextMarkupAnnotationProperties,
    TDrawableShapeType,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { ICropSelectionResult } from '@app/types/crop';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/engine/pdf-serialization-subtype-hints/pdfSerializationSubtypeHintsTypes';
import type {
    IPdfPageMetric,
    IScrollSnapshot,
} from '@app/types/pdf';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import type { IBrowserPrintDocument } from '@app/utils/pdfPrint';

export type TPdfSidebarTab = 'annotations' | 'thumbnails' | 'bookmarks' | 'search';
export type TAgentTextMarkupKind = 'highlight' | 'underline' | 'strikethrough' | 'squiggly';

export interface ICreateTextMarkupFromTextOptions {
    pageNumber: number;
    text: string;
    occurrence?: number | undefined;
    markup?: TAgentTextMarkupKind | undefined;
    caseSensitive?: boolean | undefined;
    wholeWord?: boolean | undefined;
    withNote?: boolean | undefined;
}

export interface ICreateTextMarkupFromTextResult {
    created: boolean;
    pageNumber: number;
    requestedText: string;
    matchedText: string | null;
    occurrence: number;
    subtype: TMarkupSubtype;
    reason?: string | undefined;
}

export interface ICreatePointNoteAnnotationOptions {
    pageNumber: number;
    pageX: number;
    pageY: number;
    preferTextAnchor?: boolean | undefined;
}

export interface ICreatePointNoteAnnotationResult {
    created: boolean;
    pageNumber: number;
    pageX: number;
    pageY: number;
    reason?: string | undefined;
}

export interface ICreateShapeAnnotationOptions {
    pageNumber: number;
    tool: TDrawableShapeType;
    x: number;
    y: number;
    width?: number | undefined;
    height?: number | undefined;
    x2?: number | undefined;
    y2?: number | undefined;
    points?: IShapePoint[] | undefined;
    strokes?: IShapePoint[][] | undefined;
    color?: string | undefined;
    fillColor?: string | null | undefined;
    opacity?: number | undefined;
    strokeWidth?: number | undefined;
}

export interface ICreateShapeAnnotationResult {
    created: boolean;
    pageNumber: number;
    shape: IAnnotationCommentSummary | null;
    reason?: string | undefined;
}

export interface IDocumentViewerExpose {
    getViewerContainer: () => HTMLElement | null;
    getCurrentPage?: () => number;
    scrollToPage: (page: number, options?: IScrollToPageOptions) => void;
    cancelProgrammaticNavigation?: () => void;
    captureScrollSnapshot?: () => IScrollSnapshot | null;
    restoreScrollSnapshot?: (
        snapshot: IScrollSnapshot | null,
        options?: { fallbackPage?: number | null; },
    ) => void;
    invalidatePages?: (pages: number[]) => void;
    requestScrollToCurrentResult?: () => void;
}

export interface IPdfViewerLoadExpose {
    preserveNextSourceReloadVisibleContent?: (request?: {
        scrollSnapshot?: IScrollSnapshot | null;
        pageToRestore?: number | null;
    }) => void;
    applyFitWidthToCurrentPage?: () => Promise<boolean>;
    waitForViewerLoadSettled?: () => Promise<void>;
    ensurePageMetricsInRange?: (startPage: number, endPage: number) => Promise<boolean>;
    getPageMetricsSnapshot?: () => IPdfPageMetric[];
}

export interface IPdfViewerRegionCaptureExpose {
    captureRegionToClipboard: () => Promise<boolean>;
    isCapturingRegion: boolean;
}

export interface IPdfViewerCropExpose {
    startCropSelection: () => Promise<ICropSelectionResult | null>;
    cancelCropSelection: () => void;
    isCropSelecting: boolean;
}

export interface IPdfViewerShapePersistenceExpose {
    adoptPersistedManagedShapesOnNextImport?: () => void;
    clearPendingManagedShapeImportAdoption?: () => void;
    preparePersistedManagedShapesForSave?: (data: Uint8Array) => Promise<unknown>;
    restorePreparedManagedShapesAfterFailedSave?: (snapshot: unknown) => Promise<void>;
}

export interface IPdfViewerSaveExpose {saveDocument: () => Promise<Uint8Array | null>;}

export interface IPdfViewerBrowserPrintExpose {renderLoadedPdfPagesForBrowserPrint?: (
    targetDocument: IBrowserPrintDocument,
    pageNumbers: number[],
    options?: { signal?: AbortSignal },
) => Promise<void>;}

export interface IPdfViewerAnnotationCommandExpose {
    clearAnnotationHistory?: () => void;
    highlightSelection: () => Promise<boolean>;
    commentSelection: () => Promise<boolean>;
    createTextMarkupFromText: (
        options: ICreateTextMarkupFromTextOptions,
    ) => Promise<ICreateTextMarkupFromTextResult>;
    commentAtPoint: (
        pageNumber: number,
        pageX: number,
        pageY: number,
        options?: { preferTextAnchor?: boolean },
    ) => Promise<boolean>;
    createPointNoteAnnotation: (
        options: ICreatePointNoteAnnotationOptions,
    ) => Promise<ICreatePointNoteAnnotationResult>;
    createShapeAnnotation: (
        options: ICreateShapeAnnotationOptions,
    ) => Promise<ICreateShapeAnnotationResult>;
    startCommentPlacement: () => void;
    cancelCommentPlacement: () => void;
    undoAnnotation: () => void;
    redoAnnotation: () => void;
    registerAnnotationHistoryCommand?: (command: {
        cmd: () => void;
        undo: () => void;
    }) => void;
}

export interface IPdfViewerAnnotationCommentExpose {
    focusAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<void>;
    updateAnnotationComment: (comment: IAnnotationCommentSummary, text: string) => boolean;
    deleteAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<boolean>;
    getAnnotationCommentsSnapshot?: () => IAnnotationCommentSummary[];
    suppressAnnotationId: (id: string) => void;
    unsuppressAnnotationId?: (id: string) => void;
    suppressAnnotationStableKey: (stableKey: string) => void;
    unsuppressAnnotationStableKey?: (stableKey: string) => void;
    removeAnnotationFromDom: (comment: IAnnotationCommentSummary) => void;
    removeAnnotationFromInternalCache: (stableKey: string) => void;
    restoreAnnotationToInternalCache?: (comment: IAnnotationCommentSummary) => void;
    clearPendingMarkerMoves?: () => void;
    getMarkupSubtypeOverrides: () => Map<string, TMarkupSubtype>;
    getMarkupSubtypeHints?: () => IMarkupSubtypeHint[];
    getSelectedTextMarkupAnnotationProperties?: () => ITextMarkupAnnotationProperties | null;
    updateSelectedTextMarkupAnnotationColor?: (color: string) => boolean;
    updateTextMarkupAnnotationColor?: (comment: IAnnotationCommentSummary, color: string) => boolean;
}

export interface IPdfViewerShapeExpose {
    getAllShapes: () => IShapeAnnotation[];
    markSavedShapeState?: () => void;
    getDeletedEmbeddedShapeAnnotationIds: () => string[];
    getDeletedEmbeddedShapeStableKeys?: () => string[];
    loadShapes: (shapes: IShapeAnnotation[]) => void;
    clearShapes: () => void;
    clearSelectedShape: () => void;
    deleteSelectedShape: () => void;
    hasShapes: boolean | Ref<boolean> | ComputedRef<boolean>;
    selectedShapeId: string | null;
    updateShape: (id: string, updates: Partial<IShapeAnnotation>) => void;
    getSelectedShape: () => IShapeAnnotation | null;
}

export interface IPdfViewerImagePlacementExpose {
    startImagePlacement: (
        file: File,
        options?: {
            pageNumber?: number | null;
            pageX?: number | null;
            pageY?: number | null;
        },
    ) => Promise<boolean>;
    clearPendingImagePlacement: () => void;
    restorePendingImagePlacement: () => void;
}

export interface IPdfViewerExpose extends
    IDocumentViewerExpose,
    IPdfViewerLoadExpose,
    IPdfViewerRegionCaptureExpose,
    IPdfViewerCropExpose,
    IPdfViewerShapePersistenceExpose,
    IPdfViewerSaveExpose,
    IPdfViewerBrowserPrintExpose,
    IPdfViewerAnnotationCommandExpose,
    IPdfViewerAnnotationCommentExpose,
    IPdfViewerShapeExpose,
    IPdfViewerImagePlacementExpose {
    invalidatePages: (pages: number[]) => void;
    requestScrollToCurrentResult: () => void;
}
