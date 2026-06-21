import type { Worker } from 'worker_threads';
import type { IOcrSearchablePdfOptions } from '@contracts/electronApiOcr';
import type {
    IOcrPdfPageRequest,
    TOcrWorkerCompleteResult,
} from '@electron/ocr/worker/types';

export interface IOcrQueuedJob {
    scopedJobId: string;
    requestId: string;
    webContentsId: number;
    sourcePdfPath: string;
    pages: IOcrPdfPageRequest[];
    options: IOcrSearchablePdfOptions;
    queuedAtMs: number;
    requestedBytes: number;
}

export interface IOcrPreparingJob {
    scopedJobId: string;
    requestId: string;
    webContentsId: number;
    requestedBytes: number;
    startedAtMs: number;
    abortController: AbortController;
}

export interface IOcrActiveJob extends IOcrQueuedJob {
    worker: Worker;
    completed: boolean;
    terminatedByUs: boolean;
    pendingCompletionResult: TOcrWorkerCompleteResult | null;
    terminalResultSent: boolean;
    startedAtMs: number;
    watchdogTimer: NodeJS.Timeout | null;
}

export interface IOcrPendingResultFile {
    scopedJobId: string;
    requestId: string;
    webContentsId: number;
    pdfPath: string;
    createdAtMs: number;
    cleanupTimer: NodeJS.Timeout | null;
}
