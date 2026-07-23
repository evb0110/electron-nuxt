import { isDocumentRevisionInfo } from '@contracts/documentRevision';
import { isPdfValidationResult } from '@contracts/pdfConformance';
import type {
    IPdfNativeNoteTextSaveResult,
    IPdfNativeStagedCommitOptions,
    IPdfNativePagePreviewOptions,
    IPdfOptimizeResult,
    IPdfOptimizeOptions,
    IPdfSaveAsOptions,
    IPdfSerializedSaveOptions,
    TDocumentSaveResult,
} from '@contracts/electronApiDocuments';
import {
    decodeManagedTempFileHandle,
    isPdfOptimizePreset,
} from '@contracts/electronApiDocuments';
import { decodeTypedStagedArtifact } from '@contracts/stagedArtifacts';
import type {
    IPdfConformanceProfile,
    IPdfValidationResult,
} from '@contracts/pdfConformance';
import type { TIpcCodecMap } from '@contracts/ipcMain';
import {
    PDF_PERSISTENCE_DEFAULT_ACK_TIMEOUT_MS,
    PDF_PERSISTENCE_DEFAULT_CHUNK_BYTES,
    PDF_PERSISTENCE_DEFAULT_MAX_IN_FLIGHT_CHUNKS,
    PDF_PERSISTENCE_DEFAULT_RESULT_TIMEOUT_MS,
    SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION,
} from '@contracts/documentPersistenceFrames';
import type { ISerializedPdfPersistenceLimits } from '@contracts/documentPersistenceFrames';
import {
    isFiniteNumber,
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import type { TPlatformUnsupportedReason } from '@contracts/platformUnsupported';
import { decodeOpenFileResult } from '@contracts/documentsPlatformFeature';
import {
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import {
    decodeBoundedArray,
    decodeOptionalStringArg,
    decodePositiveIntegerArrayArg,
    decodeSafeIntegerArg,
    decodeStringArg,
    decodeStringArrayArg,
    decodeUint8ArrayArg,
} from '@electron/platform-ipc/ipcArgumentValidation';
import {
    decodeBooleanResult,
    decodeNullableStringResult,
    decodeStringResult,
    decodeUndefinedResult,
    decodeUint8ArrayResult,
    requireDecoded,
} from '@electron/platform-ipc/ipcCodecValidation';
import type {
    IBeginSerializedPdfPersistenceResult,
    IBeginSerializedPdfSaveAsResult,
} from '@electron/features/documents/serializedPdfPersistenceContract';

const PLATFORM_UNSUPPORTED_REASONS = [
    'unsupported-backend',
    'missing-browser-permission',
    'user-canceled',
    'not-implemented',
    'requires-native-backend',
] as const satisfies readonly TPlatformUnsupportedReason[];

const DOCUMENT_SAVE_FAILURE_REASONS = [
    'user-canceled',
    'validation-failed',
    'working-copy-missing',
    'write-failed',
    'refresh-failed',
    'working-copy-sync-required',
    'unsupported',
    'stale',
    'unknown',
] as const;

function decodeOptionalObject<T>(value: unknown, fieldName: string): T | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!isRecord(value)) {
        throw new Error(`${fieldName} must be an object`);
    }
    return value as T;
}

function decodeRequiredObject<T>(value: unknown, fieldName: string): T {
    const decoded = decodeOptionalObject<T>(value, fieldName);
    if (decoded === undefined) {
        throw new Error(`${fieldName} must be an object`);
    }
    return decoded;
}

function appendOptional<TBase extends unknown[], TValue>(
    base: TBase,
    value: TValue | undefined,
): TBase | [...TBase, TValue] {
    return value === undefined ? base : [
        ...base,
        value,
    ];
}

function decodePdfValidation(value: unknown): IPdfValidationResult {
    if (!isPdfValidationResult(value)) {
        throw new Error('invalid PDF validation result');
    }
    return {
        isValid: value.isValid,
        tool: value.tool,
        errors: [...value.errors],
        warnings: [...value.warnings],
    };
}

