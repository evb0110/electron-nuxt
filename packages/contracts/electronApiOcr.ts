import type { TDocumentRef } from './document';
import type { IOcrLanguage } from './shared';

export type TOcrErrorCode =
    | 'OCR_INVALID_PAYLOAD'
    | 'OCR_INTERNAL_ERROR'
    | 'OCR_QUEUE_BACKPRESSURE'
    | 'OCR_WORKER_UNAVAILABLE'
    | 'OCR_TOOLS_VALIDATION_FAILED';

export interface IOcrErrorEnvelope {
    code: TOcrErrorCode;
    message: string;
    retryable: boolean;
    timestamp: number;
    details?: string;
}

export interface IOcrErrorEnvelopeCarrier {errorEnvelope?: IOcrErrorEnvelope;}

export interface IOcrRecognizeRequest {
    pageNumber: number;
    imageData: Uint8Array;
    languages: string[];
    imageWidth?: number;
    imageHeight?: number;
}

export interface IOcrRecognizeResult extends IOcrErrorEnvelopeCarrier {
    pageNumber: number;
    success: boolean;
    text: string;
    error?: string;
}

export interface IOcrProgress {
    requestId: string;
    currentPage: number;
    processedCount: number;
    totalPages: number;
    phase?: 'preparing' | 'processing';
    phaseProgress?: number;
    activePages?: number[];
    languageCode?: string;
}

export interface IOcrJobStartResult extends IOcrErrorEnvelopeCarrier {
    started: boolean;
    jobId: string;
    error?: string;
    installed?: string[];
    errors?: string[];
}

export interface IOcrResultFileAckResult extends IOcrErrorEnvelopeCarrier {
    cleaned: boolean;
    error?: string;
}

export interface IOcrRecognizeBatchResult extends IOcrErrorEnvelopeCarrier {
    results: Record<number, string>;
    errors: string[];
}

export interface IOcrCompleteResult {
    requestId: string;
    success: boolean;
    pdfPath?: TDocumentRef;
    requiresCleanupAck?: boolean;
    errors: string[];
}

export interface IPreprocessingValidationResult {
    valid: boolean;
    available: string[];
    missing: string[];
}

export interface IPreprocessPageResult {
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
    cancel: (requestId: string) => Promise<{ canceled: boolean }>;
    getLanguages: () => Promise<IOcrLanguage[]>;
    installLanguages: (languages: string[], requestId: string) => Promise<IOcrJobStartResult>;
    acknowledgeResultFile: (requestId: string, pdfPath?: TDocumentRef) => Promise<IOcrResultFileAckResult>;
    createSearchablePdf: (
        sourcePdfPath: string,
        pages: Array<{
            pageNumber: number;
            languages: string[];
        }>,
        requestId: string,
        renderDpi?: number,
    ) => Promise<IOcrJobStartResult>;
    onProgress: (callback: (progress: IOcrProgress) => void) => () => void;
    onComplete: (callback: (result: IOcrCompleteResult) => void) => () => void;

    preprocessing: {
        validate: () => Promise<IPreprocessingValidationResult>;
        preprocessPage: (imageData: Uint8Array, usePreprocessing: boolean) => Promise<IPreprocessPageResult>;
    };
}
