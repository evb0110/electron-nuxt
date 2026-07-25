import type {
    AnnotationEditorUIManager,
    PDFPageProxy,
    RenderTask,
} from 'pdfjs-dist';
import type {
    MaybeRefOrGetter,
    Ref,
} from 'vue';
import type { TPdfDocumentSession } from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import type {
    IPageRange,
    IPdfPageMatches,
    IPdfSearchMatch,
} from '@app/types/pdfUi';
import type { IPdfjsL10n } from '@app/types/pdfjs';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TPdfRasterDisplayProfile } from '@app/types/pdfRasterDisplayProfile';
import type { IPdfViewerTransactionRenderRequest } from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';
import type { IPageRenderStallPayload } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/pdfPageRenderTimeoutTypes';
import type { IPdfRenderSupervisor } from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';
import type { IPdfPageSlotRegistry } from '@app/modules/pdf-viewer/runtime/page-slots/pdfPageSlotRegistry';
import type { IPdfViewportWritePort } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportWritePort';
import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/bindPdfOpenSurfaceRenderContext';
export type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/bindPdfOpenSurfaceRenderContext';

export interface IPdfRendererSearchNavigationOptions {
    scrollToPage?: (pageNumber: number, options?: IScrollToPageOptions) => void;
    suppressSnap?: () => void;
    beginSearchNavigation?: (pageNumber: number) => void;
    revealSearchNavigationTarget?: (
        pageNumber: number,
        options?: Pick<IScrollToPageOptions, 'markerRect'>,
    ) => void;
    endSearchNavigation?: (settleMs?: number) => void;
    beginSearchTransaction?: (
        pageNumber: number,
        options?: Pick<IScrollToPageOptions, 'markerRect'>,
    ) => number | null;
    isSearchTransactionCurrent?: (transactionId: number) => boolean;
    settleSearchTransaction?: (transactionId: number) => void;
    cancelSearchTransaction?: (transactionId: number) => void;
}

export interface IUsePdfPageRendererOptions extends IPdfRendererSearchNavigationOptions {
    container: Ref<HTMLElement | null>;
    document: TPdfDocumentSession;
    currentPage: Ref<number>;
    isActive?: MaybeRefOrGetter<boolean>;
    effectiveScale: MaybeRefOrGetter<number>;
    bufferPages?: MaybeRefOrGetter<number>;
    renderConcurrency?: MaybeRefOrGetter<number>;
    showAnnotations?: MaybeRefOrGetter<boolean>;
    hiddenAnnotationIds?: MaybeRefOrGetter<Set<string>>;
    canvasHiddenAnnotationIds?: MaybeRefOrGetter<Set<string>> | undefined;
    managedAnnotationIds?: MaybeRefOrGetter<Set<string>>;
    /** Placeholder geometry is viewport-owned; the renderer only triggers it. */
    setupPagePlaceholders: () => void;
    outputScale?: MaybeRefOrGetter<number>;
    rasterDisplayProfile?: MaybeRefOrGetter<TPdfRasterDisplayProfile | null>;
    annotationUiManager?: MaybeRefOrGetter<AnnotationEditorUIManager | null>;
    annotationL10n?: MaybeRefOrGetter<IPdfjsL10n | null>;
    replaceAnnotationUiManager?: ((manager: AnnotationEditorUIManager) => void) | undefined;
    searchPageMatches?: MaybeRefOrGetter<Map<number, IPdfPageMatches>>;
    currentSearchMatch?: MaybeRefOrGetter<IPdfSearchMatch | null>;
    currentSearchMatchNavigationId?: MaybeRefOrGetter<number>;
    workingCopyPath?: MaybeRefOrGetter<TDocumentRef | null>;
    documentRevisionToken?: MaybeRefOrGetter<TDocumentRevisionToken | null>;
    onRenderStall?: (payload: IPageRenderStallPayload) => void;
    onPageRendered?: (pageNumber: number) => void;
    onPageCanvasMounted?: (commit: IPdfCanvasDomCommit) => void;
    resolveOpenSurfaceRenderContext?: (() => {
        openSurfaceGeneration: number;
        openSurfaceRevision: string;
    }) | undefined;
    isVisibleRenderRangeCurrent?: ((visibleRange: IPageRange) => boolean) | undefined;
    getProtectedVisibleRange?: (() => IPageRange) | undefined;
    isRenderRequestCurrent?: ((request: IPdfViewerTransactionRenderRequest) => boolean) | undefined;
    onAnnotationLayersRendered?: ((pageNumber: number, container: HTMLElement) => void) | undefined;
    onRenderedPageStateChanged?: () => void;
    renderSupervisor?: IPdfRenderSupervisor | undefined;
    pageSlots?: IPdfPageSlotRegistry | undefined;
    requestMandatoryRender?: ((
        visibleRange: IPageRange,
        options?: IRenderVisiblePagesOptions,
    ) => Promise<void>) | undefined;
    viewportWritePort: IPdfViewportWritePort;
}

export interface ICancelableRenderTask {
    cancel: () => void;
    promise: Promise<unknown>;
    onContinue?: RenderTask['onContinue'];
}

export interface IActivePdfRenderTask {
    version: number;
    requestId: number;
    task: ICancelableRenderTask;
}

export interface IActivePdfTextLayerTask {
    version: number;
    requestId: number;
    controller: AbortController;
}

export interface IPdfCanvasDomCommit {
    openSurfaceGeneration: number;
    documentRevision: string;
    renderVersion: number;
    requestId: number;
    pageNumber: number;
}

export interface IPdfLayerRenderResult {
    canvas: HTMLCanvasElement;
    viewport: ReturnType<PDFPageProxy['getViewport']>;
    annotationCanvasMap: Map<string, HTMLCanvasElement> | null;
    scaleX: number;
    scaleY: number;
    rawDims: {
        pageWidth: number;
        pageHeight: number;
    };
    userUnit: number;
    totalScaleFactor: number;
}

export interface IPdfPageLayerRenderContext {
    container: HTMLElement;
    pdfPage: PDFPageProxy;
    renderResult: IPdfLayerRenderResult;
    textLayerDiv: HTMLDivElement | null;
    annotationLayerInstance: unknown;
    preserveCanvasOnStale?: boolean;
}

export type TPdfTextLayerCleanup = () => void;

export type TClearSelectionBeforePageLayerTeardown = (pageNumber: number) => boolean;