function decodeNullablePdfValidation(value: unknown): IPdfValidationResult | null {
    return value === null ? null : decodePdfValidation(value);
}

function decodePathValidationResult(value: unknown) {
    if (!isRecord(value) || (value.path !== null && typeof value.path !== 'string')) {
        throw new Error('invalid PDF persistence result');
    }
    return {
        path: value.path,
        validation: decodeNullablePdfValidation(value.validation),
    };
}

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
        || (value.protocolVersion !== undefined && value.protocolVersion !== SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION)
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
        ...(value.protocolVersion === undefined ? {} : {protocolVersion: SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION}),
        ...(maxChunkBytes === undefined ? {} : {maxChunkBytes}),
        ...(maxInFlightChunks === undefined ? {} : {maxInFlightChunks}),
        ...(maxTotalBytes === undefined ? {} : {maxTotalBytes}),
        ...(ackTimeoutMs === undefined ? {} : {ackTimeoutMs}),
        ...(resultTimeoutMs === undefined ? {} : {resultTimeoutMs}),
    };
}

function decodePlatformOperationResult(value: unknown) {
    if (
        !isRecord(value)
        || typeof value.success !== 'boolean'
        || (value.error !== undefined && typeof value.error !== 'string')
        || (value.unsupportedReason !== undefined && !isOneOf(PLATFORM_UNSUPPORTED_REASONS, value.unsupportedReason))
        || value.canceled !== undefined
    ) {
        throw new Error('invalid platform operation result');
    }
    return {
        success: value.success,
        ...(value.error === undefined ? {} : {error: value.error}),
        ...(value.unsupportedReason === undefined ? {} : {unsupportedReason: value.unsupportedReason}),
    };
}

function decodePrintResult(value: unknown) {
    if (
        !isRecord(value)
        || typeof value.success !== 'boolean'
        || (value.canceled !== undefined && typeof value.canceled !== 'boolean')
        || (value.error !== undefined && typeof value.error !== 'string')
        || (value.unsupportedReason !== undefined && !isOneOf(PLATFORM_UNSUPPORTED_REASONS, value.unsupportedReason))
    ) {
        throw new Error('invalid print result');
    }
    return {
        success: value.success,
        ...(value.canceled === undefined ? {} : {canceled: value.canceled}),
        ...(value.error === undefined ? {} : {error: value.error}),
        ...(value.unsupportedReason === undefined ? {} : {unsupportedReason: value.unsupportedReason}),
    };
}

function decodeDocumentSaveWarning(value: unknown): {
    reason: 'refresh-failed';
    message: string
} | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isRecord(value) || value.reason !== 'refresh-failed' || typeof value.message !== 'string') {
        throw new Error('invalid document save warning');
    }
    return {
        reason: 'refresh-failed',
        message: value.message,
    };
}

function decodeDocumentSaveResult(value: unknown): TDocumentSaveResult {
    if (!isRecord(value) || typeof value.ok !== 'boolean') {
        throw new Error('invalid document save result');
    }
    const validation = value.validation === undefined
        ? undefined
        : decodeNullablePdfValidation(value.validation);
    if (value.ok) {
        const warning = decodeDocumentSaveWarning(value.warning);
        if (
            typeof value.externalWriteCommitted !== 'boolean'
            || typeof value.workingCopyRefreshed !== 'boolean'
        ) {
            throw new Error('invalid document save success result');
        }
        return {
            ok: true,
            externalWriteCommitted: value.externalWriteCommitted,
            workingCopyRefreshed: value.workingCopyRefreshed,
            ...(validation === undefined ? {} : {validation}),
            ...(warning === undefined ? {} : {warning}),
        };
    }
    if (
        !isOneOf(DOCUMENT_SAVE_FAILURE_REASONS, value.reason)
        || (value.message !== undefined && typeof value.message !== 'string')
        || (value.externalWriteCommitted !== undefined && typeof value.externalWriteCommitted !== 'boolean')
        || (value.workingCopySyncRequired !== undefined && typeof value.workingCopySyncRequired !== 'boolean')
    ) {
        throw new Error('invalid document save failure result');
    }
    return {
        ok: false,
        reason: value.reason,
        ...(value.message === undefined ? {} : {message: value.message}),
        ...(value.externalWriteCommitted === undefined ? {} : {externalWriteCommitted: value.externalWriteCommitted}),
        ...(value.workingCopySyncRequired === undefined ? {} : {workingCopySyncRequired: value.workingCopySyncRequired}),
        ...(validation === undefined ? {} : {validation}),
    };
}

