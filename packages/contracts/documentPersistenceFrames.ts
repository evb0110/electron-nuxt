import type { IPdfValidationResult } from '@contracts/pdfConformance';
import { getErrorMessage } from '@contracts/getErrorMessage';
import { isRecord } from '@contracts/runtimeGuards';

export const SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION = 1;
export const PDF_PERSISTENCE_DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
export const PDF_PERSISTENCE_DEFAULT_MAX_IN_FLIGHT_CHUNKS = 2;
export const PDF_PERSISTENCE_DEFAULT_ACK_TIMEOUT_MS = 60_000;
export const PDF_PERSISTENCE_DEFAULT_RESULT_TIMEOUT_MS = 10 * 60_000;
export const PDF_PERSISTENCE_MESSAGE_UNWRAP_DEPTH = 64;

export const PDF_PERSISTENCE_ERROR_CODES = [
    'CANCELED',
    'PROTOCOL_ERROR',
    'ACK_TIMEOUT',
    'COMMIT_FAILED',
    'WORKING_COPY_SYNC_WARNING',
    'UNKNOWN',
] as const;

export type TPdfPersistenceErrorCode = typeof PDF_PERSISTENCE_ERROR_CODES[number];

export const PDF_PERSISTENCE_ERROR_PHASES = [
    'streaming',
    'ack',
    'complete',
    'commit',
    'cancel',
] as const;

export type TPdfPersistenceErrorPhase = typeof PDF_PERSISTENCE_ERROR_PHASES[number];

export interface ISerializedPdfPersistenceLimits {
    protocolVersion: typeof SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION;
    maxChunkBytes: number;
    maxInFlightChunks: number;
    maxTotalBytes: number;
    ackTimeoutMs: number;
    resultTimeoutMs: number;
}

export interface IPdfPersistenceErrorFrame {
    type: 'error';
    code: TPdfPersistenceErrorCode;
    phase: TPdfPersistenceErrorPhase;
    retryable: boolean;
    expected: boolean;
    error: string;
    seq?: number;
}

export interface IPdfPersistenceResultFrame {
    type: 'result';
    path: string | null;
    validation: IPdfValidationResult;
}

export interface IPdfPersistenceReadyFrame { type: 'ready'; }

export interface IPdfPersistenceAckFrame {
    type: 'ack';
    seq: number;
    receivedBytes?: number;
}

export type TPdfPersistenceMainToPreloadFrame =
    | IPdfPersistenceResultFrame
    | IPdfPersistenceErrorFrame
    | IPdfPersistenceReadyFrame
    | IPdfPersistenceAckFrame;

export interface IPdfPersistenceChunkFrame {
    type: 'chunk';
    seq: number;
    bytes: Uint8Array;
}

export interface IPdfPersistenceCompleteFrame { type: 'complete'; }

export interface IPdfPersistenceCancelFrame { type: 'cancel'; }

export type TPdfPersistencePreloadToMainFrame =
    | IPdfPersistenceChunkFrame
    | IPdfPersistenceCompleteFrame
    | IPdfPersistenceCancelFrame;

export interface IPdfPersistencePreloadToMainPayload {
    type: TPdfPersistencePreloadToMainFrame['type'];
    seq?: number;
    bytes?: Uint8Array | ArrayBuffer;
}

const PDF_PERSISTENCE_ERROR_CODE_SET = new Set<string>(PDF_PERSISTENCE_ERROR_CODES);
const PDF_PERSISTENCE_ERROR_PHASE_SET = new Set<string>(PDF_PERSISTENCE_ERROR_PHASES);

export function createPdfPersistenceReadyFrame(): IPdfPersistenceReadyFrame {
    return {type: 'ready'};
}

export function createPdfPersistenceAckFrame(seq: number, receivedBytes: number): IPdfPersistenceAckFrame {
    return {
        type: 'ack',
        seq,
        receivedBytes,
    };
}

export function createPdfPersistenceResultFrame(
    path: string | null,
    validation: IPdfValidationResult,
): IPdfPersistenceResultFrame {
    return {
        type: 'result',
        path,
        validation,
    };
}

export function createPdfPersistenceChunkFrame(seq: number, bytes: Uint8Array): IPdfPersistenceChunkFrame {
    return {
        type: 'chunk',
        seq,
        bytes,
    };
}

export function createPdfPersistenceCompleteFrame(): IPdfPersistenceCompleteFrame {
    return {type: 'complete'};
}

export function createPdfPersistenceCancelFrame(): IPdfPersistenceCancelFrame {
    return {type: 'cancel'};
}

export function createPdfPersistenceErrorFrame(
    error: unknown,
    options: {
        phase: TPdfPersistenceErrorPhase;
        expected?: boolean;
        seq?: number;
    },
): IPdfPersistenceErrorFrame {
    const message = getErrorMessage(error);
    const code = options.phase === 'cancel'
        ? 'CANCELED'
        : options.phase === 'commit' || options.phase === 'complete'
            ? 'COMMIT_FAILED'
            : 'PROTOCOL_ERROR';
    return {
        type: 'error',
        code,
        phase: options.phase,
        retryable: false,
        expected: options.expected ?? false,
        error: message,
        ...(options.seq === undefined ? {} : {seq: options.seq}),
    };
}

