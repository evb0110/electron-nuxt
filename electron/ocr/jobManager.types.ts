import type { Worker } from 'worker_threads';
import type { IOcrSearchablePdfOptions } from '@contracts/electronApiOcr';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import type { TOcrJobLifecycleState } from '@electron/ocr/ocrJobLifecycle';
import type {
    IOcrPdfPageRequest,
    TOcrWorkerCompleteResult,
} from '@electron/ocr/worker/types';

export interface IOcrQueuedJob<TState extends TOcrJobLifecycleState = TOcrJobLifecycleState> {
    lifecycleState: TState;
    scopedJobId: string;
    requestId: string;
    webContentsId: number;
    sourcePdfPath: string;
    documentRevision: IDocumentRevisionInfo;
    pages: IOcrPdfPageRequest[];
    options: IOcrSearchablePdfOptions;
    queuedAtMs: number;
    requestedBytes: number;
}

export interface IOcrPreparingJob {
    lifecycleState: 'preparing' | 'cancelling';
    scopedJobId: string;
    requestId: string;
    webContentsId: number;
    sourcePdfPath: string;
    documentRevision: IDocumentRevisionInfo;
    requestedBytes: number;
    startedAtMs: number;
    abortController: AbortController;
}

export interface IOcrActiveJob extends IOcrQueuedJob<'active' | 'cancelling' | 'terminal-result-sent'> {
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
