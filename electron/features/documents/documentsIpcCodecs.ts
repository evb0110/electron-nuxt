import { decodeTypedStagedArtifact } from '@contracts/stagedArtifacts';
import {
    PDF_PERSISTENCE_DEFAULT_ACK_TIMEOUT_MS,
    PDF_PERSISTENCE_DEFAULT_CHUNK_BYTES,
    PDF_PERSISTENCE_DEFAULT_MAX_IN_FLIGHT_CHUNKS,
    PDF_PERSISTENCE_DEFAULT_RESULT_TIMEOUT_MS,
    SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION,
    type ISerializedPdfPersistenceLimits,
} from '@contracts/documentPersistenceFrames';
import { isPdfValidationResult } from '@contracts/pdfConformance';
import {
    appendOptionalDocumentArg as appendOptional,
    decodePdfPathValidationResult as decodePathValidationResult,
    decodePdfRevisionOptions as decodeRevisionOptions,
    decodePdfSaveAsOptions as decodeSaveAsOptions,
    decodePdfValidation,
    decodeRequiredDocumentObject as decodeRequiredObject,
} from '@contracts/documentsPersistenceSchemas';
import {
    DOCUMENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_OPEN_PLATFORM_FEATURE,
    DOCUMENT_PDF_PLATFORM_FEATURE,
    DOCUMENT_WORKING_COPY_PLATFORM_FEATURE,
} from '@contracts/documentsPlatformFeature';
import type { TIpcCodecMap } from '@contracts/ipcMain';
import { isRecord } from '@contracts/runtimeGuards';
import {
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import type {
    IBeginSerializedPdfPersistenceResult,
    IBeginSerializedPdfSaveAsResult,
} from '@electron/features/documents/serializedPdfPersistenceContract';
import {
    decodeBoundedArray,
    decodeSafeIntegerArg,
    decodeStringArg,
    decodeStringArrayArg,
    decodeUint8ArrayArg,
} from '@electron/platform-ipc/ipcArgumentValidation';
import {
    decodeBooleanResult,
    requireDecoded,
} from '@electron/platform-ipc/ipcCodecValidation';

function decodeCommittedPathValidationResult(value: unknown) {
    if (!isRecord(value) || (value.path !== null && typeof value.path !== 'string')) {
        throw new Error('invalid committed PDF persistence result');
    }
    return {
        path: value.path,
        validation: decodePdfValidation(value.validation),
    };
}

function decodePositiveSafeInteger(value: unknown, fieldName: string): number {
    if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 1) {
        throw new Error(`${fieldName} must be a positive safe integer`);
    }
    return value;
}

function decodePersistenceLimits(value: Record<PropertyKey, unknown>): ISerializedPdfPersistenceLimits {
    if (value.protocolVersion !== SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION) {
        throw new Error('invalid PDF persistence protocol version');
    }
    return {
        protocolVersion: SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION,
        maxChunkBytes: decodePositiveSafeInteger(value.maxChunkBytes, 'maxChunkBytes'),
        maxInFlightChunks: decodePositiveSafeInteger(value.maxInFlightChunks, 'maxInFlightChunks'),
        maxTotalBytes: decodePositiveSafeInteger(value.maxTotalBytes, 'maxTotalBytes'),
        ackTimeoutMs: decodePositiveSafeInteger(value.ackTimeoutMs, 'ackTimeoutMs'),
        resultTimeoutMs: decodePositiveSafeInteger(value.resultTimeoutMs, 'resultTimeoutMs'),
    };
}

function decodePersistenceBeginResult(value: unknown): IBeginSerializedPdfPersistenceResult {
    if (!isRecord(value) || typeof value.sessionId !== 'string') {
        throw new Error('invalid serialized persistence begin result');
    }
    if (value.protocolVersion === undefined) {
        return {
            sessionId: value.sessionId,
            protocolVersion: SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION,
            maxChunkBytes: PDF_PERSISTENCE_DEFAULT_CHUNK_BYTES,
            maxInFlightChunks: PDF_PERSISTENCE_DEFAULT_MAX_IN_FLIGHT_CHUNKS,
            maxTotalBytes: Number.MAX_SAFE_INTEGER,
            ackTimeoutMs: PDF_PERSISTENCE_DEFAULT_ACK_TIMEOUT_MS,
            resultTimeoutMs: PDF_PERSISTENCE_DEFAULT_RESULT_TIMEOUT_MS,
        };
    }
    return {
        sessionId: value.sessionId,
        ...decodePersistenceLimits(value),
    };
}

function decodeOptionalPositiveSafeInteger(value: unknown, fieldName: string): number | undefined {
    return value === undefined ? undefined : decodePositiveSafeInteger(value, fieldName);
}

