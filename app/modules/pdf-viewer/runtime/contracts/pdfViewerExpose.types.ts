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
import type {
    ICreateTextMarkupFromTextOptions,
    ICreateTextMarkupFromTextResult,
} from '@app/composables/pdf/annotations/useAnnotationHighlight';
import type { ICropSelectionResult } from '@app/types/crop';
import type { IMarkupSubtypeHint } from '@app/composables/pdf/pdfSerializationSubtypeHints';
import type {
    IPdfPageMetric,
    IScrollSnapshot,
} from '@app/types/pdf';
import type { IBrowserPrintDocument } from '@app/utils/pdfPrint';

export type TPdfSidebarTab = 'annotations' | 'thumbnails' | 'bookmarks' | 'search';

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
    scrollToPage: (page: number) => void;
    captureScrollSnapshot?: () => IScrollSnapshot | null;
    restoreScrollSnapshot?: (
        snapshot: IScrollSnapshot | null,
        options?: { fallbackPage?: number | null; },
    ) => void;
    invalidatePages?: (pages: number[]) => void;
    requestScrollToCurrentResult?: () => void;
}

export interface IPdfViewerExpose extends IDocumentViewerExpose {
    preserveNextSourceReloadVisibleContent?: (request?: {
        scrollSnapshot?: IScrollSnapshot | null;
        pageToRestore?: number | null;
    }) => void;
    applyFitWidthToCurrentPage?: () => Promise<boolean>;
    waitForViewerLoadSettled?: () => Promise<void>;
    ensurePageMetricsInRange?: (startPage: number, endPage: number) => Promise<boolean>;
    getPageMetricsSnapshot?: () => IPdfPageMetric[];
    captureRegionToClipboard: () => Promise<boolean>;
    isCapturingRegion: boolean;
    startCropSelection: () => Promise<ICropSelectionResult | null>;
    cancelCropSelection: () => void;
    isCropSelecting: boolean;
    adoptPersistedManagedShapesOnNextImport?: () => void;
    clearPendingManagedShapeImportAdoption?: () => void;
    preparePersistedManagedShapesForSave?: (data: Uint8Array) => Promise<unknown>;
    restorePreparedManagedShapesAfterFailedSave?: (snapshot: unknown) => Promise<void>;
    saveDocument: () => Promise<Uint8Array | null>;
    clearAnnotationHistory?: () => void;
    renderLoadedPdfPagesForBrowserPrint?: (
        targetDocument: IBrowserPrintDocument,
        pageNumbers: number[],
        options?: { signal?: AbortSignal },
    ) => Promise<void>;
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
    focusAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<void>;
    updateAnnotationComment: (comment: IAnnotationCommentSummary, text: string) => boolean;
    deleteAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<boolean>;
    getAnnotationCommentsSnapshot?: () => IAnnotationCommentSummary[];
    registerAnnotationHistoryCommand?: (command: {
        cmd: () => void;
        undo: () => void;
    }) => void;
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
    invalidatePages: (pages: number[]) => void;
    requestScrollToCurrentResult: () => void;
}
