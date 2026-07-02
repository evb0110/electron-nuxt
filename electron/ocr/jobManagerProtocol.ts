import type { TOcrWorkerOutboundMessage } from '@electron/ocr/worker/types';
import type { IOcrErrorEnvelope } from '@contracts/electronApiOcr';
import {
    OCR_ERROR_CODES,
    OCR_PROGRESS_PHASES,
} from '@contracts/electronApiOcr';
import {
    createAbortError,
    isAbortError,
} from '@electron/utils/abort';
import {
    isFiniteNumber,
    isOneOf,
    isRecord,
    isStringArray,
} from '@contracts/runtimeGuards';

export {
    createAbortError,
    isAbortError,
};

function parseOptionalProgressPhase(value: unknown) {
    return isOneOf(OCR_PROGRESS_PHASES, value)
        ? value
        : undefined;
}

export function createTimeoutError(message: string) {
    const error = new Error(message);
    error.name = 'TimeoutError';
    return error;
}

export function toScopedOcrJobId(webContentsId: number, requestId: string) {
    return `${webContentsId}:${requestId}`;
}

export function isScopedJobOwnedBySender(scopedJobId: string, webContentsId: number) {
    return scopedJobId.startsWith(`${webContentsId}:`);
}

export type TOcrWorkerManagerMessage = Exclude<
    TOcrWorkerOutboundMessage,
    { type: 'resource-acquire' } | { type: 'resource-release' }
>;

function parseWorkerLogMessage(message: Record<string, unknown>): TOcrWorkerManagerMessage | null {
    if (
        (message.level === 'debug' || message.level === 'warn' || message.level === 'error')
        && typeof message.message === 'string'
    ) {
        return {
            type: 'log',
            level: message.level,
            message: message.message,
        };
    }
    return null;
}

function parseWorkerProgressMessage(message: Record<string, unknown>): TOcrWorkerManagerMessage | null {
    const progress = message.progress;
    if (!isRecord(progress) || typeof message.jobId !== 'string' || typeof progress.requestId !== 'string') {
        return null;
    }

    if (
        !isFiniteNumber(progress.currentPage)
        || !isFiniteNumber(progress.processedCount)
        || !isFiniteNumber(progress.totalPages)
    ) {
        return null;
    }

    const parsedProgress: TOcrWorkerManagerMessage = {
        type: 'progress',
        jobId: message.jobId,
        progress: {
            requestId: progress.requestId,
            currentPage: progress.currentPage,
            processedCount: progress.processedCount,
            totalPages: progress.totalPages,
        },
    };
    const phase = parseOptionalProgressPhase(progress.phase);
    if (phase !== undefined) {
        parsedProgress.progress.phase = phase;
    }
    if (isFiniteNumber(progress.phaseProgress)) {
        parsedProgress.progress.phaseProgress = progress.phaseProgress;
    }
    return parsedProgress;
}

function parseSuccessfulCompleteResult(
    result: Record<string, unknown>,
    errors: string[],
) {
    const normalizedPdfPath = typeof result.pdfPath === 'string'
        ? result.pdfPath.trim()
        : '';
    if (normalizedPdfPath.length === 0 || typeof result.requiresCleanupAck !== 'boolean') {
        return null;
    }

    return {
        success: true as const,
        pdfPath: normalizedPdfPath,
        requiresCleanupAck: result.requiresCleanupAck,
        errors,
    };
}

function parseOcrErrorEnvelope(value: unknown): IOcrErrorEnvelope | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    if (
        !isOneOf(OCR_ERROR_CODES, value.code)
        || typeof value.message !== 'string'
        || typeof value.retryable !== 'boolean'
        || !isFiniteNumber(value.timestamp)
    ) {
        return undefined;
    }
    if (value.details !== undefined && typeof value.details !== 'string') {
        return undefined;
    }

    return {
        code: value.code,
        message: value.message,
        retryable: value.retryable,
        timestamp: value.timestamp,
        ...(value.details === undefined ? {} : {details: value.details}),
    };
}

function parseFailedCompleteResult(result: Record<string, unknown>, errors: string[]) {
    const errorEnvelope = parseOcrErrorEnvelope(result.errorEnvelope);
    return {
        success: false as const,
        errors,
        ...(errorEnvelope === undefined ? {} : {errorEnvelope}),
    };
}

function parseWorkerCompleteResult(result: unknown) {
    if (!isRecord(result) || typeof result.success !== 'boolean') {
        return null;
    }
    const errors = result.errors;
    if (!isStringArray(errors)) {
        return null;
    }

    return result.success
        ? parseSuccessfulCompleteResult(result, errors)
        : parseFailedCompleteResult(result, errors);
}

function parseWorkerCompleteMessage(message: Record<string, unknown>): TOcrWorkerManagerMessage | null {
    if (typeof message.jobId !== 'string') {
        return null;
    }

    const result = parseWorkerCompleteResult(message.result);
    return result
        ? {
            type: 'complete',
            jobId: message.jobId,
            result,
        }
        : null;
}

function parseWorkerCleanupCompleteMessage(message: Record<string, unknown>): TOcrWorkerManagerMessage | null {
    return typeof message.jobId === 'string'
        ? {
            type: 'cleanup-complete',
            jobId: message.jobId,
        }
        : null;
}

export function parseWorkerMessage(message: unknown): TOcrWorkerManagerMessage | null {
    if (!isRecord(message) || typeof message.type !== 'string') {
        return null;
    }

    switch (message.type) {
        case 'log':
            return parseWorkerLogMessage(message);
        case 'progress':
            return parseWorkerProgressMessage(message);
        case 'complete':
            return parseWorkerCompleteMessage(message);
        case 'cleanup-complete':
            return parseWorkerCleanupCompleteMessage(message);
        default:
            return null;
    }
}
