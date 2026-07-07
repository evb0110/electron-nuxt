import type { IAnnotationContextMenuPayload } from '@app/modules/pdf-viewer/engine/annotationContextMenuPayload';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    IAnnotationModifiedPayload,
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IPdfPlacedImageFinalizePayload } from '@app/types/pdfImagePlacement';
import type {
    PDFDocumentProxy,
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@app/types/pdfContracts';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
    TPdfSource,
} from '@app/types/pdfUi';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TPdfRasterDisplayProfile } from '@app/types/pdfRasterDisplayProfile';

export interface IPdfViewerProps {
    src: TPdfSource | null;
    reloadSrc?: TPdfSource | null | undefined;
    sourcePdfData?: Uint8Array | null | undefined;
    rasterDisplayProfile?: TPdfRasterDisplayProfile | null | undefined;
    suppressLoadingOverlay?: boolean | undefined;
    bufferPages?: number | undefined;
    isAnySaving?: boolean | undefined;
    zoom?: number | undefined;
    zoomMode?: TZoomMode | undefined;
    dragMode?: boolean | undefined;
    fitMode?: TFitMode | undefined;
    viewMode?: TPdfViewMode | undefined;
    continuousScroll?: boolean | undefined;
    isActive?: boolean | undefined;
    isResizing?: boolean | undefined;
    invertColors?: boolean | undefined;
    showAnnotations?: boolean | undefined;
    annotationTool?: TAnnotationTool | undefined;
    annotationCursorMode?: boolean | undefined;
    annotationKeepActive?: boolean | undefined;
    annotationSettings?: IAnnotationSettings | null | undefined;
    searchPageMatches?: Map<number, IPdfPageMatches> | undefined;
    currentSearchMatch?: IPdfSearchMatch | null | undefined;
    currentSearchMatchNavigationId?: number | undefined;
    currentPage?: number | undefined;
    workingCopyPath?: string | null | undefined;
    documentRevisionToken?: TDocumentRevisionToken | null | undefined;
    authorName?: string | null | undefined;
}

export interface IPdfViewerEmit {
    (e: 'update:zoom', value: number): void;
    (e: 'update:zoomMode', mode: TZoomMode): void;
    (e: 'update:fitMode', mode: TFitMode): void;
    (e: 'update:effectiveZoom', value: number): void;
    (e: 'update:currentPage', page: number): void;
    (e: 'update:navigationFeedbackPage', page: number | null): void;
    (e: 'update:totalPages', total: number): void;
    (e: 'update:loading', loading: boolean): void;
    (e: 'update:document', document: PDFDocumentProxy | null): void;
    (e: 'loading', loading: boolean): void;
    (e: 'load-error', error: unknown): void;
    (e: 'annotation-state', state: IAnnotationEditorState): void;
    (e: 'annotation-modified', payload?: IAnnotationModifiedPayload): void;
    (e: 'annotation-comments', comments: IAnnotationCommentSummary[]): void;
    (e: 'annotation-open-note', comment: IAnnotationCommentSummary): void;
    (e: 'annotation-context-menu', payload: IAnnotationContextMenuPayload): void;
    (e: 'annotation-tool-auto-reset'): void;
    (e: 'annotation-setting', payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings]
    }): void;
    (e: 'annotation-comment-click', comment: IAnnotationCommentSummary): void;
    (e: 'annotation-tool-cancel'): void;
    (e: 'annotation-note-placement-change', active: boolean): void;
    (e: 'shape-context-menu', payload: {
        shapeId: string;
        clientX: number;
        clientY: number;
    }): void;
    (e: 'image-placement-finalize', payload: IPdfPlacedImageFinalizePayload): void;
    (e: 'initial-visual-pending'): void;
    (e: 'initial-visual-ready', payload: {pageNumber: number;}): void;
}
