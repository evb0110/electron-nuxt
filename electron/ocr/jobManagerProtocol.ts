import type { TOcrWorkerOutboundMessage } from '@electron/ocr/worker/types';
import type { TOcrProgressPhase } from '@contracts/electronApiOcr';
import {
    createAbortError,
    isAbortError,
} from '@electron/utils/abort';
import { isRecord } from '@contracts/runtimeGuards';

export {
    createAbortError,
    isAbortError,
};

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

const OCR_PROGRESS_PHASES = new Set<TOcrProgressPhase>([
    'preparing',
    'model-prep',
    'pdf-prep',
    'dpi-inspection',
    'page-size-probing',
    'processing',
    'merging',
    'indexing',
]);

function parseOptionalProgressPhase(value: unknown) {
    return typeof value === 'string' && OCR_PROGRESS_PHASES.has(value as TOcrProgressPhase)
        ? value as TOcrProgressPhase
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

function parseFailedCompleteResult(errors: string[]) {
    return {
        success: false as const,
        errors,
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
        : parseFailedCompleteResult(errors);
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
