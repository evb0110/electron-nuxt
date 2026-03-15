import type { Worker } from 'worker_threads';
import type { IOcrPdfPageRequest } from '@electron/ocr/worker/types';

export interface IOcrQueuedJob {
    scopedJobId: string;
    requestId: string;
    webContentsId: number;
    sourcePdfPath: string;
    pages: IOcrPdfPageRequest[];
    renderDpi?: number;
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