function decodeOptimizeResult(value: unknown): IPdfOptimizeResult {
    if (
        !isRecord(value)
        || (value.path !== null && typeof value.path !== 'string')
        || !isPdfOptimizePreset(value.preset)
    ) {
        throw new Error('invalid PDF optimize result');
    }
    const decodeNullableCount = (candidate: unknown, fieldName: string) => {
        if (candidate === null) {
            return null;
        }
        if (!Number.isSafeInteger(candidate) || typeof candidate !== 'number' || candidate < 0) {
            throw new Error(`${fieldName} must be a non-negative safe integer`);
        }
        return candidate;
    };
    return {
        path: value.path,
        validation: decodeNullablePdfValidation(value.validation),
        preset: value.preset,
        originalBytes: decodeNullableCount(value.originalBytes, 'originalBytes'),
        optimizedBytes: decodeNullableCount(value.optimizedBytes, 'optimizedBytes'),
        pageCount: decodeNullableCount(value.pageCount, 'pageCount'),
    };
}

function decodeNativeSaveResult(value: unknown): IPdfNativeNoteTextSaveResult {
    if (
        !isRecord(value)
        || typeof value.applied !== 'boolean'
        || (value.syncError !== undefined && typeof value.syncError !== 'string')
    ) {
        throw new Error('invalid native PDF save result');
    }
    const stagedOutput = value.stagedOutput === undefined
        ? undefined
        : decodeTypedStagedArtifact(value.stagedOutput);
    if (value.stagedOutput !== undefined && !stagedOutput) {
        throw new Error('invalid staged native PDF output');
    }
    return {
        applied: value.applied,
        validation: decodeNullablePdfValidation(value.validation),
        ...(value.syncError === undefined ? {} : {syncError: value.syncError}),
        ...(stagedOutput ? {stagedOutput} : {}),
    };
}

function decodeConformanceResult(value: unknown): IPdfConformanceProfile {
    if (
        !isRecord(value)
        || typeof value.isSigned !== 'boolean'
        || typeof value.isEncrypted !== 'boolean'
        || typeof value.isTagged !== 'boolean'
        || (value.pdfaLevel !== null && typeof value.pdfaLevel !== 'string')
        || typeof value.hasAcroForm !== 'boolean'
        || typeof value.hasXfa !== 'boolean'
        || typeof value.canIncrementalSave !== 'boolean'
        || !Array.isArray(value.saveRestrictions)
        || value.saveRestrictions.some(item => typeof item !== 'string')
    ) {
        throw new Error('invalid PDF conformance result');
    }
    return {
        isSigned: value.isSigned,
        isEncrypted: value.isEncrypted,
        isTagged: value.isTagged,
        pdfaLevel: value.pdfaLevel,
        hasAcroForm: value.hasAcroForm,
        hasXfa: value.hasXfa,
        canIncrementalSave: value.canIncrementalSave,
        saveRestrictions: value.saveRestrictions.map(String),
    };
}

