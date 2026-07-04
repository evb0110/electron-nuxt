import type { TDocumentRef } from '@contracts/documentRef';
import type { TDjvuPdfExportStrategy } from '@contracts/djvuConversionPolicy';
import type {
    TPdfViewMode,
    TPrintOrientation,
} from '@contracts/shared';
import type {
    TMenuEventCallback,
    TMenuEventUnsubscribe,
} from '@contracts/electronApiCommon';

export type { TDjvuPdfExportStrategy } from '@contracts/djvuConversionPolicy';

export interface IDjvuProgress {
    jobId: string;
    phase: 'converting' | 'bookmarks' | 'optimizing' | 'loading' | 'printing';
    status?: 'running' | 'success' | 'canceled' | 'failed';
    current?: number;
    total?: number;
    percent: number;
    error?: string;
}

export interface IDjvuInfo {
    pageCount: number;
    sourceDpi: number;
    hasBookmarks: boolean;
    hasText: boolean;
    metadata: Record<string, string>;
}

export interface IDjvuSizeEstimate {
    subsample: number;
    label: string;
    description: string;
    resultingDpi: number;
    estimatedBytes: number;
}

export interface IDjvuPageSize {
    width: number;
    height: number;
    dpi: number;
}

export interface IDjvuPagePreview {
    bytes: Uint8Array;
    width: number;
    height: number;
}

export interface IDjvuPagePreviewOptions {
    previewPriority?: number;
    previewRequestId?: string;
    subsample?: number;
}

export interface IDjvuConvertOptions {
    subsample?: number;
    preserveBookmarks?: boolean;
    pdfStrategy?: TDjvuPdfExportStrategy;
}

export interface IDjvuPrintOptions {
    fileName?: string;
    pageNumbers?: number[];
    viewMode: TPdfViewMode;
    orientation: TPrintOrientation;
    requestId?: string;
    subsample?: number;
    pdfStrategy?: TDjvuPdfExportStrategy;
}

export interface IDjvuOpenResult {
    success: boolean;
    pdfPath?: TDocumentRef;
    pageCount?: number;
    jobId?: string;
    error?: string;
}

export interface IDjvuConvertResult {
    success: boolean;
    pdfPath?: TDocumentRef;
    jobId?: string;
    error?: string;
}

export interface IDjvuPrintResult {
    success: boolean;
    canceled?: boolean;
    jobId?: string;
    error?: string;
}

export interface IDjvuViewingReadyEvent {
    pdfPath: TDocumentRef;
    isPartial: boolean;
    jobId?: string;
}

export interface IDjvuViewingErrorEvent {
    error: string;
    jobId?: string;
}

export interface IDjvuAPI {
    openForViewing: (djvuPath: TDocumentRef) => Promise<IDjvuOpenResult>;
    releaseViewingPath: (djvuPath: TDocumentRef) => Promise<void>;
    convertToPdf: (djvuPath: TDocumentRef, outputPath: string, options: IDjvuConvertOptions) => Promise<IDjvuConvertResult>;
    printDjvuPath: (djvuPath: TDocumentRef, options: IDjvuPrintOptions) => Promise<IDjvuPrintResult>;
    cancel: (jobId: string) => Promise<{ canceled: boolean }>;
    cancelPagePreview: (requestId: string) => Promise<{ canceled: boolean }>;
    getInfo: (djvuPath: TDocumentRef) => Promise<IDjvuInfo>;
    getPageSizes: (djvuPath: TDocumentRef) => Promise<IDjvuPageSize[]>;
    renderPagePreview: (
        djvuPath: TDocumentRef,
        pageNumber: number,
        options?: IDjvuPagePreviewOptions,
    ) => Promise<IDjvuPagePreview>;
    estimateSizes: (djvuPath: TDocumentRef) => Promise<IDjvuSizeEstimate[]>;
    cleanupTemp: (tempPdfPath: TDocumentRef) => Promise<void>;
    onProgress: (callback: (progress: IDjvuProgress) => void) => () => void;
    onViewingReady: (callback: (data: IDjvuViewingReadyEvent) => void) => () => void;
    onViewingError: (callback: (data: IDjvuViewingErrorEvent) => void) => () => void;
}

export interface IDjvuCapability extends IDjvuAPI {onMenuConvertToPdf: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;}
