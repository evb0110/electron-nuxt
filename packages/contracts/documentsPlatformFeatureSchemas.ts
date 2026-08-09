import type {
    IApplicationMenuDocumentState,
    IDocumentsFileCapability,
    IPdfNativePagePreview,
    IPdfNativePagePreviewOptions,
    IPdfNativePageSize,
    IPdfNativeSaveResult,
    IPdfNativeStagedCommitOptions,
    IPdfNativeWorkingCopyExpectation,
    IPdfOptimizeOptions,
    IPdfOptimizeResult,
    TDocumentSaveResult,
    TOpenFileResult,
    TOpenFolderDialogResult,
    TShowItemInFolderResult,
} from '@contracts/electronApiDocuments';
import {
    decodeManagedTempFileHandle,
    decodeOpenBatchProgress,
    decodeOptimizeProgress,
    isPdfOptimizePreset,
} from '@contracts/electronApiDocuments';
import {
    decodeDocumentRevisionChangedEvent,
    isDocumentRevisionInfo,
    requireDocumentRevisionToken,
    type IDocumentRevisionChangedEvent,
} from '@contracts/documentRevision';
import {
    appendOptionalDocumentArg as appendOptional,
    decodeNullablePdfValidation,
    decodeOptionalDocumentObject as decodeOptionalObject,
    decodePdfPathValidationResult as decodePathValidationResult,
    decodePdfRevisionOptions as decodeRevisionOptions,
    decodePdfSaveAsOptions as decodeSaveAsOptions,
    decodePdfValidation,
    decodeRequiredDocumentObject as decodeRequiredObject,
} from '@contracts/documentsPersistenceSchemas';
import type {
    IPdfConformanceProfile,
    IPdfValidationResult,
} from '@contracts/pdfConformance';
import type { TPlatformUnsupportedReason } from '@contracts/platformUnsupported';
import {runtimeSchema as s} from '@contracts/platformFeature';
import {
    isFiniteNumber,
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import type { IRecentFile } from '@contracts/shared';
import {decodeTypedStagedArtifact} from '@contracts/stagedArtifacts';

function fail(message: string): never {
    throw new Error(message);
}

function decodeOpeningGeometry(value: unknown) {
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
        || typeof value.rotation !== 'number'
        || !([
            0,
            90,
            180,
            270,
        ] as const).includes(value.rotation as 0 | 90 | 180 | 270)
        || typeof value.size !== 'number'
        || !Number.isSafeInteger(value.size)
        || value.size < 0
        || typeof value.modifiedAt !== 'number'
        || !Number.isSafeInteger(value.modifiedAt)
        || value.modifiedAt < 0
    ) {
        fail('invalid PDF opening geometry result');
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

function decodeOpenFileResult(value: unknown): TOpenFileResult | null {
    if (value === null) {
        return null;
    }
    if (!isRecord(value) || (value.kind !== 'pdf' && value.kind !== 'djvu')) {
        fail('invalid open-file result');
    }
    if (value.kind === 'djvu') {
        if (value.workingPath !== '' || typeof value.originalPath !== 'string') {
            fail('invalid DjVu open-file result');
        }
        return {
            kind: 'djvu',
            workingPath: '',
            originalPath: value.originalPath,
        };
    }
    if (
        typeof value.workingPath !== 'string'
        || typeof value.originalPath !== 'string'
        || (value.isGenerated !== undefined && typeof value.isGenerated !== 'boolean')
    ) {
        fail('invalid PDF open-file result');
    }
    const openingGeometry = value.openingGeometry === undefined
        ? undefined
        : decodeOpeningGeometry(value.openingGeometry);
    return {
        kind: 'pdf',
        workingPath: value.workingPath,
        originalPath: value.originalPath,
        ...(value.isGenerated === undefined ? {} : {isGenerated: value.isGenerated}),
        ...(openingGeometry === undefined ? {} : {openingGeometry}),
    };
}

function decodeRecentFile(value: unknown): IRecentFile {
    if (
        !isRecord(value)
        || typeof value.originalPath !== 'string'
        || typeof value.fileName !== 'string'
        || !isFiniteNumber(value.timestamp)
        || (value.backend !== undefined && value.backend !== 'electron' && value.backend !== 'browser')
        || (value.fileSize !== undefined && (!isFiniteNumber(value.fileSize) || value.fileSize < 0))
        || (value.modifiedAt !== undefined && (!Number.isSafeInteger(value.modifiedAt) || Number(value.modifiedAt) < 0))
    ) {
        fail('invalid recent file');
    }
    return {
        originalPath: value.originalPath,
        fileName: value.fileName,
        timestamp: value.timestamp,
        ...(value.backend === undefined ? {} : {backend: value.backend}),
        ...(value.fileSize === undefined ? {} : {fileSize: value.fileSize}),
        ...(value.modifiedAt === undefined ? {} : {modifiedAt: Number(value.modifiedAt)}),
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

function decodeOptionalStringValue(value: unknown, fieldName: string) {
    return value === undefined || value === null
        ? undefined
        : decodeStringValue(value, fieldName);
}

function decodeStringArrayValue(value: unknown, fieldName: string) {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        fail(`${fieldName} must be an array of strings`);
    }
    return value as string[];
}

function decodeSafeIntegerValue(value: unknown, fieldName: string, min = 0) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
        fail(`${fieldName} must be a safe integer >= ${min}`);
    }
    return value;
}

function decodePositiveIntegerArrayValue(value: unknown, fieldName: string) {
    if (
        !Array.isArray(value)
        || value.some(item => typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1)
    ) {
        fail(`${fieldName} must contain positive safe integers`);
    }
    return value as number[];
}

function decodeUint8ArrayValue(value: unknown, fieldName: string) {
    if (!(value instanceof Uint8Array)) {
        fail(`${fieldName} must be a Uint8Array`);
    }
    return value;
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
        || (value.externalWriteCommitted !== undefined && typeof value.externalWriteCommitted !== 'boolean')
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
        || (value.path !== null && typeof value.path !== 'string')
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
        path: value.path,
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

function decodePageSizesResult(value: unknown): IPdfNativePageSize[] {
    if (!Array.isArray(value)) {
        fail('invalid native page sizes result');
    }
    return value.map((item) => {
        if (!isRecord(item) || !isFiniteNumber(item.width) || !isFiniteNumber(item.height)) {
            fail('invalid native page size');
        }
        return {
            width: item.width,
            height: item.height,
        };
    });
}

function decodePagePreviewResult(value: unknown): IPdfNativePagePreview {
    if (!isRecord(value) || !isFiniteNumber(value.width) || !isFiniteNumber(value.height)) {
        fail('invalid native page preview result');
    }
    const rasterWidthCeilingPx = value.rasterWidthCeilingPx === undefined
        ? undefined
        : decodeSafeIntegerValue(value.rasterWidthCeilingPx, 'rasterWidthCeilingPx', 1);
    return {
        bytes: decodeUint8ArrayValue(value.bytes, 'bytes'),
        width: value.width,
        height: value.height,
        ...(rasterWidthCeilingPx === undefined ? {} : {rasterWidthCeilingPx}),
    };
}

const openFileResult = s.fromParser<TFileResult>(decodeOpenFileResult, () => null);
type TFileResult = TOpenFileResult | null;
const nullableStringResult = s.fromParser<string | null>(
    value => value === null || typeof value === 'string'
        ? value
        : fail('expected a nullable string'),
    () => null,
);
const recentFilesResult = s.array(
    s.fromParser(decodeRecentFile, () => ({
        originalPath: '/tmp/document.pdf',
        fileName: 'document.pdf',
        timestamp: 0,
    })),
);
const menuStateArgs = s.tuple([s.fromParser(decodeApplicationMenuDocumentState, () => false)]);
const nonNegativeInteger = s.fromParser(
    value => decodeNonNegativeInteger(value, 'value'),
    () => 0,
);
const noPayload = s.undefined();
const optimizeProgress = s.fromParser(decodeOptimizeProgress, () => ({
    requestId: 'optimize-1',
    preset: 'lossless' as const,
    phase: 'preparing' as const,
    processed: 0,
    total: 1,
    percent: 0,
}));
const openBatchProgress = s.fromParser(decodeOpenBatchProgress, () => ({
    operation: 'document-open' as const,
    requestId: 'open-1',
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
    value => decodeSingleStringArgs<'openDocumentDirect'>(value, 'path'),
    () => ['/tmp/document.pdf'],
);
const openDocumentDirectBatchArgs = documentArgs<'openDocumentDirectBatch'>(
    (value) => {
        const args = decodeArgumentArray(value, 1, 3);
        const paths = decodeStringArrayValue(args[0], 'paths');
        const requestId = decodeOptionalStringValue(args[1], 'requestId');
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
                requestId ?? '',
                options,
            ];
        }
        return requestId === undefined ? [paths] : [
            paths,
            requestId,
        ];
    },
    () => [
        ['/tmp/document.pdf'],
        'open-1',
    ],
);
const cancelOpenBatchArgs = documentArgs<'cancelOpenDocumentDirectBatch'>(
    value => decodeSingleStringArgs<'cancelOpenDocumentDirectBatch'>(value, 'requestId'),
    () => ['open-1'],
);
const createWorkingCopyFromDataArgs = documentArgs<'createWorkingCopyFromData'>(
    (value) => {
        const args = decodeArgumentArray(value, 2, 3);
        return appendOptional([
            decodeStringValue(args[0], 'fileName'),
            decodeUint8ArrayValue(args[1], 'data'),
        ], decodeOptionalStringValue(args[2], 'originalPath'));
    },
    () => [
        'document.pdf',
        Uint8Array.of(1),
    ],
);
const createWorkingCopyFromPathArgs = documentArgs<'createWorkingCopyFromPath'>(
    (value) => {
        const args = decodeArgumentArray(value, 1, 2);
        return appendOptional(
            [decodeStringValue(args[0], 'sourcePath')],
            decodeOptionalStringValue(args[1], 'originalPath'),
        );
    },
    () => ['/tmp/source.pdf'],
);
const savePdfAsArgs = documentArgs<'savePdfAs'>(
    (value) => {
        const args = decodeArgumentArray(value, 2, 3);
        return appendOptional([
            decodeStringValue(args[0], 'workingPath'),
            decodeSaveAsOptions(args[1]),
        ], decodeRevisionOptions(args[2])) as TDocumentMethodArgs<'savePdfAs'>;
    },
    () => [
        '/tmp/working.pdf',
        undefined,
        fixtureRevisionOptions,
    ],
);
const savePdfDialogArgs = documentArgs<'savePdfDialog'>(
    value => decodeSingleStringArgs<'savePdfDialog'>(value, 'suggestedName'),
    () => ['document.pdf'],
);
const pathArgs = (fieldName: string) => s.fromParser<[string]>(
    (value) => {
        const args = decodeArgumentArray(value, 1);
        return [decodeStringValue(args[0], fieldName)];
    },
    () => ['/tmp/document.pdf'],
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
            decodeStringValue(args[0], 'path'),
            decodeSafeIntegerValue(args[1], 'offset'),
            decodeSafeIntegerValue(args[2], 'length'),
        ];
    },
    () => [
        '/tmp/document.pdf',
        0,
        1,
    ],
);
const managedHandleArgs = documentArgs<'createManagedTempFileHandle'>(
    value => decodeSingleStringArgs<'createManagedTempFileHandle'>(value, 'path'),
    () => ['/tmp/document.pdf'],
);
const releaseManagedHandleArgs = documentArgs<'releaseManagedTempFileHandle'>(
    value => decodeSingleStringArgs<'releaseManagedTempFileHandle'>(value, 'leaseId'),
    () => ['lease-1'],
);
const openingGeometryArgs = documentArgs<'getPdfOpeningGeometry'>(
    value => decodeSingleStringArgs<'getPdfOpeningGeometry'>(value, 'path'),
    () => ['/tmp/document.pdf'],
);
const pageSizesArgs = documentArgs<'getPdfNativePageSizes'>(
    value => decodeSingleStringArgs<'getPdfNativePageSizes'>(value, 'path'),
    () => ['/tmp/document.pdf'],
);
const cancelPagePreviewArgs = documentArgs<'cancelPdfNativePagePreview'>(
    value => decodeSingleStringArgs<'cancelPdfNativePagePreview'>(value, 'requestId'),
    () => ['preview-1'],
);
const pagePreviewArgs = documentArgs<'renderPdfNativePagePreview'>(
    (value) => {
        const args = decodeArgumentArray(value, 2, 3);
        return appendOptional([
            decodeStringValue(args[0], 'path'),
            decodeSafeIntegerValue(args[1], 'pageNumber', 1),
        ], decodePreviewOptions(args[2])) as TDocumentMethodArgs<'renderPdfNativePagePreview'>;
    },
    () => [
        '/tmp/document.pdf',
        1,
    ],
);
const readTextFileArgs = documentArgs<'readTextFile'>(
    value => decodeSingleStringArgs<'readTextFile'>(value, 'path'),
    () => ['/tmp/document.txt'],
);
const fileExistsArgs = documentArgs<'fileExists'>(
    value => decodeSingleStringArgs<'fileExists'>(value, 'path'),
    () => ['/tmp/document.pdf'],
);
const documentRevisionArgs = documentArgs<'getDocumentRevision'>(
    value => decodeSingleStringArgs<'getDocumentRevision'>(value, 'path'),
    () => ['/tmp/document.pdf'],
);
const writeFileArgs = documentArgs<'writeFile'>(
    (value) => {
        const args = decodeArgumentArray(value, 2, 3);
        return appendOptional([
            decodeStringValue(args[0], 'path'),
            decodeUint8ArrayValue(args[1], 'data'),
        ], decodeRevisionOptions(args[2])) as TDocumentMethodArgs<'writeFile'>;
    },
    () => [
        '/tmp/document.pdf',
        Uint8Array.of(1),
        fixtureRevisionOptions,
    ],
);
const replaceWorkingCopyArgs = documentArgs<'replaceWorkingCopyFromPath'>(
    (value) => {
        const args = decodeArgumentArray(value, 2, 3);
        return appendOptional([
            decodeStringValue(args[0], 'workingCopyPath'),
            decodeStringValue(args[1], 'sourcePath'),
        ], decodeRevisionOptions(args[2])) as TDocumentMethodArgs<'replaceWorkingCopyFromPath'>;
    },
    () => [
        '/tmp/working.pdf',
        '/tmp/source.pdf',
        fixtureRevisionOptions,
    ],
);
const writeDocxArgs = documentArgs<'writeDocxFile'>(
    (value) => {
        const args = decodeArgumentArray(value, 2);
        return [
            decodeStringValue(args[0], 'path'),
            decodeUint8ArrayValue(args[1], 'data'),
        ];
    },
    () => [
        '/tmp/document.docx',
        Uint8Array.of(1),
    ],
);
const saveFileStructuredArgs = documentArgs<'saveFileStructured'>(
    (value) => {
        const args = decodeArgumentArray(value, 1, 2);
        return appendOptional(
            [decodeStringValue(args[0], 'path')],
            decodeRevisionOptions(args[1]),
        ) as TDocumentMethodArgs<'saveFileStructured'>;
    },
    () => [
        '/tmp/working.pdf',
        fixtureRevisionOptions,
    ],
);
const repairPdfArgs = documentArgs<'repairPdf'>(
    value => saveFileStructuredArgs.decode(value),
    () => [
        '/tmp/working.pdf',
        fixtureRevisionOptions,
    ],
);
const optimizeInteractionArgs = documentArgs<'optimizePdfForInteraction'>(
    value => saveFileStructuredArgs.decode(value),
    () => [
        '/tmp/working.pdf',
        fixtureRevisionOptions,
    ],
);
const optimizeAsCopyArgs = documentArgs<'optimizePdfAsCopy'>(
    (value) => {
        const args = decodeArgumentArray(value, 2, 4);
        const base: [string, IPdfOptimizeOptions] = [
            decodeStringValue(args[0], 'path'),
            decodeOptimizeOptions(args[1]),
        ];
        const requestId = decodeOptionalStringValue(args[2], 'requestId');
        if (requestId === undefined) {
            return base;
        }
        return appendOptional([
            ...base,
            requestId,
        ], decodeRevisionOptions(args[3])) as TDocumentMethodArgs<'optimizePdfAsCopy'>;
    },
    () => [
        '/tmp/working.pdf',
        {preset: 'lossless'},
        'optimize-1',
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
            decodeStringValue(args[0], 'path'),
            args[1] as TDocumentMethodArgs<'savePdfNoteTextUpdates'>[1],
            decodeStringValue(args[2], 'modifiedAt'),
        ], decodeRevisionOptions(args[3])) as TDocumentMethodArgs<'savePdfNoteTextUpdates'>;
    },
    () => [
        '/tmp/working.pdf',
        [],
        '2026-01-01T00:00:00.000Z',
        fixtureRevisionOptions,
    ],
);
const nativeNoteChangesArgs = documentArgs<'savePdfNoteChanges'>(
    (value) => {
        const args = decodeArgumentArray(value, 3, 4);
        return appendOptional([
            decodeStringValue(args[0], 'path'),
            decodeRequiredObject<TDocumentMethodArgs<'savePdfNoteChanges'>[1]>(args[1], 'changes'),
            decodeStringValue(args[2], 'modifiedAt'),
        ], decodeRevisionOptions(args[3])) as TDocumentMethodArgs<'savePdfNoteChanges'>;
    },
    () => [
        '/tmp/working.pdf',
        {},
        '2026-01-01T00:00:00.000Z',
        fixtureRevisionOptions,
    ],
);
const nativeMutationsArgs = documentArgs<'savePdfNativeMutations'>(
    (value) => {
        const args = decodeArgumentArray(value, 3, 4);
        return appendOptional([
            decodeStringValue(args[0], 'path'),
            decodeRequiredObject<TDocumentMethodArgs<'savePdfNativeMutations'>[1]>(args[1], 'mutations'),
            decodeStringValue(args[2], 'modifiedAt'),
        ], decodeRevisionOptions(args[3])) as TDocumentMethodArgs<'savePdfNativeMutations'>;
    },
    () => [
        '/tmp/working.pdf',
        {},
        '2026-01-01T00:00:00.000Z',
        fixtureRevisionOptions,
    ],
);
const applyNativeMutationsArgs = documentArgs<'applyPdfNativeMutationsToWorkingCopy'>(
    (value) => {
        const args = decodeArgumentArray(value, 4, 5);
        return appendOptional([
            decodeStringValue(args[0], 'path'),
            decodeRequiredObject<TDocumentMethodArgs<'applyPdfNativeMutationsToWorkingCopy'>[1]>(args[1], 'mutations'),
            decodeStringValue(args[2], 'modifiedAt'),
            decodeRequiredObject<IPdfNativeWorkingCopyExpectation>(args[3], 'expectedBase'),
        ], decodeRevisionOptions(args[4])) as TDocumentMethodArgs<'applyPdfNativeMutationsToWorkingCopy'>;
    },
    () => [
        '/tmp/working.pdf',
        {},
        '2026-01-01T00:00:00.000Z',
        {
            byteLength: 1,
            sha256: '0'.repeat(64),
        },
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
            decodeStringValue(args[0], 'path'),
            stagedOutput,
        ], decodeRevisionOptions(args[2]) as IPdfNativeStagedCommitOptions | undefined);
        return decoded as TDocumentMethodArgs<'commitStagedPdfNativeMutations'>;
    },
    () => [
        '/tmp/working.pdf',
        {
            receiptVersion: 1,
            artifactKind: 'pdf',
            path: '/tmp/staged.pdf',
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
            leaseId: 'lease-1',
            revision: null,
        },
        fixtureRevisionOptions,
    ],
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
const pdfPathArgs = documentArgs<'analyzePdfConformance'>(
    value => decodeSingleStringArgs<'analyzePdfConformance'>(value, 'path'),
    () => ['/tmp/document.pdf'],
);
const openPdfPathArgs = documentArgs<'openPdfInDefaultAppPath'>(
    (value) => {
        const args = decodeArgumentArray(value, 1, 2);
        return appendOptional(
            [decodeStringValue(args[0], 'path')],
            decodeOptionalStringValue(args[1], 'fileName'),
        );
    },
    () => ['/tmp/document.pdf'],
);
const printPdfPathArgs = documentArgs<'printPdfPath'>(
    (value) => {
        const args = decodeArgumentArray(value, 1, 3);
        const path = decodeStringValue(args[0], 'path');
        const fileName = decodeOptionalStringValue(args[1], 'fileName');
        if (fileName === undefined) {
            return [path];
        }
        const pages = args[2] === undefined
            ? undefined
            : decodePositiveIntegerArrayValue(args[2], 'pageNumbers');
        return pages === undefined ? [
            path,
            fileName,
        ] : [
            path,
            fileName,
            pages,
        ];
    },
    () => ['/tmp/document.pdf'],
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
        path: '/tmp/document.pdf',
        size: 1,
        sha256: '0'.repeat(64),
        leaseId: 'lease-1',
        revision: null,
    }),
);
const openingGeometryResult = documentResult<'getPdfOpeningGeometry'>(
    value => value === null ? null : decodeOpeningGeometry(value),
    () => ({
        pageNumber: 1,
        pageCount: 1,
        width: 612,
        height: 792,
        rotation: 0,
        size: 1,
        modifiedAt: 0,
    }),
);
const pageSizesResult = documentResult<'getPdfNativePageSizes'>(
    decodePageSizesResult,
    () => [{
        width: 612,
        height: 792,
    }],
);
const cancelPagePreviewResult = documentResult<'cancelPdfNativePagePreview'>(
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
        documentRef: '/tmp/document.pdf',
        authority: 'electron-working-copy',
        contentRevision: 1,
        mintedAt: 1,
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
    cancelPagePreviewArgs,
    cancelPagePreviewResult,
    commitNativeMutationsArgs,
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
    printPdfPathArgs,
    readFileArgs,
    readFileRangeArgs,
    readTextFileArgs,
    recentFilesResult,
    releaseManagedHandleArgs,
    repairPdfArgs,
    replaceWorkingCopyArgs,
    revisionResult,
    saveFileStructuredArgs,
    savePdfAsArgs,
    savePdfDialogArgs,
    showItemResult,
    statFileArgs,
    validationResult,
    writeDocxArgs,
    writeFileArgs,
};
export type {
    TDocumentMethodArgs,
    TDocumentMethodResult,
};
