import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type {
    PDFDocumentProxy,
    PDFPageProxy,
    TZoomMode,
} from '@app/types/pdfContracts';
import type {
    IPageRange,
    TPdfSource,
} from '@app/types/pdfUi';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import type {
    IPdfViewerTransactionCancellation,
    TPdfViewerTransactionState,
} from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';
import type { ICurrentPageSyncOptions } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync';

export type TReloadTransactionAdvanceState = Exclude<
    TPdfViewerTransactionState,
    'preparing' | 'cancelled'
>;

export interface IReloadTransactionController {
    beginTransaction: (options: {
        kind: 'reload' | 'recovery';
        source: 'reload' | 'render-stall-recovery';
        page: number;
        range: IPageRange;
        anchor: 'top';
        scrollPlan?: {
            preferExactDom: boolean;
            commitCurrentPageOnScroll: boolean;
            suppressSnapAfterScroll: boolean;
            holdProgrammaticNavigationMs: number;
        } | undefined;
    }) => { id: number } | null;
    advanceTransaction: (transactionId: number, state: TReloadTransactionAdvanceState) => boolean;
    cancelActiveTransaction: (
        cancellation: IPdfViewerTransactionCancellation,
        transactionId?: number,
    ) => boolean;
    isTransactionCurrent: (transactionId: number) => boolean;
    commitVisibleRange: (
        range: IPageRange,
        options?: { transactionId?: number | undefined },
    ) => boolean;
}

export interface IUsePdfViewerDocumentLifecycleOptions {
    viewerContainer: Ref<HTMLElement | null>;
    src: ComputedRef<TPdfSource | null>;
    documentLifecycleKey?: ComputedRef<string | null> | undefined;
    reloadSrc?: ComputedRef<TPdfSource | null> | undefined;
    zoom: ComputedRef<number>;
    zoomMode: ComputedRef<TZoomMode>;
    effectiveScale: Ref<number>;
    currentPage: Ref<number>;
    visibleRange: Ref<IPageRange>;
    basePageWidth: Ref<number | null>;
    basePageHeight: Ref<number | null>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>;
    clearAnnotationProjection?: (() => void) | undefined;
    activeCommentStableKey: Ref<string | null>;
    pdfDocument: Ref<PDFDocumentProxy | null>;
    numPages: Ref<number>;
    isLoading: Ref<boolean>;
    loadError?: Ref<unknown | null> | undefined;
    getRenderVersion: () => number;
    loadPdf: (
        src: TPdfSource,
        options?: {
            lifecycleKey?: string;
            preservePageStructure?: boolean;
        },
    ) => Promise<{version: number;} | null>;
    ensurePageMetricsInRange: (startPage: number, endPage: number) => Promise<boolean>;
    getPage: (pageNumber: number) => Promise<PDFPageProxy>;
    renderVisiblePages: (
        range: IPageRange,
        options?: {
            preserveRenderedPages?: boolean;
            bufferOverride?: number;
            forceRerender?: boolean;
        },
    ) => Promise<void>;
    getVisibleRange: () => IPageRange;
    reRenderVisiblePagesAndSyncCurrentPage: (options?: ICurrentPageSyncOptions) => Promise<void>;
    syncCurrentPageFromViewport: (options?: ICurrentPageSyncOptions) => Promise<void>;
    getUserViewportInteractionEpoch?: (() => number) | undefined;
    applySearchHighlights: () => void;
    getVisiblePageRange?: ((container: HTMLElement | null, numPages: number) => IPageRange) | undefined;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    scrollToPage: (pageNumber: number, options?: IScrollToPageOptions) => void;
    /**
     * Applies the reload transaction's already-resolved viewport position
     * without submitting a second public navigation/render transaction.
     */
    commitReloadViewport?: ((pageNumber: number, options?: IScrollToPageOptions) => void) | undefined;
    cleanupRenderedPages: () => void;
    invalidateScaleCache: () => void;
    shouldPreserveOpeningLayout?: (() => boolean) | undefined;
    resetScale: () => void;
    seedOpeningFitScale?: (() => boolean) | undefined;
    resetInsets: () => void;
    setupPagePlaceholders: () => void;
    computeFitWidthScale: (container: HTMLElement | null) => boolean;
    computeSkeletonInsets: (
        pdfPage: PDFPageProxy,
        renderVersion: number,
        getCurrentVersion: () => number,
    ) => Promise<void>;
    invalidateRenderedPages: (pages: number[]) => void;
    consumePendingInvalidation: () => number[] | null;
    commentSync: {
        incrementSyncToken: () => void;
        scheduleAnnotationCommentsSync: (immediate?: boolean) => void;
    };
    editor: {
        destroyAnnotationEditor: () => void;
        initAnnotationEditor: () => void;
    };
    pinCurrentPageDuringRecovery: (
        page: number,
        options?: {
            durationMs?: number;
            reason?: string;
        },
    ) => void;
    suppressNextZoomRerender: (targetZoom: number) => void;
    beginVisualReloadTransition: (reason: string) => number;
    endVisualReloadTransition: (token: number, reason: string) => void;
    transactionController?: IReloadTransactionController | undefined;
    emitLoadError?: ((error: unknown) => void) | undefined;
    onDocumentLoadStateChange?: ((payload: {
        token: number;
        phase: 'started' | 'settled';
    }) => void) | undefined;
    waitForInitialCanvasCommit?: ((pageNumber: number) => Promise<void>) | undefined;
    isInitialCanvasCommitted?: (() => boolean) | undefined;
    isInitialVisualCommitted?: (() => boolean) | undefined;
    emit: {
        (e: 'update:totalPages', total: number): void;
        (e: 'update:currentPage', page: number): void;
        (e: 'update:document', document: PDFDocumentProxy | null): void;
        (e: 'annotation-comments', comments: IAnnotationCommentSummary[]): void;
        (e: 'update:zoom', value: number): void;
    };
}
