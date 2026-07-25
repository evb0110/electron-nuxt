import type {
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
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { IPdfRenderSupervisor } from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';
import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/bindPdfOpenSurfaceRenderContext';
import type { TPdfPageRenderState } from '@app/modules/pdf-viewer/runtime/rendering/pdfPageRenderState';
import type { TPdfViewportSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
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

export interface IUsePdfPageRendererOptions {
    container: Ref<HTMLElement | null>;
    document: TPdfDocumentSession;
    viewport: TPdfViewportSession;
    isActive?: MaybeRefOrGetter<boolean>;
    showAnnotations?: MaybeRefOrGetter<boolean>;
    outputScale?: MaybeRefOrGetter<number>;
    searchPageMatches?: MaybeRefOrGetter<Map<number, IPdfPageMatches>>;
    currentSearchMatch?: MaybeRefOrGetter<IPdfSearchMatch | null>;
    currentSearchMatchNavigationId?: MaybeRefOrGetter<number>;
    workingCopyPath?: MaybeRefOrGetter<TDocumentRef | null>;
    documentRevisionToken?: MaybeRefOrGetter<TDocumentRevisionToken | null>;
    onPageRendered?: (pageNumber: number) => void;
    onRenderedPageStateChanged?: () => void;
    renderSupervisor?: IPdfRenderSupervisor | undefined;
    /** RenderingSession owns this state; the post-canvas runtime only derives from it. */
    pageRenderState: TPdfPageRenderState;
    pageCanvases: Map<number, HTMLCanvasElement>;
    getRenderVersion: () => number;
    getRenderDocumentToken: () => string;
    requestRaster: (
        range: IPageRange,
        options?: IRenderVisiblePagesOptions,
    ) => Promise<void>;
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
