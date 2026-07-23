import type { TDocumentRef } from '@contracts/documentRef';
import type { TDjvuPdfExportStrategy } from '@contracts/djvuConversionPolicy';
import type {
    TPdfViewMode,
    TPrintOrientation,
} from '@contracts/shared';
import type {
    IPdfSearchProgress,
    IPdfSearchResponse,
    ISearchMatchOptions,
} from '@contracts/search';

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

export const DJVU_DOCUMENT_OUTPUT_OPERATIONS = [
    'djvu-convert',
    'djvu-open',
    'djvu-print',
] as const;

export type TDjvuDocumentOutputOperation = typeof DJVU_DOCUMENT_OUTPUT_OPERATIONS[number];

export function isDjvuDocumentOutputOperation(value: unknown): value is TDjvuDocumentOutputOperation {
    return DJVU_DOCUMENT_OUTPUT_OPERATIONS.some(operation => value === operation);
}

export type TDocumentOutputOperation = TDjvuDocumentOutputOperation;

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

export interface IDjvuPageSourceInfo {
    pageCount: number;
    pageNumber: number;
    pageSize: IDjvuPageSize;
    /** Native source revision used to fence trusted pre-open geometry. */
    sourceSize?: number;
    sourceModifiedAt?: number;
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

export interface IDjvuTextSearchOptions extends ISearchMatchOptions {
    requestId: string;
    pageCount: number;
}

export interface IDjvuTextSearchProgress extends IPdfSearchProgress {}

export interface IDjvuTextSearchResponse extends IPdfSearchResponse {}

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
    pageSourceInfo?: IDjvuPageSourceInfo;
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