function decodePageSizesResult(value: unknown) {
    if (!Array.isArray(value)) {
        throw new Error('invalid native page sizes result');
    }
    return value.map((item) => {
        if (!isRecord(item) || !isFiniteNumber(item.width) || !isFiniteNumber(item.height)) {
            throw new Error('invalid native page size');
        }
        return {
            width: item.width,
            height: item.height,
        };
    });
}

function decodeOpeningGeometryResult(value: unknown) {
    if (
        !isRecord(value)
        || value.pageNumber !== 1
        || typeof value.pageCount !== 'number'
        || !Number.isSafeInteger(value.pageCount)
        || value.pageCount < 1
        || !isFiniteNumber(value.width)
        || value.width <= 0
        || !isFiniteNumber(value.height)
        || value.height <= 0
        || ![
            0,
            90,
            180,
            270,
        ].includes(value.rotation as number)
        || typeof value.size !== 'number'
        || !Number.isSafeInteger(value.size)
        || value.size < 0
        || typeof value.modifiedAt !== 'number'
        || !Number.isSafeInteger(value.modifiedAt)
        || value.modifiedAt < 0
    ) {
        throw new Error('invalid PDF opening geometry result');
    }
    return {
        pageNumber: 1 as const,
        pageCount: value.pageCount,
        width: value.width,
        height: value.height,
        rotation: value.rotation as 0 | 90 | 180 | 270,
        size: value.size,
        modifiedAt: value.modifiedAt,
    };
}

function decodePagePreviewResult(value: unknown) {
    if (!isRecord(value) || !isFiniteNumber(value.width) || !isFiniteNumber(value.height)) {
        throw new Error('invalid native page preview result');
    }
    return {
        bytes: decodeUint8ArrayResult(value.bytes),
        width: value.width,
        height: value.height,
    };
}

function decodePreviewOptions(value: unknown): IPdfNativePagePreviewOptions | undefined {
    const decoded = decodeOptionalObject<IPdfNativePagePreviewOptions>(value, 'options');
    if (decoded === undefined) {
        return undefined;
    }
    if (
        decoded.previewRequestId !== undefined && typeof decoded.previewRequestId !== 'string'
        || decoded.targetWidthPx !== undefined && (!Number.isSafeInteger(decoded.targetWidthPx) || decoded.targetWidthPx < 1)
    ) {
        throw new Error('invalid native page preview options');
    }
    return {...decoded};
}

function decodeSaveAsOptions(value: unknown): IPdfSaveAsOptions | undefined {
    const decoded = decodeOptionalObject<IPdfSaveAsOptions>(value, 'saveAsOptions');
    if (decoded?.optimizeLossless !== undefined && typeof decoded.optimizeLossless !== 'boolean') {
        throw new Error('invalid PDF save-as options');
    }
    return decoded === undefined ? undefined : {...decoded};
}

function decodeRevisionOptions(value: unknown): IPdfSerializedSaveOptions | undefined {
    const decoded = decodeOptionalObject<IPdfSerializedSaveOptions>(value, 'revisionOptions');
    if (decoded !== undefined && typeof decoded.expectedDocumentRevisionToken !== 'string') {
        throw new Error('invalid document revision options');
    }
    if (decoded === undefined) {
        return undefined;
    }
    if (decoded.changedObjectRefs !== undefined && (
        !Array.isArray(decoded.changedObjectRefs)
        || decoded.changedObjectRefs.length > 128
        || !decoded.changedObjectRefs.every(ref => typeof ref === 'string' && PDF_OBJECT_REF_PATTERN.test(ref))
    )) {
        throw new Error('invalid changed PDF object references');
    }
    if (decoded.workingCopyOnly !== undefined && decoded.workingCopyOnly !== true) {
        throw new Error('invalid working-copy-only PDF staging option');
    }
    return {
        expectedDocumentRevisionToken: decoded.expectedDocumentRevisionToken,
        ...(decoded.changedObjectRefs?.length
            ? {changedObjectRefs: [...new Set(decoded.changedObjectRefs)]}
            : {}),
        ...(decoded.workingCopyOnly === true ? {workingCopyOnly: true as const} : {}),
    };
}