export function getPdfPersistenceErrorMessage(payload: Pick<IPdfPersistenceErrorFrame, 'error'> | { error?: string }) {
    return typeof payload.error === 'string' ? payload.error : 'PDF persistence failed';
}

export function isPdfValidationResult(value: unknown): value is IPdfValidationResult {
    return isRecord(value)
        && typeof value.isValid === 'boolean'
        && (value.tool === 'qpdf' || value.tool === 'browser' || value.tool === 'native')
        && Array.isArray(value.errors)
        && value.errors.every(error => typeof error === 'string')
        && Array.isArray(value.warnings)
        && value.warnings.every(warning => typeof warning === 'string');
}

export function isSerializedPdfPersistenceLimits(value: unknown): value is ISerializedPdfPersistenceLimits {
    return isRecord(value)
        && value.protocolVersion === SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION
        && typeof value.maxChunkBytes === 'number'
        && Number.isSafeInteger(value.maxChunkBytes)
        && value.maxChunkBytes > 0
        && typeof value.maxInFlightChunks === 'number'
        && Number.isSafeInteger(value.maxInFlightChunks)
        && value.maxInFlightChunks > 0
        && typeof value.maxTotalBytes === 'number'
        && Number.isSafeInteger(value.maxTotalBytes)
        && value.maxTotalBytes > 0
        && typeof value.ackTimeoutMs === 'number'
        && Number.isSafeInteger(value.ackTimeoutMs)
        && value.ackTimeoutMs > 0
        && typeof value.resultTimeoutMs === 'number'
        && Number.isSafeInteger(value.resultTimeoutMs)
        && value.resultTimeoutMs > 0;
}

export function parsePdfPersistenceMainToPreloadFrame(value: unknown): TPdfPersistenceMainToPreloadFrame | null {
    if (!isRecord(value) || typeof value.type !== 'string') {
        return null;
    }
    if (value.type === 'result' && isPdfValidationResult(value.validation)) {
        return createPdfPersistenceResultFrame(
            typeof value.path === 'string' ? value.path : null,
            value.validation,
        );
    }
    if (value.type === 'error') {
        const error = typeof value.error === 'string'
            ? value.error
            : getPdfPersistenceErrorMessage({});
        return {
            type: 'error',
            code: typeof value.code === 'string' && PDF_PERSISTENCE_ERROR_CODE_SET.has(value.code)
                ? value.code as TPdfPersistenceErrorCode
                : 'UNKNOWN',
            phase: typeof value.phase === 'string' && PDF_PERSISTENCE_ERROR_PHASE_SET.has(value.phase)
                ? value.phase as TPdfPersistenceErrorPhase
                : 'streaming',
            retryable: typeof value.retryable === 'boolean' ? value.retryable : false,
            expected: typeof value.expected === 'boolean' ? value.expected : false,
            error,
            ...(typeof value.seq === 'number' && Number.isSafeInteger(value.seq) ? {seq: value.seq} : {}),
        };
    }
    if (value.type === 'ready') {
        return createPdfPersistenceReadyFrame();
    }
    if (value.type === 'ack' && typeof value.seq === 'number' && Number.isSafeInteger(value.seq)) {
        return {
            type: 'ack',
            seq: value.seq,
            ...(typeof value.receivedBytes === 'number' && Number.isSafeInteger(value.receivedBytes)
                ? {receivedBytes: value.receivedBytes}
                : {}),
        };
    }
    return null;
}

export function getPdfPersistenceChunkBytes(value: unknown) {
    if (value instanceof Uint8Array) {
        return value;
    }
    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
    }

    throw new Error('Invalid PDF persistence chunk');
}

export function describePdfPersistenceMessage(message: unknown) {
    if (!message || typeof message !== 'object') {
        return typeof message;
    }

    return `keys=${Object.keys(message).join(',')}`;
}

export function isPdfPersistencePreloadToMainPayload(message: unknown): message is IPdfPersistencePreloadToMainPayload {
    if (!isRecord(message) || typeof message.type !== 'string') {
        return false;
    }

    if (message.type === 'chunk') {
        return typeof message.seq === 'number'
            && Number.isSafeInteger(message.seq)
            && (message.bytes instanceof Uint8Array || message.bytes instanceof ArrayBuffer);
    }

    return message.type === 'complete' || message.type === 'cancel';
}

export function normalizePdfPersistencePreloadToMainPayload(
    message: unknown,
    maxDepth = PDF_PERSISTENCE_MESSAGE_UNWRAP_DEPTH,
) {
    let currentMessage = message;
    const seenMessages = new WeakSet<object>();
    for (let depth = 0; depth < maxDepth; depth += 1) {
        if (isPdfPersistencePreloadToMainPayload(currentMessage)) {
            return currentMessage;
        }
        if (!currentMessage || typeof currentMessage !== 'object' || !('data' in currentMessage)) {
            return currentMessage;
        }
        if (seenMessages.has(currentMessage)) {
            return currentMessage;
        }
        seenMessages.add(currentMessage);

        const nextMessage = currentMessage.data;
        if (nextMessage == null || nextMessage === currentMessage) {
            return currentMessage;
        }
        currentMessage = nextMessage;
    }

    return currentMessage;
}
