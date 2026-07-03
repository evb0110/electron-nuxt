import type { TOcrErrorCode } from '@contracts/electronApiOcr';

export interface IOcrQueueStartResult {
    started: boolean;
    jobId: string;
    error?: string;
    errorCode?: TOcrErrorCode;
}

export function createOcrQueueFailure(
    requestId: string,
    error: string,
    errorCode: TOcrErrorCode = 'OCR_INTERNAL_ERROR',
): IOcrQueueStartResult {
    return {
        started: false,
        jobId: requestId,
        error,
        errorCode,
    };
}
