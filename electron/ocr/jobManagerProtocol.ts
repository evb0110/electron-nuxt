import type { TOcrWorkerOutboundMessage } from '@electron/ocr/worker/types';
import {
    createAbortError,
    isAbortError,
} from '@electron/utils/abort';

export {
    createAbortError,
    isAbortError,
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
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

function parseWorkerLogMessage(message: Record<string, unknown>): TOcrWorkerOutboundMessage | null {
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

function parseWorkerProgressMessage(message: Record<string, unknown>): TOcrWorkerOutboundMessage | null {
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

    return {
        type: 'progress',
        jobId: message.jobId,
        progress: {
            requestId: progress.requestId,
            currentPage: progress.currentPage,
            processedCount: progress.processedCount,
            totalPages: progress.totalPages,
        },
    };
}

function parseSuccessfulCompleteResult(result: Record<string, unknown>) {
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
        errors: result.errors as string[],
    };
}

function parseFailedCompleteResult(result: Record<string, unknown>) {
    return {
        success: false as const,
        errors: result.errors as string[],
    };
}

function parseWorkerCompleteResult(result: unknown) {
    if (!isRecord(result) || typeof result.success !== 'boolean' || !isStringArray(result.errors)) {
        return null;
    }

    return result.success
        ? parseSuccessfulCompleteResult(result)
        : parseFailedCompleteResult(result);
}

function parseWorkerCompleteMessage(message: Record<string, unknown>): TOcrWorkerOutboundMessage | null {
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

export function parseWorkerMessage(message: unknown): TOcrWorkerOutboundMessage | null {
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
        default:
            return null;
    }
}