const PDF_OBJECT_REF_PATTERN = /^\d+\s+\d+\s+R$/;

function decodeNativeStagedCommitOptions(value: unknown): IPdfNativeStagedCommitOptions | undefined {
    return decodeRevisionOptions(value);
}

function decodeOptimizeOptions(value: unknown): IPdfOptimizeOptions {
    const decoded = decodeRequiredObject<IPdfOptimizeOptions>(value, 'optimizeOptions');
    if (!isPdfOptimizePreset(decoded.preset)) {
        throw new Error('invalid PDF optimize preset');
    }
    return {preset: decoded.preset};
}

function decodeOpenBatchArgs(args: readonly unknown[]): IDocumentsInvokeMap[typeof DOCUMENTS_CHANNELS.openDocumentDirectBatch]['args'] {
    const paths = decodeStringArrayArg(args, 0, 'paths');
    const requestId = decodeOptionalStringArg(args, 1, 'requestId');
    const rawOptions = args[2];
    let options: {forceCombine?: boolean} | undefined;
    if (rawOptions !== undefined) {
        const decoded = decodeRequiredObject<{forceCombine?: unknown}>(rawOptions, 'options');
        if (decoded.forceCombine !== undefined && typeof decoded.forceCombine !== 'boolean') {
            throw new Error('invalid force-combine option');
        }
        options = decoded.forceCombine === undefined ? {} : {forceCombine: decoded.forceCombine};
    }
    if (options !== undefined) {
        return [
            paths,
            requestId ?? '',
            options,
        ];
    }
    return requestId === undefined ? [paths] : [
        paths,
        requestId,
    ];
}

function decodeOptionalStringTail(args: readonly unknown[], first: string, index = 1): [string] | [string, string] {
    const optional = decodeOptionalStringArg(args, index, 'optionalPath');
    return optional === undefined ? [first] : [
        first,
        optional,
    ];
}

const decodeValidationResult = (value: unknown) => requireDecoded(value, candidate => isPdfValidationResult(candidate) ? decodePdfValidation(candidate) : null, 'PDF validation');

