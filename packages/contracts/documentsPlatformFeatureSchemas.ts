/* eslint-disable max-lines -- The document platform codec registry keeps its validated method map together. */

import {
    decodeManagedTempFileHandle,
    decodeOpenBatchProgress,
    decodeOptimizeProgress,
    isPdfOptimizePreset,
    type IApplicationMenuDocumentState,
    type IDocumentsFileCapability,
    type IPdfNativePagePreviewOptions,
    type IPdfNativeSaveResult,
    type IPdfOptimizeOptions,
    type IPdfOptimizeResult,
    type TDocumentSaveResult,
    type TOpenFolderDialogResult,
    type TShowItemInFolderResult,
} from '@contracts/electronApiDocuments';
import {
    decodeDocumentRevisionChangedEvent,
    isDocumentRevisionInfo,
    requireDocumentRevisionToken,
    type IDocumentRevisionChangedEvent,
} from '@contracts/documentRevision';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    appendOptionalDocumentArg as appendOptional,
    decodeNullablePdfValidation,
    decodeOptionalDocumentObject as decodeOptionalDocumentObjectRaw,
    decodePdfPathValidationResult as decodePathValidationResult,
    decodePdfNativeStagedCommitOptions,
    decodePdfRevisionOptions as decodeRevisionOptions,
    decodePdfSaveAsOptions as decodeSaveAsOptions,
    decodePdfValidation,
    decodeRequiredDocumentObject,
} from '@contracts/documentsPersistenceSchemas';
import {
    decodeOpeningGeometry,
    decodePagePreviewResult,
    decodePageSizesResult,
    decodeSafeIntegerValue,
    decodeUint8ArrayValue,
    fail,
} from '@contracts/documentsPlatformFeatureNativePageSchemas';
import {
    isPdfDecryptPassword,
    PDF_DECRYPT_PASSWORD_MAX_BYTES,
} from '@contracts/pdfDecryptSchemas';
import {
    decodeOpenFileResult,
    openFileResult,
} from '@contracts/pdfOpenFileSchemas';
import type {
    IPdfConformanceAnalysisOptions,
    IPdfConformanceProfile,
    IPdfValidationResult,
} from '@contracts/pdfConformance';
import type { TPlatformUnsupportedReason } from '@contracts/platformUnsupported';
import {
    decodePdfDataPrintOptions,
    decodePdfPathPrintOptions,
} from '@contracts/pdfPathPrintOptions';
import {runtimeSchema as s} from '@contracts/platformFeature';
import {
    isFiniteNumber,
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import {
    parseLeaseId,
    parseRequestId,
    type IRecentFile,
    type TLeaseId,
    type TRequestId,
} from '@contracts/shared';
import {
    parseEpochMs,
    requireEpochMs,
} from '@contracts/timestamps';
import {decodeTypedStagedArtifact} from '@contracts/stagedArtifacts';
import {isNativeErrorEnvelope} from '@contracts/nativeErrors';
import {
    normalizePdfNativeAnnotationIdentityBindings,
    normalizePdfNativeModifiedAt,
    normalizePdfNativeMutationSet,
} from '@contracts/nativePdfMutations';
const fixtureNativeMutation = {pageLabels: {
    totalPages: 1,
    ranges: [],
}};
function decodeRecentFile(value: unknown): IRecentFile {
    if (!isRecord(value)) {
        fail('invalid recent file');
    }
    const originalPath = parseDocumentRef(value.originalPath);
    const timestamp = parseEpochMs(value.timestamp);
    const modifiedAt = value.modifiedAt === undefined ? undefined : parseEpochMs(value.modifiedAt);
    if (
        originalPath === null
        || typeof value.fileName !== 'string'
        || timestamp === null
        || (value.modifiedAt !== undefined && modifiedAt === null)
        || (value.backend !== undefined && value.backend !== 'electron' && value.backend !== 'browser')
        || (value.fileSize !== undefined && (!isFiniteNumber(value.fileSize) || value.fileSize < 0))
    ) {
        fail('invalid recent file');
    }
    if (modifiedAt === null) {
        fail('invalid recent file');
    }
    return {
        originalPath,
        fileName: value.fileName,
        timestamp,
        ...(value.backend === undefined ? {} : {backend: value.backend}),
        ...(value.fileSize === undefined ? {} : {fileSize: value.fileSize}),
        ...(modifiedAt === undefined ? {} : {modifiedAt}),
    };
}
const applicationMenuOptionalBooleanFields = [
    'interactive',
    'supportsSaveAs',
    'canSaveAs',
    'supportsRepairSave',
    'canRepairSave',
    'supportsOptimizePdf',
    'canOptimizePdf',
    'supportsPrint',
    'canPrint',
    'supportsExportDocx',
    'canExportDocx',
    'isExportingDocx',
    'supportsRasterExport',
    'canExportRaster',
    'canUndo',
    'canRedo',
    'supportsPdfMutation',
    'canMutatePages',
    'supportsContinuousScroll',
    'canContinuousScroll',
    'continuousScroll',
    'supportsViewMode',
    'supportsViewRotation',
    'isActualSizeActive',
    'isFitWidthActive',
    'isFitHeightActive',
    'canToggleAssistant',
    'canCreatePane',
    'canCloseTab',
    'canTransferActiveTab',
] as const satisfies ReadonlyArray<keyof IApplicationMenuDocumentState>;
function decodeApplicationMenuDocumentState(value: unknown): boolean | IApplicationMenuDocumentState {
    if (typeof value === 'boolean') {
        return value;
    }
    if (!isRecord(value) || typeof value.hasDocument !== 'boolean' || typeof value.canSave !== 'boolean') {
        fail('state must include boolean hasDocument and canSave fields');
    }
    for (const field of applicationMenuOptionalBooleanFields) {
        if (value[field] !== undefined && typeof value[field] !== 'boolean') {
            fail(`state.${field} must be a boolean`);
        }
    }
    for (const field of [
        'selectedPageCount',
        'totalPages',
    ] as const) {
        if (value[field] !== undefined && (
            typeof value[field] !== 'number'
            || !Number.isSafeInteger(value[field])
            || value[field] < 0
        )) {
            fail(`state.${field} must be a non-negative safe integer`);
        }
    }
    if (
        value.viewMode !== undefined
        && !isOneOf([
            'single',
            'facing',
            'facing-first-single',
        ] as const, value.viewMode)
    ) {
        fail('state.viewMode must be a supported PDF view mode');
    }
    if (
        value.viewRotation !== undefined
        && !([
            0,
            90,
            180,
            270,
        ] as readonly unknown[]).includes(value.viewRotation)
    ) {
        fail('state.viewRotation must be a supported PDF view rotation');
    }
    return {
        ...value,
        hasDocument: value.hasDocument,
        canSave: value.canSave,
    };
}
function decodeNonNegativeInteger(value: unknown, field: string) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        fail(`${field} must be a non-negative safe integer`);
    }
    return value;
}
const platformUnsupportedReasons = [
    'unsupported-backend',
    'missing-browser-permission',
    'user-canceled',
    'not-implemented',
    'requires-native-backend',
] as const satisfies readonly TPlatformUnsupportedReason[];
const documentSaveFailureReasons = [
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
const longNativeIpcTimeoutMs = 30 * 60 * 1_000;
const fixtureRevisionToken = requireDocumentRevisionToken('drt1:fixture');
const fixtureRevisionOptions = {expectedDocumentRevisionToken: fixtureRevisionToken};
function decodeRequiredObject<T>(value: unknown, fieldName: string): T {
    return decodeRequiredDocumentObject(value, fieldName) as T;
}
function decodeOptionalObject<T>(value: unknown, fieldName: string): T | undefined {
    return decodeOptionalDocumentObjectRaw(value, fieldName) as T | undefined;
}
function decodeArgumentArray(value: unknown, minLength: number, maxLength = minLength) {
    if (!Array.isArray(value) || value.length < minLength || value.length > maxLength) {
        fail(`expected ${minLength === maxLength ? minLength : `${minLength}-${maxLength}`} arguments`);
    }
    return value as unknown[];
}
function decodeStringValue(value: unknown, fieldName: string) {
    if (typeof value !== 'string') {
        fail(`${fieldName} must be a string`);
    }
    return value;
}
function decodeDocumentRefValue(value: unknown, fieldName: string): TDocumentRef {
    const parsed = parseDocumentRef(value);
    if (parsed === null) {
        fail(`${fieldName} must be an absolute document reference`);
    }
    return parsed;
}
function decodeOptionalDocumentRefValue(value: unknown, fieldName: string): TDocumentRef | undefined {
    return value === undefined || value === null
        ? undefined
        : decodeDocumentRefValue(value, fieldName);
}
function decodeRequestIdValue(value: unknown, fieldName: string): TRequestId {
    const parsed = parseRequestId(value);
    if (parsed === null) {
        fail(`${fieldName} must be a non-empty request ID`);
    }
    return parsed;
}
function decodeOptionalRequestIdValue(value: unknown, fieldName: string): TRequestId | undefined {
    return value === undefined || value === null
        ? undefined
        : decodeRequestIdValue(value, fieldName);
}
function decodeLeaseIdValue(value: unknown, fieldName: string): TLeaseId {
    const parsed = parseLeaseId(value);
    if (parsed === null) {
        fail(`${fieldName} must be a non-empty lease ID`);
    }
    return parsed;
}
function decodeDocumentRefArrayValue(value: unknown, fieldName: string): TDocumentRef[] {
    if (!Array.isArray(value)) {
        fail(`${fieldName} must be an array of document references`);
    }
    return value.map((item, index) => decodeDocumentRefValue(item, `${fieldName}[${index}]`));
}
function decodeSingleDocumentRefArgs(value: unknown, fieldName: string): [TDocumentRef] {
    const args = decodeArgumentArray(value, 1);
    return [decodeDocumentRefValue(args[0], fieldName)];
}
function decodeSingleRequestIdArgs(value: unknown, fieldName: string): [TRequestId] {
    const args = decodeArgumentArray(value, 1);
    return [decodeRequestIdValue(args[0], fieldName)];
}
function decodeSingleLeaseIdArgs(value: unknown, fieldName: string): [TLeaseId] {
    const args = decodeArgumentArray(value, 1);
    return [decodeLeaseIdValue(args[0], fieldName)];
}
function decodeOptionalStringValue(value: unknown, fieldName: string) {
    return value === undefined || value === null
        ? undefined
        : decodeStringValue(value, fieldName);
}
function decodeOptimizeOptions(value: unknown): IPdfOptimizeOptions {
    const decoded = decodeRequiredObject<IPdfOptimizeOptions>(value, 'optimizeOptions');
    if (!isPdfOptimizePreset(decoded.preset)) {
        fail('invalid PDF optimize preset');
    }
    return {preset: decoded.preset};
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
        fail('invalid native page preview options');
    }
    return {...decoded};
}
function decodePlatformOperationResult(value: unknown) {
    if (
        !isRecord(value)
        || typeof value.success !== 'boolean'
        || (value.error !== undefined && typeof value.error !== 'string')
        || (value.unsupportedReason !== undefined && !isOneOf(platformUnsupportedReasons, value.unsupportedReason))
        || value.canceled !== undefined
    ) {
        fail('invalid platform operation result');
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
        || (value.unsupportedReason !== undefined && !isOneOf(platformUnsupportedReasons, value.unsupportedReason))
    ) {
        fail('invalid print result');
    }
    return {
        success: value.success,
        ...(value.canceled === undefined ? {} : {canceled: value.canceled}),
        ...(value.error === undefined ? {} : {error: value.error}),
        ...(value.unsupportedReason === undefined ? {} : {unsupportedReason: value.unsupportedReason}),
    };
}
function decodeDocumentSaveResult(value: unknown): TDocumentSaveResult {
    if (!isRecord(value) || typeof value.ok !== 'boolean') {
        fail('invalid document save result');
    }
    const validation = value.validation === undefined
        ? undefined
        : decodeNullablePdfValidation(value.validation);
    if (value.ok) {
        if (
            typeof value.externalWriteCommitted !== 'boolean'
            || typeof value.workingCopyRefreshed !== 'boolean'
        ) {
            fail('invalid document save success result');
        }
        let warning: {
            reason: 'refresh-failed';
            message: string
        } | undefined;
        if (value.warning !== undefined) {
            if (
                !isRecord(value.warning)
                || value.warning.reason !== 'refresh-failed'
                || typeof value.warning.message !== 'string'
            ) {
                fail('invalid document save warning');
            }
            warning = {
                reason: 'refresh-failed',
                message: value.warning.message,
            };
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
        !isOneOf(documentSaveFailureReasons, value.reason)
        || (value.message !== undefined && typeof value.message !== 'string')
        || (value.externalWriteCommitted !== undefined
            && value.externalWriteCommitted !== null
            && typeof value.externalWriteCommitted !== 'boolean')
        || (value.workingCopySyncRequired !== undefined && typeof value.workingCopySyncRequired !== 'boolean')
    ) {
        fail('invalid document save failure result');
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
        || (value.path !== null && parseDocumentRef(value.path) === null)
        || !isPdfOptimizePreset(value.preset)
    ) {
        fail('invalid PDF optimize result');
    }
    const decodeNullableCount = (candidate: unknown, fieldName: string) => {
        if (candidate === null) {
            return null;
        }
        if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0) {
            fail(`${fieldName} must be a non-negative safe integer`);
        }
        return candidate;
    };
    return {
        path: value.path === null ? null : decodeDocumentRefValue(value.path, 'path'),
        validation: decodeNullablePdfValidation(value.validation),
        preset: value.preset,
        originalBytes: decodeNullableCount(value.originalBytes, 'originalBytes'),
        optimizedBytes: decodeNullableCount(value.optimizedBytes, 'optimizedBytes'),
        pageCount: decodeNullableCount(value.pageCount, 'pageCount'),
    };
}
function decodeNativeSaveResult(value: unknown): IPdfNativeSaveResult {
    if (
        !isRecord(value)
        || typeof value.applied !== 'boolean'
        || (
            value.nativeMutationPostconditionsVerified !== undefined
            && value.nativeMutationPostconditionsVerified !== true
        )
        || (value.error !== undefined && !isNativeErrorEnvelope(value.error))
        || (value.syncError !== undefined && typeof value.syncError !== 'string')
    ) {
        fail('invalid native PDF save result');
    }
    const stagedOutput = value.stagedOutput === undefined
        ? undefined
        : decodeTypedStagedArtifact(value.stagedOutput);
    if (value.stagedOutput !== undefined && !stagedOutput) {
        fail('invalid staged native PDF output');
    }
    const identityBindings = value.identityBindings === undefined
        ? undefined
        : normalizePdfNativeAnnotationIdentityBindings(
            value.identityBindings,
            'identityBindings',
            {errorKind: 'error'},
        );
    return {
        applied: value.applied,
        validation: decodeNullablePdfValidation(value.validation),
        ...(value.nativeMutationPostconditionsVerified === true
            ? {nativeMutationPostconditionsVerified: true as const}
            : {}),
        ...(identityBindings === undefined ? {} : {identityBindings}),
        ...(value.error === undefined ? {} : {error: value.error}),
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
        fail('invalid PDF conformance result');
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
const nullableStringResult = s.fromParser<string | null>(
    value => value === null || typeof value === 'string'
        ? value
        : fail('expected a nullable string'),
    () => null,
);
const recentFilesResult = s.array(
    s.fromParser(decodeRecentFile, () => ({
        originalPath: decodeDocumentRefValue('/tmp/document.pdf', 'originalPath'),
        fileName: 'document.pdf',
        timestamp: requireEpochMs(0),
    })),
);
const menuStateArgs = s.tuple([s.fromParser(decodeApplicationMenuDocumentState, () => false)]);
const nonNegativeInteger = s.fromParser(
    value => decodeNonNegativeInteger(value, 'value'),
    () => 0,
);
const noPayload = s.undefined();
const optimizeProgress = s.fromParser(decodeOptimizeProgress, () => ({
    requestId: parseRequestId('optimize-1') ?? fail('invalid optimize request fixture'),
    preset: 'lossless' as const,
    phase: 'preparing' as const,
    processed: 0,
    total: 1,
    percent: 0,
}));
const openBatchProgress = s.fromParser(decodeOpenBatchProgress, () => ({
    operation: 'document-open' as const,
    requestId: parseRequestId('open-1') ?? fail('invalid open request fixture'),
    processed: 0,
    total: 1,
    percent: 0,
    elapsedMs: 0,
    estimatedRemainingMs: null,
}));
const folderDialogResult = s.trustedDirect<TOpenFolderDialogResult>(() => ({
    ok: false,
    reason: 'not-implemented',
}));
const showItemResult = s.trustedDirect<TShowItemInFolderResult>(() => ({
    ok: false,
    reason: 'not-implemented',
}));
type TDocumentMethodName = keyof IDocumentsFileCapability;
type TDocumentMethod<TName extends TDocumentMethodName> =
    NonNullable<IDocumentsFileCapability[TName]>;
type TDocumentMethodArgs<TName extends TDocumentMethodName> =
    Parameters<Extract<TDocumentMethod<TName>, (...args: never[]) => unknown>>;
type TDocumentMethodResult<TName extends TDocumentMethodName> =
    Awaited<ReturnType<Extract<TDocumentMethod<TName>, (...args: never[]) => unknown>>>;
function documentArgs<TName extends TDocumentMethodName>(
    decode: (value: unknown) => TDocumentMethodArgs<TName>,
    example: () => TDocumentMethodArgs<TName>,
) {
    return s.declared<TDocumentMethodArgs<TName>>()(s.fromParser(decode, example));
}
function documentResult<TName extends TDocumentMethodName>(
    decode: (value: unknown) => TDocumentMethodResult<TName>,
    example: () => TDocumentMethodResult<TName>,
) {
    return s.declared<TDocumentMethodResult<TName>>()(s.fromParser(decode, example));
}
function decodeSingleStringArgs<TName extends TDocumentMethodName>(
    value: unknown,
    fieldName: string,
) {
    const args = decodeArgumentArray(value, 1);
    return [decodeStringValue(args[0], fieldName)] as TDocumentMethodArgs<TName>;
}
const openDocumentDirectArgs = documentArgs<'openDocumentDirect'>(
    (value) => {
        const args = decodeArgumentArray(value, 1, 2);
        const path = decodeDocumentRefValue(args[0], 'path');
        return args.length === 1 || args[1] === undefined
            ? [path]
            : (() => {
                const password = decodeStringValue(args[1], 'password');
                if (!isPdfDecryptPassword(password)) {
                    fail(`password exceeds the ${PDF_DECRYPT_PASSWORD_MAX_BYTES}-byte limit`);
                }
                return [
                    path,
                    password,
                ];
            })();
    },
    () => [decodeDocumentRefValue('/tmp/document.pdf', 'path')],
);
const openDocumentDirectBatchArgs = documentArgs<'openDocumentDirectBatch'>(
    (value) => {
        const args = decodeArgumentArray(value, 1, 3);
        const paths = decodeDocumentRefArrayValue(args[0], 'paths');
        const requestId = decodeOptionalRequestIdValue(args[1], 'requestId');
        const rawOptions = args[2];
        let options: {forceCombine?: boolean} | undefined;
        if (rawOptions !== undefined) {
            const decoded = decodeRequiredObject<{forceCombine?: unknown}>(rawOptions, 'options');
            if (decoded.forceCombine !== undefined && typeof decoded.forceCombine !== 'boolean') {
                fail('invalid force-combine option');
            }
            options = decoded.forceCombine === undefined ? {} : {forceCombine: decoded.forceCombine};
        }
        if (options !== undefined) {
            return [
                paths,
                requestId ?? decodeRequestIdValue('open-1', 'requestId'),
                options,
            ];
        }
        return requestId === undefined ? [paths] : [
            paths,
            requestId,
        ];
    },
    () => [
        [decodeDocumentRefValue('/tmp/document.pdf', 'path')],
        decodeRequestIdValue('open-1', 'requestId'),
    ],
);
const cancelOpenBatchArgs = documentArgs<'cancelOpenDocumentDirectBatch'>(
    value => decodeSingleRequestIdArgs(value, 'requestId'),
    () => [decodeRequestIdValue('open-1', 'requestId')],
);
const createWorkingCopyFromDataArgs = documentArgs<'createWorkingCopyFromData'>(
    (value) => {
        const args = decodeArgumentArray(value, 2, 4);
        const fileName = decodeStringValue(args[0], 'fileName');
        const data = decodeUint8ArrayValue(args[1], 'data');
        const originalPath = decodeOptionalDocumentRefValue(args[2], 'originalPath');
        if (args.length < 4) {
            return appendOptional([
                fileName,
                data,
            ], originalPath);
        }
        const password = decodeOptionalStringValue(args[3], 'password');
        if (password !== undefined && !isPdfDecryptPassword(password)) {
            fail(`password exceeds the ${PDF_DECRYPT_PASSWORD_MAX_BYTES}-byte limit`);
        }
        return [
            fileName,
            data,
            originalPath,
            password,
        ];
    },
    () => [
        'document.pdf',
        Uint8Array.of(1),
    ],
);
const createWorkingCopyFromPathArgs = documentArgs<'createWorkingCopyFromPath'>(
    (value) => {
        const args = decodeArgumentArray(value, 1, 3);
        const sourcePath = decodeDocumentRefValue(args[0], 'sourcePath');
        const originalPath = decodeOptionalDocumentRefValue(args[1], 'originalPath');
        if (args.length < 3) {
            return appendOptional([sourcePath], originalPath);
        }
        const password = decodeOptionalStringValue(args[2], 'password');
        if (password !== undefined && !isPdfDecryptPassword(password)) {
            fail(`password exceeds the ${PDF_DECRYPT_PASSWORD_MAX_BYTES}-byte limit`);
        }
        return [
            sourcePath,
            originalPath,
            password,
        ];
    },
    () => [decodeDocumentRefValue('/tmp/source.pdf', 'sourcePath')],
);
const savePdfAsArgs = documentArgs<'savePdfAs'>(
    (value) => {
        const args = decodeArgumentArray(value, 2, 3);
        return appendOptional([
            decodeDocumentRefValue(args[0], 'workingPath'),
            decodeSaveAsOptions(args[1]),
        ], decodeRevisionOptions(args[2])) as TDocumentMethodArgs<'savePdfAs'>;
    },
    () => [
        decodeDocumentRefValue('/tmp/working.pdf', 'workingPath'),
        undefined,
        fixtureRevisionOptions,
    ],
);
const savePdfDialogArgs = documentArgs<'savePdfDialog'>(
    value => decodeSingleStringArgs<'savePdfDialog'>(value, 'suggestedName'),
    () => ['document.pdf'],
);
const pathArgs = (fieldName: string) => s.fromParser<[TDocumentRef]>(
    (value) => {
        const args = decodeArgumentArray(value, 1);
        return [decodeDocumentRefValue(args[0], fieldName)];
    },
    () => [decodeDocumentRefValue('/tmp/document.pdf', fieldName)],
);
const readFileArgs = s.declared<TDocumentMethodArgs<'readFile'>>()(
    pathArgs('path'),
);
const statFileArgs = s.declared<TDocumentMethodArgs<'statFile'>>()(
    pathArgs('path'),
);
const readFileRangeArgs = documentArgs<'readFileRange'>(
    (value) => {
        const args = decodeArgumentArray(value, 3);
        return [
            decodeDocumentRefValue(args[0], 'path'),
            decodeSafeIntegerValue(args[1], 'offset'),
            decodeSafeIntegerValue(args[2], 'length'),
        ];
    },
    () => [
        decodeDocumentRefValue('/tmp/document.pdf', 'path'),
        0,
        1,
    ],
);
const managedHandleArgs = documentArgs<'createManagedTempFileHandle'>(
    value => decodeSingleDocumentRefArgs(value, 'path'),
    () => [decodeDocumentRefValue('/tmp/document.pdf', 'path')],
);
const releaseManagedHandleArgs = documentArgs<'releaseManagedTempFileHandle'>(
    value => decodeSingleLeaseIdArgs(value, 'leaseId'),
    () => [decodeLeaseIdValue('lease-1', 'leaseId')],
);
const openingGeometryArgs = documentArgs<'getPdfOpeningGeometry'>(
    value => decodeSingleDocumentRefArgs(value, 'path'),
    () => [decodeDocumentRefValue('/tmp/document.pdf', 'path')],
);
const pageSizesArgs = documentArgs<'getPdfNativePageSizes'>(
    value => decodeSingleDocumentRefArgs(value, 'path'),
    () => [decodeDocumentRefValue('/tmp/document.pdf', 'path')],
);
const cancelRequestArgs = documentArgs<'cancelPdfNativePagePreview'>(
    value => decodeSingleRequestIdArgs(value, 'requestId'),
    () => [decodeRequestIdValue('preview-1', 'requestId')],
);
const pagePreviewArgs = documentArgs<'renderPdfNativePagePreview'>(
    (value) => {
        const args = decodeArgumentArray(value, 2, 3);
        return appendOptional([
            decodeDocumentRefValue(args[0], 'path'),
            requirePageNumber(decodeSafeIntegerValue(args[1], 'pageNumber', 1)),
        ], decodePreviewOptions(args[2])) as TDocumentMethodArgs<'renderPdfNativePagePreview'>;
    },
    () => [
        decodeDocumentRefValue('/tmp/document.pdf', 'path'),
        requirePageNumber(1),
    ],
);
const readTextFileArgs = documentArgs<'readTextFile'>(
    value => decodeSingleDocumentRefArgs(value, 'path'),
    () => [decodeDocumentRefValue('/tmp/document.txt', 'path')],
);
const fileExistsArgs = documentArgs<'fileExists'>(
    value => decodeSingleDocumentRefArgs(value, 'path'),
    () => [decodeDocumentRefValue('/tmp/document.pdf', 'path')],
);
const documentRevisionArgs = documentArgs<'getDocumentRevision'>(
    value => decodeSingleDocumentRefArgs(value, 'path'),
    () => [decodeDocumentRefValue('/tmp/document.pdf', 'path')],
);
const writeFileArgs = documentArgs<'writeFile'>(
    (value) => {
        const args = decodeArgumentArray(value, 2, 3);
        return appendOptional([
            decodeDocumentRefValue(args[0], 'path'),
            decodeUint8ArrayValue(args[1], 'data'),
        ], decodeRevisionOptions(args[2])) as TDocumentMethodArgs<'writeFile'>;
    },
    () => [
        decodeDocumentRefValue('/tmp/document.pdf', 'path'),
        Uint8Array.of(1),
        fixtureRevisionOptions,
    ],
);
const replaceWorkingCopyArgs = documentArgs<'replaceWorkingCopyFromPath'>(
    (value) => {
        const args = decodeArgumentArray(value, 2, 3);
        return appendOptional([
            decodeDocumentRefValue(args[0], 'workingCopyPath'),
            decodeDocumentRefValue(args[1], 'sourcePath'),
        ], decodeRevisionOptions(args[2])) as TDocumentMethodArgs<'replaceWorkingCopyFromPath'>;
    },
    () => [
        decodeDocumentRefValue('/tmp/working.pdf', 'workingCopyPath'),
        decodeDocumentRefValue('/tmp/source.pdf', 'sourcePath'),
        fixtureRevisionOptions,
    ],
);
const writeDocxArgs = documentArgs<'writeDocxFile'>(
    (value) => {
        const args = decodeArgumentArray(value, 2);
        return [
            decodeDocumentRefValue(args[0], 'path'),
            decodeUint8ArrayValue(args[1], 'data'),
        ];
    },
    () => [
        decodeDocumentRefValue('/tmp/document.docx', 'path'),
        Uint8Array.of(1),
    ],
);
const saveFileStructuredArgs = documentArgs<'saveFileStructured'>(
    (value) => {
        const args = decodeArgumentArray(value, 1, 2);
        return appendOptional(
            [decodeDocumentRefValue(args[0], 'path')],
            decodeRevisionOptions(args[1]),
        ) as TDocumentMethodArgs<'saveFileStructured'>;
    },
    () => [
        decodeDocumentRefValue('/tmp/working.pdf', 'path'),
        fixtureRevisionOptions,
    ],
);
const repairPdfArgs = documentArgs<'repairPdf'>(
    value => saveFileStructuredArgs.decode(value),
    () => [
        decodeDocumentRefValue('/tmp/working.pdf', 'path'),
        fixtureRevisionOptions,
    ],
);
const optimizeInteractionArgs = documentArgs<'optimizePdfForInteraction'>(
    value => saveFileStructuredArgs.decode(value),
    () => [
        decodeDocumentRefValue('/tmp/working.pdf', 'path'),
        fixtureRevisionOptions,
    ],
);
const optimizeAsCopyArgs = documentArgs<'optimizePdfAsCopy'>(
    (value) => {
        const args = decodeArgumentArray(value, 2, 4);
        const base: [TDocumentRef, IPdfOptimizeOptions] = [
            decodeDocumentRefValue(args[0], 'path'),
            decodeOptimizeOptions(args[1]),
        ];
        const requestId = args[2] === undefined
            ? undefined
            : parseRequestId(args[2]) ?? fail('requestId must be a non-empty string');
        if (requestId === undefined) {
            return base;
        }
        return appendOptional([
            ...base,
            requestId,
        ], decodeRevisionOptions(args[3])) as TDocumentMethodArgs<'optimizePdfAsCopy'>;
    },
    () => [
        decodeDocumentRefValue('/tmp/working.pdf', 'path'),
        {preset: 'lossless'},
        parseRequestId('optimize-1') ?? fail('invalid optimize request fixture'),
        fixtureRevisionOptions,
    ],
);
const nativeNoteTextArgs = documentArgs<'savePdfNoteTextUpdates'>(
    (value) => {
        const args = decodeArgumentArray(value, 3, 4);
        if (!Array.isArray(args[1])) {
            fail('updates must be an array');
        }
        return appendOptional([
            decodeDocumentRefValue(args[0], 'path'),
            args[1] as TDocumentMethodArgs<'savePdfNoteTextUpdates'>[1],
            normalizePdfNativeModifiedAt(args[2], 'modifiedAt'),
        ], decodeRevisionOptions(args[3])) as TDocumentMethodArgs<'savePdfNoteTextUpdates'>;
    },
    () => [
        decodeDocumentRefValue('/tmp/working.pdf', 'path'),
        [],
        normalizePdfNativeModifiedAt('D:20260101000000Z', 'modifiedAt'),
        fixtureRevisionOptions,
    ],
);
const nativeNoteChangesArgs = documentArgs<'savePdfNoteChanges'>(
    (value) => {
        const args = decodeArgumentArray(value, 3, 4);
        return appendOptional([
            decodeDocumentRefValue(args[0], 'path'),
            decodeRequiredObject<TDocumentMethodArgs<'savePdfNoteChanges'>[1]>(args[1], 'changes'),
            normalizePdfNativeModifiedAt(args[2], 'modifiedAt'),
        ], decodeRevisionOptions(args[3])) as TDocumentMethodArgs<'savePdfNoteChanges'>;
    },
    () => [
        decodeDocumentRefValue('/tmp/working.pdf', 'path'),
        {},
        normalizePdfNativeModifiedAt('D:20260101000000Z', 'modifiedAt'),
        fixtureRevisionOptions,
    ],
);
const nativeMutationsArgs = documentArgs<'savePdfNativeMutations'>(
    (value) => {
        const args = decodeArgumentArray(value, 3, 4);
        return appendOptional([
            decodeDocumentRefValue(args[0], 'path'),
            normalizePdfNativeMutationSet(args[1], 'mutations'),
            normalizePdfNativeModifiedAt(args[2], 'modifiedAt'),
        ], decodeRevisionOptions(args[3])) as TDocumentMethodArgs<'savePdfNativeMutations'>;
    },
    () => [
        decodeDocumentRefValue('/tmp/working.pdf', 'path'),
        fixtureNativeMutation,
        normalizePdfNativeModifiedAt('D:20260101000000Z', 'modifiedAt'),
        fixtureRevisionOptions,
    ],
);
const applyNativeMutationsArgs = documentArgs<'applyPdfNativeMutationsToWorkingCopy'>(
    (value) => {
        const args = decodeArgumentArray(value, 4);
        const revisionOptions = decodeRevisionOptions(args[3]);
        if (!revisionOptions) {
            fail('applyPdfNativeMutationsToWorkingCopy requires revisionOptions');
        }
        return [
            decodeDocumentRefValue(args[0], 'path'),
            normalizePdfNativeMutationSet(args[1], 'mutations'),
            normalizePdfNativeModifiedAt(args[2], 'modifiedAt'),
            revisionOptions,
        ] as TDocumentMethodArgs<'applyPdfNativeMutationsToWorkingCopy'>;
    },
    () => [
        decodeDocumentRefValue('/tmp/working.pdf', 'path'),
        fixtureNativeMutation,
        normalizePdfNativeModifiedAt('D:20260101000000Z', 'modifiedAt'),
        fixtureRevisionOptions,
    ],
);
const commitNativeMutationsArgs = documentArgs<'commitStagedPdfNativeMutations'>(
    (value) => {
        const args = decodeArgumentArray(value, 2, 3);
        const stagedOutput = decodeTypedStagedArtifact(args[1]);
        if (!stagedOutput) {
            fail('stagedOutput must be a typed staged artifact');
        }
        const decoded = appendOptional([
            decodeDocumentRefValue(args[0], 'path'),
            stagedOutput,
        ], decodePdfNativeStagedCommitOptions(args[2]));
        return decoded as TDocumentMethodArgs<'commitStagedPdfNativeMutations'>;
    },
    () => [
        decodeDocumentRefValue('/tmp/working.pdf', 'path'),
        {
            receiptVersion: 1,
            artifactKind: 'pdf',
            path: decodeDocumentRefValue('/tmp/staged.pdf', 'path'),
            size: 1,
            sha256: '0'.repeat(64),
            fileIdentity: {
                platform: 'posix',
                deviceId: '1',
                inode: '2',
            },
            validations: {
                qpdfCheck: false,
                tailCheck: false,
                semanticCheck: false,
                fsynced: false,
            },
            leaseId: parseLeaseId('lease-1') ?? fail('invalid lease fixture'),
            revision: null,
        },
        fixtureRevisionOptions,
    ],
);
const cloneStagedNativeMutationArgs = documentArgs<'cloneStagedPdfNativeMutationToWorkingCopy'>(
    (value) => {
        const args = decodeArgumentArray(value, 1, 2);
        const stagedOutput = decodeTypedStagedArtifact(args[0]);
        if (!stagedOutput) {
            fail('stagedOutput must be a typed staged artifact');
        }
        return appendOptional(
            [stagedOutput],
            decodeOptionalDocumentRefValue(args[1], 'originalPath'),
        ) as TDocumentMethodArgs<'cloneStagedPdfNativeMutationToWorkingCopy'>;
    },
    () => [
        commitNativeMutationsArgs.example()[1],
        decodeDocumentRefValue('/tmp/original.pdf', 'originalPath'),
    ] as TDocumentMethodArgs<'cloneStagedPdfNativeMutationToWorkingCopy'>,
);
const replaceWorkingCopyFromStagedNativeMutationArgs = documentArgs<'replaceWorkingCopyFromStagedPdfNativeMutation'>(
    (value) => {
        const args = decodeArgumentArray(value, 3, 3);
        const stagedOutput = decodeTypedStagedArtifact(args[1]);
        if (!stagedOutput) {
            fail('stagedOutput must be a typed staged artifact');
        }
        return [
            decodeDocumentRefValue(args[0], 'workingCopyPath'),
            stagedOutput,
            decodeRevisionOptions(args[2]),
        ] as TDocumentMethodArgs<'replaceWorkingCopyFromStagedPdfNativeMutation'>;
    },
    () => [
        decodeDocumentRefValue('/tmp/working.pdf', 'workingCopyPath'),
        commitNativeMutationsArgs.example()[1],
        fixtureRevisionOptions,
    ] as TDocumentMethodArgs<'replaceWorkingCopyFromStagedPdfNativeMutation'>,
);
const pdfDataArgs = documentArgs<'validatePdfData'>(
    (value) => {
        const args = decodeArgumentArray(value, 1, 2);
        return appendOptional(
            [decodeUint8ArrayValue(args[0], 'data')],
            decodeOptionalStringValue(args[1], 'fileName'),
        );
    },
    () => [Uint8Array.of(1)],
);
const printPdfDataArgs = documentArgs<'printPdfData'>(
    (value) => {
        const args = decodeArgumentArray(value, 1, 3);
        const data = decodeUint8ArrayValue(args[0], 'data');
        const fileName = decodeOptionalStringValue(args[1], 'fileName');
        if (args[2] === undefined) {
            return appendOptional([data], fileName);
        }
        const options = decodePdfDataPrintOptions(args[2], 'options');
        return [
            data,
            fileName,
            options,
        ];
    },
    () => [Uint8Array.of(1)],
);
const pdfPathArgs = documentArgs<'analyzePdfConformance'>(
    value => {
        const args = decodeArgumentArray(value, 1, 2);
        const rawOptions = decodeOptionalObject<IPdfConformanceAnalysisOptions>(args[1], 'options');
        if (
            rawOptions?.purpose !== undefined
            && rawOptions.purpose !== 'full'
            && rawOptions.purpose !== 'save-restrictions'
        ) {
            fail('invalid PDF conformance analysis purpose');
        }
        return appendOptional([decodeDocumentRefValue(args[0], 'path')], rawOptions) as TDocumentMethodArgs<'analyzePdfConformance'>;
    },
    () => [decodeDocumentRefValue('/tmp/document.pdf', 'path')],
);
const openPdfPathArgs = documentArgs<'openPdfInDefaultAppPath'>(
    (value) => {
        const args = decodeArgumentArray(value, 1, 2);
        return appendOptional(
            [decodeDocumentRefValue(args[0], 'path')],
            decodeOptionalStringValue(args[1], 'fileName'),
        );
    },
    () => [decodeDocumentRefValue('/tmp/document.pdf', 'path')],
);
const printPdfPathArgs = documentArgs<'printPdfPath'>(
    (value) => {
        const args = decodeArgumentArray(value, 1, 3);
        const path = decodeDocumentRefValue(args[0], 'path');
        const fileName = decodeOptionalStringValue(args[1], 'fileName');
        if (args[2] === undefined) {
            return fileName === undefined
                ? [path]
                : [
                    path,
                    fileName,
                ];
        }
        return [
            path,
            fileName,
            decodePdfPathPrintOptions(args[2], 'options'),
        ];
    },
    () => [decodeDocumentRefValue('/tmp/document.pdf', 'path')],
);

const booleanResult = s.boolean();
const bytesResult = s.fromParser(
    value => decodeUint8ArrayValue(value, 'result'),
    () => Uint8Array.of(1),
);
const fileStatResult = s.fromParser(
    (value) => {
        if (!isRecord(value) || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0) {
            fail('invalid file stat');
        }
        if (
            value.modifiedAt !== undefined
            && (
                typeof value.modifiedAt !== 'number'
                || !Number.isSafeInteger(value.modifiedAt)
                || value.modifiedAt < 0
            )
        ) {
            fail('invalid file modification time');
        }
        return {
            size: value.size,
            ...(value.modifiedAt === undefined ? {} : {modifiedAt: value.modifiedAt}),
        };
    },
    () => ({size: 1}),
);
const managedHandleResult = documentResult<'createManagedTempFileHandle'>(
    value => decodeManagedTempFileHandle(value) ?? fail('invalid managed temporary file handle'),
    () => ({
        path: decodeDocumentRefValue('/tmp/document.pdf', 'path'),
        size: 1,
        sha256: '0'.repeat(64),
        leaseId: parseLeaseId('lease-1') ?? fail('invalid lease fixture'),
        revision: null,
    }),
);
const openingGeometryResult = documentResult<'getPdfOpeningGeometry'>(
    value => value === null ? null : decodeOpeningGeometry(value),
    () => ({
        pageNumber: requirePageNumber(1),
        pageCount: 1,
        width: 612,
        height: 792,
        rotation: 0,
        size: 1,
        modifiedAt: requireEpochMs(0),
    }),
);
const pageSizesResult = documentResult<'getPdfNativePageSizes'>(
    decodePageSizesResult,
    () => [{
        width: 612,
        height: 792,
    }],
);
const cancellationResult = documentResult<'cancelPdfNativePagePreview'>(
    (value) => {
        if (!isRecord(value) || typeof value.canceled !== 'boolean') {
            fail('invalid preview cancellation result');
        }
        return {canceled: value.canceled};
    },
    () => ({canceled: false}),
);
const pagePreviewResult = documentResult<'renderPdfNativePagePreview'>(
    decodePagePreviewResult,
    () => ({
        bytes: Uint8Array.of(1),
        width: 1,
        height: 1,
    }),
);
const revisionResult = documentResult<'getDocumentRevision'>(
    value => isDocumentRevisionInfo(value) ? value : fail('invalid document revision'),
    () => ({
        version: 1,
        token: fixtureRevisionToken,
        documentRef: decodeDocumentRefValue('/tmp/document.pdf', 'documentRef'),
        authority: 'electron-working-copy',
        contentRevision: 1,
        mintedAt: requireEpochMs(1),
    }),
);
const validationResult = s.fromParser<IPdfValidationResult>(decodePdfValidation, () => ({
    isValid: true,
    tool: 'native',
    errors: [],
    warnings: [],
}));
const documentSaveResult = s.fromParser<TDocumentSaveResult>(
    decodeDocumentSaveResult,
    () => ({
        ok: true,
        externalWriteCommitted: true,
        workingCopyRefreshed: true,
    }),
);
const optimizeResult = s.fromParser<IPdfOptimizeResult>(
    decodeOptimizeResult,
    () => ({
        path: null,
        validation: null,
        preset: 'lossless',
        originalBytes: null,
        optimizedBytes: null,
        pageCount: null,
    }),
);
const nativeSaveResult = s.fromParser(decodeNativeSaveResult, () => ({
    applied: true,
    validation: null,
}));
const documentRevisionEvent = s.fromParser<IDocumentRevisionChangedEvent>(
    value => decodeDocumentRevisionChangedEvent(value) ?? fail('invalid document revision event'),
    () => ({
        ...revisionResult.example(),
        reason: 'write',
    }),
);


export {
    applyNativeMutationsArgs,
    booleanResult,
    bytesResult,
    cancelOpenBatchArgs,
    cancellationResult,
    cancelRequestArgs,
    commitNativeMutationsArgs,
    cloneStagedNativeMutationArgs,
    createWorkingCopyFromDataArgs,
    createWorkingCopyFromPathArgs,
    decodeConformanceResult,
    decodeOpenFileResult,
    decodePdfValidation,
    decodePathValidationResult,
    decodePlatformOperationResult,
    decodePrintResult,
    decodeRevisionOptions,
    decodeSaveAsOptions,
    documentRevisionArgs,
    documentRevisionEvent,
    documentSaveResult,
    fileExistsArgs,
    fileStatResult,
    fixtureRevisionOptions,
    folderDialogResult,
    longNativeIpcTimeoutMs,
    managedHandleArgs,
    managedHandleResult,
    menuStateArgs,
    nativeMutationsArgs,
    nativeNoteChangesArgs,
    nativeNoteTextArgs,
    nativeSaveResult,
    noPayload,
    nonNegativeInteger,
    nullableStringResult,
    openBatchProgress,
    openDocumentDirectArgs,
    openDocumentDirectBatchArgs,
    openFileResult,
    openingGeometryArgs,
    openingGeometryResult,
    openPdfPathArgs,
    optimizeAsCopyArgs,
    optimizeInteractionArgs,
    optimizeProgress,
    optimizeResult,
    pagePreviewArgs,
    pagePreviewResult,
    pageSizesArgs,
    pageSizesResult,
    pathArgs,
    pdfDataArgs,
    pdfPathArgs,
    printPdfDataArgs,
    printPdfPathArgs,
    readFileArgs,
    readFileRangeArgs,
    readTextFileArgs,
    recentFilesResult,
    releaseManagedHandleArgs,
    repairPdfArgs,
    replaceWorkingCopyArgs,
    replaceWorkingCopyFromStagedNativeMutationArgs,
    revisionResult,
    saveFileStructuredArgs,
    savePdfAsArgs,
    savePdfDialogArgs,
    showItemResult,
    statFileArgs,
    validationResult,
    writeDocxArgs,
    writeFileArgs,
    decodeArgumentArray,
    decodeSafeIntegerValue,
    documentArgs,
    documentResult,
};
export type {
    TDocumentMethodArgs,
    TDocumentMethodResult,
};