function decodeSaveAsBeginResult(value: unknown): IBeginSerializedPdfSaveAsResult {
    if (
        !isRecord(value)
        || (value.sessionId !== null && typeof value.sessionId !== 'string')
        || (value.path !== null && typeof value.path !== 'string')
        || (
            value.protocolVersion !== undefined
            && value.protocolVersion !== SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION
        )
    ) {
        throw new Error('invalid serialized save-as begin result');
    }
    const maxChunkBytes = decodeOptionalPositiveSafeInteger(value.maxChunkBytes, 'maxChunkBytes');
    const maxInFlightChunks = decodeOptionalPositiveSafeInteger(value.maxInFlightChunks, 'maxInFlightChunks');
    const maxTotalBytes = decodeOptionalPositiveSafeInteger(value.maxTotalBytes, 'maxTotalBytes');
    const ackTimeoutMs = decodeOptionalPositiveSafeInteger(value.ackTimeoutMs, 'ackTimeoutMs');
    const resultTimeoutMs = decodeOptionalPositiveSafeInteger(value.resultTimeoutMs, 'resultTimeoutMs');
    return {
        sessionId: value.sessionId,
        path: value.path,
        ...(value.protocolVersion === undefined
            ? {}
            : {protocolVersion: SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION}),
        ...(maxChunkBytes === undefined ? {} : {maxChunkBytes}),
        ...(maxInFlightChunks === undefined ? {} : {maxInFlightChunks}),
        ...(maxTotalBytes === undefined ? {} : {maxTotalBytes}),
        ...(ackTimeoutMs === undefined ? {} : {ackTimeoutMs}),
        ...(resultTimeoutMs === undefined ? {} : {resultTimeoutMs}),
    };
}

const decodeValidationResult = (value: unknown) => requireDecoded(
    value,
    candidate => isPdfValidationResult(candidate) ? decodePdfValidation(candidate) : null,
    'PDF validation',
);

export const DOCUMENTS_IPC_CODECS = {
    ...DOCUMENT_OPEN_PLATFORM_FEATURE.ipcCodecs,
    ...DOCUMENT_WORKING_COPY_PLATFORM_FEATURE.ipcCodecs,
    ...DOCUMENT_FILES_PLATFORM_FEATURE.ipcCodecs,
    ...DOCUMENT_PDF_PLATFORM_FEATURE.ipcCodecs,
    [DOCUMENTS_CHANNELS.registerRendererFileOpenToken]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'token')],
        decodeResult: decodeBooleanResult,
    },
    [DOCUMENTS_CHANNELS.registerRendererFileOpenTokens]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArrayArg(args, 0, 'tokens')],
        decodeResult: decodeBooleanResult,
    },
    [DOCUMENTS_CHANNELS.allowRendererFileOpen]: {
        decodeArgs: (args: readonly unknown[]) => [decodeRequiredObject<{
            filePath: string;
            token: string
        }>(args[0], 'request')],
        decodeResult: decodeBooleanResult,
    },
    [DOCUMENTS_CHANNELS.allowRendererFileOpenBatch]: {
        decodeArgs: (args: readonly unknown[]) => {
            const requests = decodeBoundedArray(args[0], 'requests', {
                allowEmpty: true,
                maxItems: 4_096,
            });
            return [requests.map(item => decodeRequiredObject<{
                filePath: string;
                token: string
            }>(item, 'request'))];
        },
        decodeResult: decodeBooleanResult,
    },
    [DOCUMENTS_CHANNELS.savePdfDataAs]: {
        decodeArgs: (args: readonly unknown[]) => {
            const base: [string, Uint8Array] = [
                decodeStringArg(args, 0, 'workingPath'),
                decodeUint8ArrayArg(args, 1, 'data'),
            ];
            const options = decodeSaveAsOptions(args[2]);
            if (options === undefined) {
                return base;
            }
            return appendOptional([
                ...base,
                options,
            ], decodeRevisionOptions(args[3]));
        },
        decodeResult: decodePathValidationResult,
    },
    [DOCUMENTS_CHANNELS.savePdfDataAsBegin]: {
        decodeArgs: (args: readonly unknown[]) => {
            const base: [string, number] = [
                decodeStringArg(args, 0, 'workingPath'),
                decodeSafeIntegerArg(args, 1, 'totalBytes'),
            ];
            const options = decodeSaveAsOptions(args[2]);
            if (options === undefined) {
                return base;
            }
            return appendOptional([
                ...base,
                options,
            ], decodeRevisionOptions(args[3]));
        },
        decodeResult: decodeSaveAsBeginResult,
    },
    [DOCUMENTS_CHANNELS.fileSavePdfData]: {
        decodeArgs: (args: readonly unknown[]) => appendOptional([
            decodeStringArg(args, 0, 'path'),
            decodeUint8ArrayArg(args, 1, 'data'),
        ], decodeRevisionOptions(args[2])),
        decodeResult: decodeValidationResult,
    },
    [DOCUMENTS_CHANNELS.fileSavePdfDataBegin]: {
        decodeArgs: (args: readonly unknown[]) => appendOptional([
            decodeStringArg(args, 0, 'path'),
            decodeSafeIntegerArg(args, 1, 'totalBytes'),
        ], decodeRevisionOptions(args[2])),
        decodeResult: decodePersistenceBeginResult,
    },
    [DOCUMENTS_CHANNELS.fileCommitStagedSerializedPdf]: {
        decodeArgs: (args: readonly unknown[]) => {
            const stagedOutput = decodeTypedStagedArtifact(args[1]);
            if (!stagedOutput) throw new Error('stagedOutput must be a typed staged artifact');
            return [
                decodeStringArg(args, 0, 'sessionId'),
                stagedOutput,
            ];
        },
        decodeResult: decodeCommittedPathValidationResult,
    },
    [DOCUMENTS_CHANNELS.fileCancelStagedSerializedPdf]: {
        decodeArgs: (args: readonly unknown[]) => {
            const stagedOutput = decodeTypedStagedArtifact(args[1]);
            if (!stagedOutput) throw new Error('stagedOutput must be a typed staged artifact');
            return [
                decodeStringArg(args, 0, 'sessionId'),
                stagedOutput,
            ];
        },
        decodeResult: decodeBooleanResult,
    },
} satisfies TIpcCodecMap<IDocumentsInvokeMap>;