export const DOCUMENTS_IPC_CODECS = {
    [DOCUMENTS_CHANNELS.openDocumentDirect]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'path')],
        decodeResult: decodeOpenFileResult,
    },
    [DOCUMENTS_CHANNELS.openDocumentDirectBatch]: {
        decodeArgs: decodeOpenBatchArgs,
        decodeResult: decodeOpenFileResult,
    },
    [DOCUMENTS_CHANNELS.cancelOpenDocumentDirectBatch]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'requestId')],
        decodeResult: decodeBooleanResult,
    },
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
    [DOCUMENTS_CHANNELS.createWorkingCopyFromData]: {
        decodeArgs: (args: readonly unknown[]) => appendOptional(
            [
                decodeStringArg(args, 0, 'fileName'),
                decodeUint8ArrayArg(args, 1, 'data'),
            ],
            decodeOptionalStringArg(args, 2, 'originalPath'),
        ),
        decodeResult: decodeStringResult,
    },
    [DOCUMENTS_CHANNELS.createWorkingCopyFromPath]: {
        decodeArgs: (args: readonly unknown[]) => decodeOptionalStringTail(args, decodeStringArg(args, 0, 'sourcePath')),
        decodeResult: decodeStringResult,
    },
    [DOCUMENTS_CHANNELS.savePdfAs]: {
        decodeArgs: (args: readonly unknown[]) => appendOptional(
            [
                decodeStringArg(args, 0, 'workingPath'),
                decodeSaveAsOptions(args[1]),
            ],
            decodeRevisionOptions(args[2]),
        ),
        decodeResult: decodeNullableStringResult,
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
    [DOCUMENTS_CHANNELS.savePdfDialog]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'suggestedName')],
        decodeResult: decodeNullableStringResult,
    },
    [DOCUMENTS_CHANNELS.saveDocxAs]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'workingPath')],
        decodeResult: decodeNullableStringResult,
    },
    [DOCUMENTS_CHANNELS.fileRead]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'path')],
        decodeResult: decodeUint8ArrayResult,
    },
    [DOCUMENTS_CHANNELS.fileStat]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'path')],
        decodeResult: (value: unknown) => {
            if (!isRecord(value) || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0) throw new Error('invalid file stat');
            if (
                value.modifiedAt !== undefined
                && (
                    typeof value.modifiedAt !== 'number'
                    || !Number.isSafeInteger(value.modifiedAt)
                    || value.modifiedAt < 0
                )
            ) {
                throw new Error('invalid file modification time');
            }
            return {
                size: value.size,
                ...(value.modifiedAt === undefined ? {} : {modifiedAt: value.modifiedAt}),
            };
        },
    },
    [DOCUMENTS_CHANNELS.fileReadRange]: {
        decodeArgs: (args: readonly unknown[]) => [
            decodeStringArg(args, 0, 'path'),
            decodeSafeIntegerArg(args, 1, 'offset'),
            decodeSafeIntegerArg(args, 2, 'length'),
        ],
        decodeResult: decodeUint8ArrayResult,
    },
    [DOCUMENTS_CHANNELS.fileCreateManagedHandle]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'path')],
        decodeResult: (value: unknown) => {
            const decoded = decodeManagedTempFileHandle(value);
            if (decoded === null) throw new Error('invalid managed temporary file handle');
            return decoded;
        },
    },
    [DOCUMENTS_CHANNELS.fileReleaseManagedHandle]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'leaseId')],
        decodeResult: decodeBooleanResult,
    },
    [DOCUMENTS_CHANNELS.pdfOpeningGeometry]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'path')],
        decodeResult: decodeOpeningGeometryResult,
    },
    [DOCUMENTS_CHANNELS.pdfNativePageSizes]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'path')],
        decodeResult: decodePageSizesResult,
    },
    [DOCUMENTS_CHANNELS.pdfNativePagePreviewCancel]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'requestId')],
        decodeResult: (value: unknown) => {
            if (!isRecord(value) || typeof value.canceled !== 'boolean') throw new Error('invalid preview cancellation result');
            return {canceled: value.canceled};
        },
    },
    [DOCUMENTS_CHANNELS.pdfNativePagePreview]: {
        decodeArgs: (args: readonly unknown[]) => appendOptional(
            [
                decodeStringArg(args, 0, 'path'),
                decodeSafeIntegerArg(args, 1, 'pageNumber', 1),
            ],
            decodePreviewOptions(args[2]),
        ),
        decodeResult: decodePagePreviewResult,
    },
    [DOCUMENTS_CHANNELS.fileReadText]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'path')],
        decodeResult: decodeStringResult,
    },
    [DOCUMENTS_CHANNELS.fileExists]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'path')],
        decodeResult: decodeBooleanResult,
    },
    [DOCUMENTS_CHANNELS.documentRevisionGet]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'path')],
        decodeResult: (value: unknown) => requireDecoded(value, candidate => isDocumentRevisionInfo(candidate) ? candidate : null, 'document revision'),
    },
    [DOCUMENTS_CHANNELS.pdfAnalyzeConformance]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'path')],
        decodeResult: decodeConformanceResult,
    },
    [DOCUMENTS_CHANNELS.pdfValidateData]: {
        decodeArgs: (args: readonly unknown[]) => appendOptional([decodeUint8ArrayArg(args, 0, 'data')], decodeOptionalStringArg(args, 1, 'fileName')),
        decodeResult: decodeValidationResult,
    },
    [DOCUMENTS_CHANNELS.pdfValidatePath]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'path')],
        decodeResult: decodeValidationResult,
    },
    [DOCUMENTS_CHANNELS.pdfOpenInDefaultAppData]: {
        decodeArgs: (args: readonly unknown[]) => appendOptional([decodeUint8ArrayArg(args, 0, 'data')], decodeOptionalStringArg(args, 1, 'fileName')),
        decodeResult: decodePlatformOperationResult,
    },
    [DOCUMENTS_CHANNELS.pdfOpenInDefaultAppPath]: {
        decodeArgs: (args: readonly unknown[]) => decodeOptionalStringTail(args, decodeStringArg(args, 0, 'path')),
        decodeResult: decodePlatformOperationResult,
    },
    [DOCUMENTS_CHANNELS.pdfPrintData]: {
        decodeArgs: (args: readonly unknown[]) => appendOptional([decodeUint8ArrayArg(args, 0, 'data')], decodeOptionalStringArg(args, 1, 'fileName')),
        decodeResult: decodePrintResult,
    },
    [DOCUMENTS_CHANNELS.pdfPrintPath]: {
        decodeArgs: (args: readonly unknown[]) => {
            const path = decodeStringArg(args, 0, 'path');
            const fileName = decodeOptionalStringArg(args, 1, 'fileName');
            if (fileName === undefined) {
                return [path];
            }
            const pages = args[2] === undefined ? undefined : decodePositiveIntegerArrayArg(args, 2, 'pageNumbers');
            return pages === undefined ? [
                path,
                fileName,
            ] : [
                path,
                fileName,
                pages,
            ];
        },
        decodeResult: decodePrintResult,
    },
    [DOCUMENTS_CHANNELS.fileWrite]: {
        decodeArgs: (args: readonly unknown[]) => appendOptional([
            decodeStringArg(args, 0, 'path'),
            decodeUint8ArrayArg(args, 1, 'data'),
        ], decodeRevisionOptions(args[2])),
        decodeResult: decodeBooleanResult,
    },
    [DOCUMENTS_CHANNELS.fileReplaceWorkingCopyFromPath]: {
        decodeArgs: (args: readonly unknown[]) => appendOptional([
            decodeStringArg(args, 0, 'workingCopyPath'),
            decodeStringArg(args, 1, 'sourcePath'),
        ], decodeRevisionOptions(args[2])),
        decodeResult: decodeBooleanResult,
    },
    [DOCUMENTS_CHANNELS.fileWriteDocx]: {
        decodeArgs: (args: readonly unknown[]) => [
            decodeStringArg(args, 0, 'path'),
            decodeUint8ArrayArg(args, 1, 'data'),
        ],
        decodeResult: decodeBooleanResult,
    },
    [DOCUMENTS_CHANNELS.fileSaveStructured]: {
        decodeArgs: (args: readonly unknown[]) => appendOptional([decodeStringArg(args, 0, 'path')], decodeRevisionOptions(args[1])),
        decodeResult: decodeDocumentSaveResult,
    },
    [DOCUMENTS_CHANNELS.fileResyncWorkingCopy]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'path')],
        decodeResult: decodeDocumentSaveResult,
    },
    [DOCUMENTS_CHANNELS.fileRepairPdf]: {
        decodeArgs: (args: readonly unknown[]) => appendOptional([decodeStringArg(args, 0, 'path')], decodeRevisionOptions(args[1])),
        decodeResult: decodeValidationResult,
    },
    [DOCUMENTS_CHANNELS.fileOptimizePdfForInteraction]: {
        decodeArgs: (args: readonly unknown[]) => appendOptional([decodeStringArg(args, 0, 'path')], decodeRevisionOptions(args[1])),
        decodeResult: decodeValidationResult,
    },
    [DOCUMENTS_CHANNELS.fileOptimizePdfAsCopy]: {
        decodeArgs: (args: readonly unknown[]) => {
            const base: [string, IPdfOptimizeOptions] = [
                decodeStringArg(args, 0, 'path'),
                decodeOptimizeOptions(args[1]),
            ];
            const requestId = decodeOptionalStringArg(args, 2, 'requestId');
            if (requestId === undefined) {
                return base;
            }
            return appendOptional([
                ...base,
                requestId,
            ], decodeRevisionOptions(args[3]));
        },
        decodeResult: decodeOptimizeResult,
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
    [DOCUMENTS_CHANNELS.fileSavePdfNoteTextUpdates]: {
        decodeArgs: (args: readonly unknown[]) => appendOptional([
            decodeStringArg(args, 0, 'path'),
            decodeRequiredObject<IDocumentsInvokeMap[typeof DOCUMENTS_CHANNELS.fileSavePdfNoteTextUpdates]['args'][1]>(args[1], 'updates'),
            decodeStringArg(args, 2, 'modifiedAt'),
        ], decodeRevisionOptions(args[3])),
        decodeResult: decodeNativeSaveResult,
    },
    [DOCUMENTS_CHANNELS.fileSavePdfNoteChanges]: {
        decodeArgs: (args: readonly unknown[]) => appendOptional([
            decodeStringArg(args, 0, 'path'),
            decodeRequiredObject<IDocumentsInvokeMap[typeof DOCUMENTS_CHANNELS.fileSavePdfNoteChanges]['args'][1]>(args[1], 'changes'),
            decodeStringArg(args, 2, 'modifiedAt'),
        ], decodeRevisionOptions(args[3])),
        decodeResult: decodeNativeSaveResult,
    },
    [DOCUMENTS_CHANNELS.fileSavePdfNativeMutations]: {
        decodeArgs: (args: readonly unknown[]) => appendOptional([
            decodeStringArg(args, 0, 'path'),
            decodeRequiredObject<IDocumentsInvokeMap[typeof DOCUMENTS_CHANNELS.fileSavePdfNativeMutations]['args'][1]>(args[1], 'mutations'),
            decodeStringArg(args, 2, 'modifiedAt'),
        ], decodeRevisionOptions(args[3])),
        decodeResult: decodeNativeSaveResult,
    },
    [DOCUMENTS_CHANNELS.fileApplyPdfNativeMutationsToWorkingCopy]: {
        decodeArgs: (args: readonly unknown[]) => appendOptional([
            decodeStringArg(args, 0, 'path'),
            decodeRequiredObject<IDocumentsInvokeMap[typeof DOCUMENTS_CHANNELS.fileApplyPdfNativeMutationsToWorkingCopy]['args'][1]>(args[1], 'mutations'),
            decodeStringArg(args, 2, 'modifiedAt'),
            decodeRequiredObject<IDocumentsInvokeMap[typeof DOCUMENTS_CHANNELS.fileApplyPdfNativeMutationsToWorkingCopy]['args'][3]>(args[3], 'expectedBase'),
        ], decodeRevisionOptions(args[4])),
        decodeResult: decodeNativeSaveResult,
    },
    [DOCUMENTS_CHANNELS.fileCommitStagedPdfNativeMutations]: {
        decodeArgs: (args: readonly unknown[]) => {
            const stagedOutput = decodeTypedStagedArtifact(args[1]);
            if (!stagedOutput) throw new Error('stagedOutput must be a typed staged artifact');
            return appendOptional([
                decodeStringArg(args, 0, 'path'),
                stagedOutput,
            ], decodeNativeStagedCommitOptions(args[2]));
        },
        decodeResult: decodeNativeSaveResult,
    },
    [DOCUMENTS_CHANNELS.fileCleanup]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'path')],
        decodeResult: decodeUndefinedResult,
    },
    [DOCUMENTS_CHANNELS.fileCleanupOcrTemp]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'path')],
        decodeResult: decodeBooleanResult,
    },
} satisfies TIpcCodecMap<IDocumentsInvokeMap>;
