import type { IOcrLanguage } from '@contracts/shared';

export const OCR_CHANNELS = {
    recognize: 'ocr:recognize',
    recognizeBatch: 'ocr:recognizeBatch',
    createSearchablePdf: 'ocr:createSearchablePdf',
    cancel: 'ocr:cancel',
    acknowledgeResultFile: 'ocr:ackResultFile',
    getLanguages: 'ocr:getLanguages',
    validateTools: 'ocr:validateTools',
    preprocessingValidate: 'preprocessing:validate',
    preprocessingPreprocessPage: 'preprocessing:preprocessPage',
} as const;

export const OCR_EVENT_CHANNELS = {
    progress: 'ocr:progress',
    complete: 'ocr:complete',
} as const;

export interface IOcrRecognizeRequest {
    pageNumber: number;
    imageData: Uint8Array;
    languages: string[];
}

export interface IOcrRecognizeResult {
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
}

export interface IOcrJobStartResult {
    started: boolean;
    jobId: string;
    error?: string;
}

export interface IOcrResultFileAckResult {
    cleaned: boolean;
    error?: string;
}

export interface IOcrCreateSearchablePdfPage {
    pageNumber: number;
    languages: string[];
}

export interface IOcrCompleteResult {
    requestId: string;
    success: boolean;
    pdfData: Uint8Array | null;
    pdfPath?: string;
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
    ) => Promise<{
        results: Record<number, string>;
        errors: string[];
    }>;
    cancel: (requestId: string) => Promise<{ canceled: boolean }>;
    getLanguages: () => Promise<IOcrLanguage[]>;
    acknowledgeResultFile: (requestId: string, pdfPath?: string) => Promise<IOcrResultFileAckResult>;
    createSearchablePdf: (
        originalPdfData: Uint8Array,
        pages: IOcrCreateSearchablePdfPage[],
        requestId: string,
        workingCopyPath?: string | null,
        renderDpi?: number,
    ) => Promise<IOcrJobStartResult>;
    onProgress: (callback: (progress: IOcrProgress) => void) => () => void;
    onComplete: (callback: (result: IOcrCompleteResult) => void) => () => void;
    preprocessing: {
        validate: () => Promise<IPreprocessingValidationResult>;
        preprocessPage: (imageData: Uint8Array, usePreprocessing: boolean) => Promise<IPreprocessPageResult>;
    };
}
