import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { IPageRange } from '@app/types/pdfUi';
import type { TPdfRerenderSource } from '@app/modules/pdf-viewer/engine/pdf-rerender-protocol/pdfRerenderProtocol';

export type TPdfViewerTransactionKind =
    | 'navigation'
    | 'rerender'
    | 'reload'
    | 'resize'
    | 'zoom'
    | 'search'
    | 'recovery'
    | 'warm';

export type TPdfViewerTransactionSource =
    | 'paged-navigation'
    | 'continuous-navigation'
    | 'search-navigation'
    | 'wheel-navigation'
    | 'public-scroll'
    | 'fit-mode'
    | 'fit-current-page'
    | 'fit-paged-target'
    | 'zoom-change'
    | 'zoom-gesture'
    | 'zoom-settle'
    | 'resize-observer'
    | 'resize-settle'
    | 'view-mode'
    | 'reload'
    | 'activation-restore'
    | 'render-stall-recovery'
    | 'mounted-page-recovery'
    | 'continuous-warm'
    | 'dpr-change';

export type TPdfViewerTransactionState =
    | 'preparing'
    | 'layout-ready'
    | 'visible-range-committed'
    | 'scroll-applied'
    | 'render-requested'
    | 'render-settled'
    | 'current-page-committed'
    | 'settled'
    | 'cancelled';

export type TPdfViewerTransactionPriority =
    | 'authoritative'
    | 'interactive'
    | 'warm'
    | 'recovery';

export interface IPdfViewerTransactionDocumentRef {
    document: PDFDocumentProxy | null;
    documentLoadToken: number;
    documentVersion: number;
}

export interface IPdfViewerTransactionTarget {
    page: number;
    range: IPageRange;
    anchor: 'top' | 'center' | 'bottom' | 'marker' | null;
    markerRect?: {
        left: number;
        top: number;
        width: number;
        height: number;
    } | null;
}

export interface IPdfViewerTransactionFitPlan {
    mode: 'none' | 'fit-width' | 'fit-height';
    scalePage: number | null;
    hydrateRange: IPageRange | null;
    invalidateRangeAfterScaleChange: boolean;
    suppressLegacyPagedRowRender: boolean;
}

export interface IPdfViewerTransactionScrollPlan {
    preferExactDom: boolean;
    commitCurrentPageOnScroll: boolean;
    suppressSnapAfterScroll: boolean;
    holdProgrammaticNavigationMs: number;
}

export interface IPdfViewerTransactionRenderRequest {
    transactionId: number;
    renderRequestId: number;
    documentVersion: number;
    renderVersion: number;
    source: TPdfRerenderSource | TPdfViewerTransactionSource;
    range: IPageRange;
    requiredRange: IPageRange;
    buffer: number;
    preserveRenderedPages: boolean;
    preserveInFlightRequiredPages: boolean;
    forceRerender: boolean;
    renderWindowOverride?: IPageRange | undefined;
    maxCanvasPixelsOverride?: number | undefined;
    prioritizeTextLayer?: boolean | undefined;
    priority: TPdfViewerTransactionPriority;
}

export interface IPdfViewerTransactionCancellation {
    reason:
        | 'superseded'
        | 'document-changed'
        | 'reload'
        | 'zoom'
        | 'resize'
        | 'user-scroll'
        | 'inactive'
        | 'timeout'
        | 'disposed';
    supersededByTransactionId?: number | undefined;
    cancelInFlightRenders: boolean;
    bumpRenderVersion: boolean;
    clearTimers: boolean;
    preserveVisualContent: boolean;
}

export interface IPdfViewerTransaction {
    id: number;
    kind: TPdfViewerTransactionKind;
    source: TPdfViewerTransactionSource;
    state: TPdfViewerTransactionState;
    documentRef: IPdfViewerTransactionDocumentRef;
    target: IPdfViewerTransactionTarget | null;
    fitPlan: IPdfViewerTransactionFitPlan;
    scrollPlan: IPdfViewerTransactionScrollPlan | null;
    renderRequest: IPdfViewerTransactionRenderRequest | null;
    createdAtMs: number;
    userViewportInteractionEpoch: number;
    cancellation: IPdfViewerTransactionCancellation | null;
}

export interface IPdfViewerTransactionMachineState {
    active: IPdfViewerTransaction | null;
    cancelled: IPdfViewerTransaction[];
    settled: IPdfViewerTransaction | null;
    nextTransactionId: number;
    nextRenderRequestId: number;
    renderVersion: number;
}

export type TPdfViewerTransactionAdvanceState = Exclude<
    TPdfViewerTransactionState,
    'preparing' | 'cancelled'
>;

export interface IPdfViewerTransactionBeginEvent {
    type: 'BEGIN';
    transaction: Omit<
        IPdfViewerTransaction,
        'id' | 'state' | 'renderRequest' | 'cancellation'
    > & {
        id?: number | undefined;
        state?: TPdfViewerTransactionState | undefined;
        renderRequest?: IPdfViewerTransactionRenderRequest | null | undefined;
    };
}

export interface IPdfViewerTransactionAdvanceEvent {
    type: 'ADVANCE';
    transactionId: number;
    state: TPdfViewerTransactionAdvanceState;
    renderRequest?: IPdfViewerTransactionRenderRequest | null | undefined;
}

export interface IPdfViewerTransactionCancelEvent {
    type: 'CANCEL';
    transactionId?: number | undefined;
    cancellation: IPdfViewerTransactionCancellation;
}

export type TPdfViewerTransactionEvent =
    | IPdfViewerTransactionBeginEvent
    | IPdfViewerTransactionAdvanceEvent
    | IPdfViewerTransactionCancelEvent;

export const DEFAULT_PDF_VIEWER_TRANSACTION_FIT_PLAN: IPdfViewerTransactionFitPlan = {
    mode: 'none',
    scalePage: null,
    hydrateRange: null,
    invalidateRangeAfterScaleChange: false,
    suppressLegacyPagedRowRender: false,
};
