import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { IOcrLanguage } from '@contracts/shared';
import type {
    IDocumentOcrAvailability,
    IDocumentOcrPageSnapshot,
    IDocumentTextSnapshot,
} from '@contracts/documentTextCatalog';

export type TOcrErrorCode =
    | 'OCR_INVALID_PAYLOAD'
    | 'OCR_INTERNAL_ERROR'
    | 'OCR_QUEUE_BACKPRESSURE'
    | 'OCR_WORKER_UNAVAILABLE'
    | 'OCR_TOOLS_VALIDATION_FAILED';

export const OCR_ERROR_CODES = [
    'OCR_INVALID_PAYLOAD',
    'OCR_INTERNAL_ERROR',
    'OCR_QUEUE_BACKPRESSURE',
    'OCR_WORKER_UNAVAILABLE',
    'OCR_TOOLS_VALIDATION_FAILED',
] as const satisfies readonly TOcrErrorCode[];

export interface IOcrErrorEnvelope {
    code: TOcrErrorCode;
    message: string;
    retryable: boolean;
    timestamp: number;
    details?: string;
}

export interface IOcrErrorEnvelopeCarrier {errorEnvelope?: IOcrErrorEnvelope;}

export type TOcrDiagnosticCode =
    | 'OCR_PREPROCESSING_UNAVAILABLE'
    | 'OCR_PREPROCESSING_FAILED'
    | 'OCR_PREPROCESSING_GEOMETRY_CHANGED'
    | 'OCR_SOURCE_DPI_LIMITED'
    | 'OCR_EXISTING_TEXT_SKIPPED';

export const OCR_DIAGNOSTIC_CODES = [
    'OCR_PREPROCESSING_UNAVAILABLE',
    'OCR_PREPROCESSING_FAILED',
    'OCR_PREPROCESSING_GEOMETRY_CHANGED',
    'OCR_SOURCE_DPI_LIMITED',
    'OCR_EXISTING_TEXT_SKIPPED',
] as const satisfies readonly TOcrDiagnosticCode[];

export interface IOcrDiagnostic {
    code: TOcrDiagnosticCode;
    severity: 'info' | 'warning';
    message: string;
    pageNumber?: number;
}

export interface IOcrRecognizeRequest {
    pageNumber: number;
    imageData: Uint8Array;
    languages: string[];
    imageWidth?: number;
    imageHeight?: number;
}

export type TOcrQualityProfile = 'balanced' | 'accurate' | 'poor-scan';
export type TOcrPreprocessingMode = 'off' | 'clean';
export type TOcrTextSupersessionPolicy = 'missing-only' | 'replace-evb' | 'replace-all';
export type TOcrPageTextClassification =
    | 'native-text'
    | 'foreign-hidden-ocr'
    | 'evb-current-generation'
    | 'no-text';

export interface IOcrSearchablePdfOptions {
    renderDpi?: number;
    qualityProfile?: TOcrQualityProfile;
    preprocessingMode?: TOcrPreprocessingMode;
    pageSegmentationMode?: number;
    /** Defaults to missing-only. replace-all requires an explicit UI acknowledgement. */
    supersessionPolicy?: TOcrTextSupersessionPolicy;
    /** Required when supersessionPolicy is replace-all. */
    replaceAllAcknowledged?: boolean;
}

export interface IOcrRecognizeResult extends IOcrErrorEnvelopeCarrier {
    pageNumber: number;
    success: boolean;
    text: string;
    error?: string;
}

export type TOcrProgressPhase =
    | 'preparing'
    | 'model-prep'
    | 'pdf-prep'
    | 'dpi-inspection'
    | 'page-size-probing'
    | 'processing'
    | 'merging'
    | 'indexing';

export const OCR_PROGRESS_PHASES = [
    'preparing',
    'model-prep',
    'pdf-prep',
    'dpi-inspection',
    'page-size-probing',
    'processing',
    'merging',
    'indexing',
] as const satisfies readonly TOcrProgressPhase[];
export type TOcrProgressStatus = 'running' | 'success' | 'canceled' | 'failed';

export interface IOcrProgress {
    requestId: string;
    currentPage: number;
    processedCount: number;
    totalPages: number;
    phase?: TOcrProgressPhase;
    phaseProgress?: number;
    activePages?: number[];
    languageCode?: string;
    status?: TOcrProgressStatus;
    error?: string;
}

export interface IOcrJobStartResult extends IOcrErrorEnvelopeCarrier {
    started: boolean;
    jobId: string;
    error?: string;
    installed?: string[];
    errors?: string[];
}

export type TOcrCancelFailureReason = 'invalid-request' | 'not-found' | 'failed';

export interface IOcrCancelResult extends IOcrErrorEnvelopeCarrier {
    canceled: boolean;
    reason?: TOcrCancelFailureReason;
    error?: string;
}

