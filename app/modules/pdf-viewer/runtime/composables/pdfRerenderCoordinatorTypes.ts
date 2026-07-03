import type {
    ComputedRef,
    Ref,
} from 'vue';
import type {
    PDFDocumentProxy,
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@app/types/pdfContracts';
import type {
    IPageRange,
    IScrollSnapshot,
} from '@app/types/pdfUi';
import type {
    ICurrentPageSyncOptions,
    IResizeAnchorContext,
} from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync';
import type { IBuildResizeAnchorContextOptions } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerResizeLifecycle';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import type { IZoomViewportAnchor } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewerViewportTypes';
import type {
    IPdfViewerTransaction,
    TPdfViewerTransactionSource,
    TPdfViewerTransactionState,
} from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';

export type TFitRerenderTransitionOwner = 'current-page' | 'paged-target';

export interface IPagedTargetFitRenderHandoff {
    document: PDFDocumentProxy;
    fitMode: TFitMode;
    page: number;
    range: IPageRange;
    viewMode: TPdfViewMode;
}

export interface IRerenderCoordinatorTransactionController {
    beginTransaction: (options: {
        kind: 'resize';
        source: TPdfViewerTransactionSource;
        page?: number | null | undefined;
        range?: IPageRange | undefined;
        anchor?: NonNullable<IPdfViewerTransaction['target']>['anchor'];
    }) => IPdfViewerTransaction | null;
    advanceTransaction: (
        transactionId: number,
        state: Exclude<TPdfViewerTransactionState, 'preparing' | 'cancelled'>,
    ) => boolean;
    isTransactionCurrent: (transactionId: number) => boolean;
}

export interface IUsePdfViewerRerenderCoordinatorOptions {
    viewerContainer: Ref<HTMLElement | null>;
    pdfDocument: Ref<PDFDocumentProxy | null>;
    isLoading: Ref<boolean>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    pagedNavigationTargetPage?: Readonly<Ref<number | null>> | undefined;
    navigationAnchorPage?: Readonly<Ref<number | null>> | undefined;
    visibleRange: Ref<IPageRange>;
    commitVisibleRange?: ((range: IPageRange) => boolean | undefined) | undefined;
    zoom: ComputedRef<number>;
    zoomMode?: ComputedRef<TZoomMode> | undefined;
    fitMode: ComputedRef<TFitMode>;
    viewMode: ComputedRef<TPdfViewMode>;
    isResizing: ComputedRef<boolean>;
    continuousScroll: ComputedRef<boolean>;
    getVisibleRange: () => IPageRange;
    reRenderAllVisiblePages: (
        getVisibleRange: () => IPageRange,
        options?: {
            preserveExistingPages?: boolean;
            anchorSnapshot?: IScrollSnapshot | null;
            disableHorizontalAnchorRestore?: boolean;
            disableVerticalAnchorRestore?: boolean;
            disablePageAnchorRestore?: boolean;
            rerenderSource?: string;
            renderBufferOverride?: number | undefined;
            maxCanvasPixelsOverride?: number | undefined;
        },
    ) => Promise<void>;
    isPageRendered: (page: number) => boolean;
    summarizeViewerMetricsForLog: (container: HTMLElement | null) => unknown;
    summarizeVisiblePageSnapshotForLog: (container: HTMLElement | null) => unknown;
    syncCurrentPageFromViewport: (options?: ICurrentPageSyncOptions) => Promise<void>;
    markLowResZoomRerenderUsed: () => void;
    buildResizeAnchorContext: (options?: IBuildResizeAnchorContextOptions) => IResizeAnchorContext;
    scheduleEndResizeTransition: (
        token: number,
        reason: string,
        page: number | null,
    ) => void;
    enqueueZoomSync: (syncOptions: ICurrentPageSyncOptions) => void;
    scheduleResizeAwareRerender: (
        stage: string,
        syncOptions?: ICurrentPageSyncOptions,
    ) => void;
    cancelInFlightPageRenders?: (() => Promise<void> | void) | undefined;
    ensurePageMetricsInRange?: ((startPage: number, endPage: number) => Promise<boolean>) | undefined;
    computeFitWidthScale: (
        container: HTMLElement | null,
        options?: { page?: number | null | undefined },
    ) => boolean;
    syncHorizontalScrollForZoomMode?: (() => boolean) | undefined;
    setupPagePlaceholders: () => void;
    scrollToPage: (pageNumber: number, options?: IScrollToPageOptions) => unknown;
    getMostVisiblePage: (container: HTMLElement | null, numPages: number) => number;
    resetContinuousScrollState: () => void;
    cancelDestinationNavigationTarget?: (() => void) | undefined;
    resetZoomRerenderQueueState: (reason: string) => void;
    getUserViewportInteractionEpoch?: (() => number) | undefined;
    consumeZoomViewportAnchor?: (() => IZoomViewportAnchor | null) | undefined;
    beginResizeTransition: (source: string, anchorPage: number | null) => number;
    consumeSuppressedZoomRerender?: ((nextZoom: number) => boolean) | undefined;
    setCurrentPageFitRerenderTransitionActive?: ((active: boolean) => void) | undefined;
    transactionController?: IRerenderCoordinatorTransactionController | undefined;
}
