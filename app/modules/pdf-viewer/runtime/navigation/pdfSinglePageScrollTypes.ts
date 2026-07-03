import type {
    Ref,
    ShallowRef,
} from 'vue';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import type { TPdfViewMode } from '@contracts/shared';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';

export interface IPagedRowRenderRequest {
    pageNumber: number;
    message: string;
    runId: number;
}

export interface IApplySnapToMountedPageCommitOptions {commitCurrentPage?: boolean;}

export interface ITransactionVisibleRangeCommitOptions { transactionId?: number | undefined }

export interface ITransactionCurrentPageCommitOptions {
    previousPage?: number | undefined;
    transactionId?: number | undefined;
}

export interface IUsePdfSinglePageScrollOptions {
    viewerContainer: Ref<HTMLElement | null>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    scaledMargin: Ref<number>;
    viewMode: Ref<TPdfViewMode>;
    continuousScroll: Ref<boolean>;
    isLoading: Ref<boolean>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    getMostVisiblePage: (
        container: HTMLElement | null,
        numPages: number,
    ) => number;
    scrollToPageInternal: (
        container: HTMLElement,
        page: number,
        total: number,
        margin: number,
        options?: IScrollToPageOptions,
    ) => void;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    updateCurrentPage: (
        container: HTMLElement | null,
        numPages: number,
        options?: { requireAuthoritative?: boolean; },
    ) => number;
    commitVisibleRange?: ((
        range: {
            start: number;
            end: number;
        },
        options?: ITransactionVisibleRangeCommitOptions,
    ) => boolean | undefined) | undefined;
    commitCurrentPage?: ((
        page: number,
        options?: ITransactionCurrentPageCommitOptions,
    ) => boolean | undefined) | undefined;
    renderVisiblePages: (
        range: {
            start: number;
            end: number
        },
        renderOptions?: IRenderVisiblePagesOptions,
    ) => Promise<void>;
    ensurePageMetricsInRange?: ((startPage: number, endPage: number) => Promise<boolean>) | undefined;
    isPageFreshlyRenderedForNavigation?: ((pageNumber: number) => boolean) | undefined;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    emitCurrentPage: (page: number) => void;
    emitNavigationFeedbackPage?: ((page: number | null) => void) | undefined;
}
