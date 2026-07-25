import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
} from '@app/types/annotations';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/scrollToPageOptions';
import type { IPdfPageRasterScheduler } from '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler';

export interface IPdfThumbnailsProps {
    pdfDocument: PDFDocumentProxy | null;
    rasterScheduler: IPdfPageRasterScheduler | null;
    currentPage: number;
    totalPages: number;
    pageLabels?: string[] | null | undefined;
    selectedPages?: number[] | undefined;
    invalidationRequest?: {
        id: number;
        pages: number[];
    } | null | undefined;
    hiddenAnnotationIds?: string[] | undefined;
    annotationComments?: IAnnotationCommentSummary[] | undefined;
    annotationSettings?: IAnnotationSettings | null | undefined;
    isActive?: boolean | undefined;
    isResizing?: boolean | undefined;
}

export interface IPdfThumbnailsEmits {
    'go-to-page': [page: number, options?: IScrollToPageOptions];
    'update:selected-pages': [pages: number[]];
    'page-context-menu': [payload: {
        clientX: number;
        clientY: number;
        pages: number[];
    }];
    reorder: [newOrder: number[]];
    'file-drop': [payload: {
        afterPage: number;
        filePaths: TDocumentRef[];
    }];
}
