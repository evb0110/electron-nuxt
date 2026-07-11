import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    IShapeAnnotation,
    TShapeAnnotationPatch,
    ITextMarkupAnnotationProperties,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {IPageIdentityDelta} from '@contracts/electronApiPageOps';
import type { IShapeAnnotationConstructionOptions } from '@app/types/shapeAnnotationConstructionOptions';
import type { ICropSelectionResult } from '@app/types/crop';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/engine/pdf-serialization-subtype-hints/pdfSerializationSubtypeHintsTypes';
import type { IPdfPageMetric } from '@app/types/pdfUi';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import type { IBrowserPrintDocument } from '@app/utils/pdfPrintShared';
import type { IPdfPagePreviewEntry } from '@app/modules/pdf-viewer/engine/pdf-page-preview/pdfPagePreviewTypes';
import type {
    IPdfViewerSaveTransactionRequest,
    IPdfViewerSaveTransactionResult,
} from '@app/modules/pdf-viewer/runtime/save/pdfViewerSaveTransaction.types';
import type {IWorkspaceCommandSink} from '@app/types/workspaceCommand';

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

export interface ICreateShapeAnnotationOptions extends IShapeAnnotationConstructionOptions {pageNumber: number;}

export interface ICreateShapeAnnotationResult {
    created: boolean;
    pageNumber: number;
    shape: IAnnotationCommentSummary | null;
    reason?: string | undefined;
}

export interface IDocumentViewerExpose {
    getViewerContainer: () => HTMLElement | null;
    getCurrentPage?: () => number;
    getPendingNavigationTargetPage?: () => number | null;
    waitForViewerLoadSettled?: () => Promise<void>;
    scrollToPage: (page: number, options?: IScrollToPageOptions) => void;
    cancelProgrammaticNavigation?: () => void;
    getUserViewportInteractionEpoch?: () => number;
    invalidatePages?: (pages: number[]) => void;
    remapPageIdentityDelta?: (delta: IPageIdentityDelta) => void;
    requestScrollToCurrentResult?: () => void;
}

export interface IPdfViewerLoadExpose {
    preserveNextSourceReloadVisibleContent?: (request?: {pageToRestore?: number | null;}) => void;
    applyFitWidthToCurrentPage?: () => Promise<boolean>;
    waitForViewerLoadSettled?: () => Promise<void>;
    ensurePageMetricsInRange?: (startPage: number, endPage: number) => Promise<boolean>;
    getPageMetricsSnapshot?: () => IPdfPageMetric[];
}

export interface IPdfViewerPreviewExpose {getPagePreview: (page: number) => IPdfPagePreviewEntry | null;}

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

export interface IPdfViewerSaveExpose {
    runSaveTransaction: (
        request: IPdfViewerSaveTransactionRequest,
    ) => Promise<IPdfViewerSaveTransactionResult>;
    saveDocument: () => Promise<Uint8Array | null>;
    materializePdfJsDocumentForInternalUse: () => Promise<Uint8Array | null>;
    commitPdfEditorsForSave?: () => Promise<void>;
}

export interface IPdfViewerBrowserPrintExpose {renderLoadedPdfPagesForBrowserPrint?: (
    targetDocument: IBrowserPrintDocument,
    pageNumbers: number[],
    options?: { signal?: AbortSignal },
) => Promise<void>;}

export interface IPdfViewerAnnotationCommandExpose {
    annotationHistoryMutationVersion?: number | undefined;
    annotationHistoryResetVersion?: number | undefined;
    clearAnnotationHistory?: () => void;
    setWorkspaceCommandSink?: (sink: IWorkspaceCommandSink | null) => void;
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
    undoAnnotation: () => boolean | undefined;
    redoAnnotation: () => boolean | undefined;
    registerAnnotationHistoryCommand?: (command: {
        cmd: () => void;
        undo: () => void;
    }) => void;
}

export interface IPdfViewerAnnotationCommentExpose {
    focusAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<void>;
    updateAnnotationComment: (comment: IAnnotationCommentSummary, text: string) => boolean;
    moveAnnotationMarker: (comment: IAnnotationCommentSummary, rect: IAnnotationMarkerRect) => boolean;
    deleteAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<boolean>;
    getAnnotationCommentsSnapshot?: () => IAnnotationCommentSummary[];
    rerenderAnnotationPage: (pageNumber: number) => Promise<boolean>;
    deleteEmbeddedAnnotationDeferred?: (comment: IAnnotationCommentSummary) => boolean;
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
    hasShapes: boolean;
    selectedShapeId: string | null;
    updateShape: (id: string, updates: TShapeAnnotationPatch) => void;
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
    IPdfViewerPreviewExpose,
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
