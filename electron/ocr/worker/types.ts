import type { IOcrWord } from '@contracts/shared';
import type {
    IOcrErrorEnvelope,
    IOcrSearchablePdfOptions,
    TOcrProgressPhase,
} from '@contracts/electronApiOcr';
import type {
    IDocumentRevisionInfo,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
export type { IRunCommandResult } from '@electron/utils/runElectronCommand';

export interface IWorkerPaths {
    tesseractBinary: string;
    tessdataPath: string;
    pdftoppmBinary: string;
    pdftotextBinary?: string;
    pdfimagesBinary?: string;
    popplerDataDir?: string;
    popplerFontConfigDir?: string;
    qpdfBinary: string;
    pdfPageOpsBinary?: string;
    unpaperBinary?: string;
    tempDir: string;
}

export type TOcrWorkerLogLevel = 'debug' | 'warn' | 'error';

export type TWorkerLog = (level: TOcrWorkerLogLevel, message: string) => void;

export interface IOcrPdfPageRequest {
    pageNumber: number;
    languages: string[];
}

export interface IOcrPageWithWords {
    pageNumber: number;
    words: IOcrWord[];
    text: string;
    imageWidth: number;
    imageHeight: number;
}

export interface IOcrFileResult {
    success: boolean;
    pageData: IOcrPageWithWords | null;
    pdfPath: string | null;
    error?: string;
}

export interface IOcrWorkerStartPayload {
    sourcePdfPath: string;
    documentRevision: IDocumentRevisionInfo;
    pages: IOcrPdfPageRequest[];
    renderDpi?: number;
    options?: IOcrSearchablePdfOptions;
}

export type TOcrWorkerInboundMessage =
    | {
        type: 'start';
        jobId: string;
        data: IOcrWorkerStartPayload;
    }
    | {
        type: 'cancel';
        jobId: string;
    }
    | {
        type: 'resource-acquired';
        jobId: string;
        requestId: string;
        token: string;
        effectiveDpi: number;
    }
    | {
        type: 'resource-denied';
        jobId: string;
        requestId: string;
        reason: string;
    };

interface IOcrWorkerProgressPayload {
    requestId: string;
    currentPage: number;
    processedCount: number;
    totalPages: number;
    phase?: TOcrProgressPhase;
    phaseProgress?: number;
}

export type TOcrWorkerCompleteResult =
    | {
        success: true;
        pdfPath: string;
        sourceDocumentRevisionToken: TDocumentRevisionToken;
        requiresCleanupAck: boolean;
        errors: string[];
    }
    | {
        success: false;
        errors: string[];
        errorEnvelope?: IOcrErrorEnvelope;
    };

export interface IOcrWorkerProgressMessage {
    type: 'progress';
    jobId: string;
    progress: IOcrWorkerProgressPayload;
}

export interface IOcrWorkerCompleteMessage {
    type: 'complete';
    jobId: string;
    result: TOcrWorkerCompleteResult;
}

export interface IOcrWorkerCleanupCompleteMessage {
    type: 'cleanup-complete';
    jobId: string;
}

export interface IOcrWorkerLogMessage {
    type: 'log';
    level: TOcrWorkerLogLevel;
    message: string;
}

export interface IOcrWorkerResourceAcquireMessage {
    type: 'resource-acquire';
    jobId: string;
    requestId: string;
    pageNumber: number;
    requestedDpi: number;
    pageWidthIn?: number;
    pageHeightIn?: number;
}

export interface IOcrWorkerResourceReleaseMessage {
    type: 'resource-release';
    jobId: string;
    token: string;
}

export type TOcrWorkerOutboundMessage =
    | IOcrWorkerProgressMessage
    | IOcrWorkerCompleteMessage
    | IOcrWorkerCleanupCompleteMessage
    | IOcrWorkerLogMessage
    | IOcrWorkerResourceAcquireMessage
    | IOcrWorkerResourceReleaseMessage;
