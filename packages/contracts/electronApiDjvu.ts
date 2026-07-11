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
    requestId?: string;
    documentRef?: TDocumentRef;
    phase: 'converting' | 'bookmarks' | 'optimizing' | 'loading' | 'printing';
    status?: 'running' | 'success' | 'canceled' | 'failed';
    current?: number;
    total?: number;
    percent: number;
    error?: string;
}

export type TDocumentOutputOperation = 'djvu-convert' | 'djvu-open' | 'djvu-print';

export type TDocumentOutputJobState =
    | {
        jobId: string;
        operation: TDocumentOutputOperation;
        status: 'queued' | 'running';
        progress: IDjvuProgress;
        updatedAtMs: number;
    }
    | {
        jobId: string;
        operation: TDocumentOutputOperation;
        status: 'handoff';
        artifactPath: TDocumentRef;
        progress: IDjvuProgress;
        updatedAtMs: number;
    }
    | {
        jobId: string;
        operation: TDocumentOutputOperation;
        status: 'completed';
        artifactPath?: TDocumentRef;
        progress: IDjvuProgress;
        updatedAtMs: number;
    }
    | {
        jobId: string;
        operation: TDocumentOutputOperation;
        status: 'canceled' | 'failed';
        error?: string;
        progress: IDjvuProgress;
        updatedAtMs: number;
    };

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
    targetWidthPx?: number;
}

export interface IDjvuConvertOptions {
    jobId?: string;
    subsample?: number;
    preserveBookmarks?: boolean;
    pdfStrategy?: TDjvuPdfExportStrategy;
    requestId?: string;
    documentRef?: TDocumentRef;
}

export interface IDjvuJobStartHandle {
    jobId: string;
    requestId: string;
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
    pageCount?: number;
    jobId?: string;
    error?: string;
}

export interface IDjvuConvertResult {
    success: boolean;
    pdfPath?: TDocumentRef;
    jobId?: string;
    requestId?: string;
    documentRef?: TDocumentRef;
    error?: string;
}

export interface IDjvuPrintResult {
    success: boolean;
    canceled?: boolean;
    jobId?: string;
    error?: string;
}

export interface IDjvuAPI {
    startOpenForViewing: (djvuPath: TDocumentRef, requestId: string) => Promise<IDjvuJobStartHandle>;
    awaitOpenJob: (jobId: string) => Promise<IDjvuOpenResult>;
    openForViewing: (djvuPath: TDocumentRef) => Promise<IDjvuOpenResult>;
    releaseViewingPath: (djvuPath: TDocumentRef) => Promise<void>;
    convertToPdf: (djvuPath: TDocumentRef, outputPath: string, options: IDjvuConvertOptions) => Promise<IDjvuConvertResult>;
    startConvertToPdf: (djvuPath: TDocumentRef, outputPath: string, options: IDjvuConvertOptions) => Promise<IDjvuJobStartHandle>;
    awaitConvertJob: (jobId: string) => Promise<IDjvuConvertResult>;
    printDjvuPath: (djvuPath: TDocumentRef, options: IDjvuPrintOptions) => Promise<IDjvuPrintResult>;
    cancel: (jobId: string) => Promise<{ canceled: boolean }>;
    getJobState: (jobId: string) => Promise<TDocumentOutputJobState | null>;
    subscribeJob: (jobId: string) => Promise<TDocumentOutputJobState | null>;
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
}

export interface IDjvuCapability extends IDjvuAPI {onMenuConvertToPdf: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;}