export interface IOcrResultFileAckResult extends IOcrErrorEnvelopeCarrier {
    cleaned: boolean;
    error?: string;
}

export interface IOcrRecognizeBatchResult extends IOcrErrorEnvelopeCarrier {
    results: Record<number, string>;
    errors: string[];
}

export interface IOcrCompleteResult extends IOcrErrorEnvelopeCarrier {
    requestId: string;
    success: boolean;
    pdfPath?: TDocumentRef;
    sourceDocumentRevisionToken?: TDocumentRevisionToken;
    resultSha256?: string;
    requiresCleanupAck?: boolean;
    errors: string[];
    diagnostics?: IOcrDiagnostic[];
}

export type TOcrJobProjectionPhase = TOcrProgressPhase
    | 'queued'
    | 'recognizing'
    | 'applying'
    | 'cancel-requested';

export interface IOcrJobProjectionState {
    jobId: string;
    requestId: string;
    status: 'queued' | 'running' | 'handoff' | 'completed' | 'canceled' | 'failed';
    phase: TOcrJobProjectionPhase;
    percent: number;
    current?: number;
    total?: number;
    error?: string;
    updatedAtMs: number;
    supersessionPolicy?: TOcrTextSupersessionPolicy;
    replaceAllAcknowledged?: boolean;
}

export interface IPreprocessingValidationResult extends IOcrErrorEnvelopeCarrier {
    valid: boolean;
    available: string[];
    missing: string[];
}

export interface IOcrToolValidationResult extends IOcrErrorEnvelopeCarrier {
    valid: boolean;
    tools: {
        tesseract: {
            found: boolean;
            path: string;
            version?: string;
        };
        tessdata: {
            found: boolean;
            path: string;
            languages?: string[];
            /** Supported models not installed yet; resolved through the on-demand model flow. */
            onDemandLanguages?: string[];
        };
        pdftoppm: {
            found: boolean;
            path: string;
        };
        pdftotext: {
            found: boolean;
            path: string;
        };
        popplerRuntime: {
            dataDirFound: boolean;
            dataDir?: string;
            fontConfigDirFound: boolean;
            fontConfigDir?: string;
        };
        qpdf: {
            found: boolean;
            path: string;
        };
    };
    errors: string[];
}

export interface IPreprocessPageResult extends IOcrErrorEnvelopeCarrier {
    success: boolean;
    imageData: Uint8Array;
    message?: string;
    error?: string;
}

export interface IOcrCapability {
    recognize: (request: IOcrRecognizeRequest) => Promise<IOcrRecognizeResult>;
    recognizeBatch: (
        pages: IOcrRecognizeRequest[],
        requestId: string,
    ) => Promise<IOcrRecognizeBatchResult>;
    cancel: (requestId: string) => Promise<IOcrCancelResult>;
    getJobState: (requestId: string) => Promise<IOcrJobProjectionState | null>;
    subscribeJob: (requestId: string) => Promise<IOcrJobProjectionState | null>;
    reconnectJob: (requestId: string) => Promise<IOcrJobProjectionState | null>;
    getLanguages: () => Promise<IOcrLanguage[]>;
    resolveDocumentTextCatalog: (
        workingCopyPath: TDocumentRef,
        documentRevision: TDocumentRevisionToken,
        pageCount?: number,
    ) => Promise<IDocumentTextSnapshot>;
    resolveDocumentOcrAvailability?: (
        workingCopyPath: TDocumentRef,
        documentRevision: TDocumentRevisionToken,
    ) => Promise<IDocumentOcrAvailability>;
    resolveDocumentOcrPage?: (
        workingCopyPath: TDocumentRef,
        documentRevision: TDocumentRevisionToken,
        pageNumber: number,
    ) => Promise<IDocumentOcrPageSnapshot>;
    validateTools: () => Promise<IOcrToolValidationResult>;
    installLanguages: (languages: string[], requestId: string) => Promise<IOcrJobStartResult>;
    acknowledgeResultFile: (requestId: string, pdfPath?: TDocumentRef) => Promise<IOcrResultFileAckResult>;
    createSearchablePdf: (
        sourcePdfPath: string,
        pages: Array<{
            pageNumber: number;
            languages: string[];
        }>,
        requestId: string,
        renderDpiOrOptions?: number | IOcrSearchablePdfOptions,
    ) => Promise<IOcrJobStartResult>;
    onProgress: (callback: (progress: IOcrProgress) => void) => () => void;
    onComplete: (callback: (result: IOcrCompleteResult) => void) => () => void;

    preprocessing: {
        validate: () => Promise<IPreprocessingValidationResult>;
        preprocessPage: (imageData: Uint8Array, usePreprocessing: boolean) => Promise<IPreprocessPageResult>;
    };
}
