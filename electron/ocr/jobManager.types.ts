import type { Worker } from 'worker_threads';
import type {
    IOcrCompleteResult,
    IOcrErrorEnvelope,
    IOcrProgress,
    IOcrSearchablePdfOptions,
    TOcrTextSupersessionPolicy,
} from '@contracts/electronApiOcr';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import type { IJobBrokerLease } from '@electron/resources/jobBroker';
import type {
    IOcrPdfPageRequest,
    TOcrWorkerCompleteResult,
} from '@electron/ocr/worker/types';
import type { IMainJobRunContext } from '@electron/operation-lifecycle/createMainJobRegistry';

export interface IOcrRegistryProgress extends IOcrProgress {projection: {
    supersessionPolicy: TOcrTextSupersessionPolicy;
    replaceAllAcknowledged: boolean;
};}

export type TOcrRegistryContext = IMainJobRunContext<
    IOcrRegistryProgress,
    IOcrCompleteResult,
    IOcrErrorEnvelope
>;

interface IOcrRegistryJob {
    registry: TOcrRegistryContext;
    cancel: (reason?: string) => boolean;
    settled: Promise<void>;
    workerSettlement: Promise<IOcrCompleteResult>;
    resolveWorkerSettlement: (result: IOcrCompleteResult) => void;
    terminalResult: IOcrCompleteResult | null;
}

export interface IOcrQueuedJob extends IOcrRegistryJob {
    scopedJobId: string;
    documentJobKey: string;
    requestId: string;
    webContentsId: number;
    sourcePdfPath: string;
    documentRevision: IDocumentRevisionInfo;
    pages: IOcrPdfPageRequest[];
    options: IOcrSearchablePdfOptions;
    queuedAtMs: number;
    requestedBytes: number;
    pageWork: number;
}

export interface IOcrPreparingJob extends IOcrRegistryJob {
    scopedJobId: string;
    documentJobKey: string;
    requestId: string;
    webContentsId: number;
    sourcePdfPath: string;
    documentRevision: IDocumentRevisionInfo;
    requestedBytes: number;
    pageWork: number;
    startedAtMs: number;
}

export interface IOcrActiveJob extends IOcrQueuedJob {
    workerAdmissionLease: IJobBrokerLease;
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
    resultSha256: string;
    createdAtMs: number;
    cleanupTimer: NodeJS.Timeout | null;
}
