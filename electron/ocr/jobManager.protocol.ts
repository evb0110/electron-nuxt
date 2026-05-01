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

export function parseWorkerMessage(message: unknown): TOcrWorkerOutboundMessage | null {
    if (!isRecord(message) || typeof message.type !== 'string') {
        return null;
    }

    switch (message.type) {
        case 'log':
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
        case 'progress':
            if (!isRecord(message.progress)) {
                return null;
            }
            if (
                typeof message.jobId === 'string'
                && typeof message.progress.requestId === 'string'
                && typeof message.progress.currentPage === 'number'
                && Number.isFinite(message.progress.currentPage)
                && typeof message.progress.processedCount === 'number'
                && Number.isFinite(message.progress.processedCount)
                && typeof message.progress.totalPages === 'number'
                && Number.isFinite(message.progress.totalPages)
            ) {
                return {
                    type: 'progress',
                    jobId: message.jobId,
                    progress: {
                        requestId: message.progress.requestId,
                        currentPage: message.progress.currentPage,
                        processedCount: message.progress.processedCount,
                        totalPages: message.progress.totalPages,
                    },
                };
            }
            return null;
        case 'complete':
            if (!isRecord(message.result)) {
                return null;
            }
            if (typeof message.jobId !== 'string' || typeof message.result.success !== 'boolean' || !isStringArray(message.result.errors)) {
                return null;
            }

            if (message.result.success) {
                const normalizedPdfPath = typeof message.result.pdfPath === 'string'
                    ? message.result.pdfPath.trim()
                    : '';
                if (normalizedPdfPath.length === 0) {
                    return null;
                }
                if (typeof message.result.requiresCleanupAck !== 'boolean') {
                    return null;
                }
                return {
                    type: 'complete',
                    jobId: message.jobId,
                    result: {
                        success: true,
                        pdfPath: normalizedPdfPath,
                        requiresCleanupAck: message.result.requiresCleanupAck,
                        errors: message.result.errors,
                    },
                };
            }

            return {
                type: 'complete',
                jobId: message.jobId,
                result: {
                    success: false,
                    errors: message.result.errors,
                },
            };
        default:
            return null;
    }
}
