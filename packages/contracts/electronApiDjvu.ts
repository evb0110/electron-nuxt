import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IMenuEventCallback,
    IMenuEventUnsubscribe,
} from '@contracts/electronApiCommon';

export interface IDjvuProgress {
    jobId: string;
    phase: 'converting' | 'bookmarks' | 'loading';
    current?: number;
    total?: number;
    percent: number;
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

export interface IDjvuConvertOptions {
    subsample?: number;
    preserveBookmarks?: boolean;
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
    cancel: (jobId: string) => Promise<{ canceled: boolean }>;
    getInfo: (djvuPath: TDocumentRef) => Promise<IDjvuInfo>;
    getPageSizes: (djvuPath: TDocumentRef) => Promise<IDjvuPageSize[]>;
    renderPagePreview: (djvuPath: TDocumentRef, pageNumber: number) => Promise<IDjvuPagePreview>;
    estimateSizes: (djvuPath: TDocumentRef) => Promise<IDjvuSizeEstimate[]>;
    cleanupTemp: (tempPdfPath: TDocumentRef) => Promise<void>;
    onProgress: (callback: (progress: IDjvuProgress) => void) => () => void;
    onViewingReady: (callback: (data: IDjvuViewingReadyEvent) => void) => () => void;
    onViewingError: (callback: (data: IDjvuViewingErrorEvent) => void) => () => void;
}

export interface IDjvuCapability extends IDjvuAPI {onMenuConvertToPdf: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;}
