import type {
    IOcrCancelResult,
    IOcrCompleteResult,
    IOcrDiagnostic,
    IOcrErrorEnvelope,
    IOcrJobProjectionState,
    IOcrJobStartResult,
    IOcrRecognizeBatchResult,
    IOcrProgress,
    IOcrRecognizeRequest,
    IOcrRecognizeResult,
    IOcrResultFileAckResult,
    IOcrSearchablePdfOptions,
    IOcrToolValidationResult,
    IPreprocessingValidationResult,
    IPreprocessPageResult,
} from '@contracts/electronApiOcr';
import {
    OCR_COMPLETE_EVENT_CHANNEL,
    OCR_DIAGNOSTIC_CODES,
    OCR_ERROR_CODES,
    OCR_PROGRESS_EVENT_CHANNEL,
    OCR_PROGRESS_PHASES,
} from '@contracts/electronApiOcr';
import {
    decodeDocumentOcrAvailability,
    decodeDocumentOcrPageSnapshot,
    decodeDocumentTextSnapshot,
    type IDocumentOcrAvailability,
    type IDocumentOcrPageSnapshot,
    type IDocumentTextSnapshot,
} from '@contracts/documentTextCatalog';
import type { TDocumentRef } from '@contracts/documentRef';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {
    assertAbsolutePath,
    assertNonEmptyString,
    assertOptionalAbsolutePath,
} from '@contracts/ipcAssertions';
import { decodeOcrLanguages } from '@contracts/ocrLanguages';
import {
    definePlatformFeature,
    runtimeSchema as s,
    type IRuntimeSchema,
    type TFeatureCapability,
    type TFeatureEventMap,
    type TFeatureInvokeMap,
} from '@contracts/platformFeature';
import {
    isFiniteNumber,
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import type { IOcrLanguage } from '@contracts/shared';

const MAX_COLLECTION_ITEMS = 100_000;
const OCR_NATIVE_IPC_TIMEOUT_MS = 30 * 60 * 1_000;
const OCR_REQUEST_ID_MAX_LENGTH = 128;
const OMITTED_BROWSER_METHOD = {
    unsupported: 'omitted',
    reason: 'not-implemented',
} as const;

function requireArgs(args: readonly unknown[], count: number | {
    min: number;
    max: number
}) {
    const min = typeof count === 'number' ? count : count.min;
    const max = typeof count === 'number' ? count : count.max;
    if (args.length < min || args.length > max) {
        const expected = min === max ? String(min) : `${min}-${max}`;
        throw new Error(`expected ${expected} arguments, received ${args.length}`);
    }
    return args;
}

function decodeStringArg(args: readonly unknown[], index: number, fieldName: string) {
    return assertNonEmptyString(args[index], fieldName);
}

function decodeSafeIntegerArg(
    args: readonly unknown[],
    index: number,
    fieldName: string,
    min = 0,
) {
    const value = args[index];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
        throw new Error(`${fieldName} must be a safe integer >= ${min}`);
    }
    return value;
}

function decodeStringArrayArg(args: readonly unknown[], index: number, fieldName: string) {
    const value = args[index];
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        throw new Error(`${fieldName} must be an array of strings`);
    }
    return value as string[];
}

function decodeUint8ArrayArg(args: readonly unknown[], index: number, fieldName: string) {
    const value = args[index];
    if (!(value instanceof Uint8Array)) {
        throw new Error(`${fieldName} must be a Uint8Array`);
    }
    return value;
}

function decodeBoundedArray(value: unknown, fieldName: string) {
    if (!Array.isArray(value)) {
        throw new Error(`${fieldName} must be an array`);
    }
    if (value.length > MAX_COLLECTION_ITEMS) {
        throw new Error(`${fieldName} exceeds maximum item count (${MAX_COLLECTION_ITEMS})`);
    }
    return value.map((item: unknown) => item);
}

function requireDecoded<T>(
    value: unknown,
    decode: (candidate: unknown) => T | null,
    label: string,
) {
    const decoded = decode(value);
    if (decoded === null) {
        throw new Error(`invalid ${label} IPC result`);
    }
    return decoded;
}

function argsSchema<TArgs extends unknown[]>(
    decode: (args: readonly unknown[]) => TArgs,
    example: () => TArgs,
) {
    return s.declared<TArgs>()(s.fromParser((value) => {
        if (!Array.isArray(value)) {
            throw new Error('expected IPC arguments');
        }
        return decode(value);
    }, example));
}

function resultSchema<TResult>(
    decode: (value: unknown) => TResult,
    example: () => TResult,
) {
    return s.declared<TResult>()(s.fromParser(decode, example));
}

const OCR_JOB_STATUSES = [
    'queued',
    'running',
    'handoff',
    'completed',
    'canceled',
    'failed',
] as const;
const OCR_JOB_PHASES = [
    ...OCR_PROGRESS_PHASES,
    'queued',
    'recognizing',
    'applying',
    'cancel-requested',
] as const;

function decodeOcrErrorEnvelope(value: unknown): IOcrErrorEnvelope | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (
        !isRecord(value)
        || !isOneOf(OCR_ERROR_CODES, value.code)
        || typeof value.message !== 'string'
        || typeof value.retryable !== 'boolean'
        || !isFiniteNumber(value.timestamp)
        || (value.details !== undefined && typeof value.details !== 'string')
    ) {
        throw new Error('invalid OCR error envelope');
    }
    return {
        code: value.code,
        message: value.message,
        retryable: value.retryable,
        timestamp: value.timestamp,
        ...(value.details === undefined ? {} : {details: value.details}),
    };
}

const optionalOcrErrorEnvelope = s.declared<IOcrErrorEnvelope | undefined>()(
    s.fromParser(decodeOcrErrorEnvelope, () => undefined),
);

function decodeOptionalErrorFields(value: Record<PropertyKey, unknown>) {
    if (value.error !== undefined && typeof value.error !== 'string') {
        throw new Error('error must be a string');
    }
    const errorEnvelope = optionalOcrErrorEnvelope.decode(value.errorEnvelope);
    return {
        ...(value.error === undefined ? {} : {error: value.error}),
        ...(errorEnvelope === undefined ? {} : {errorEnvelope}),
    };
}

function decodeRecognizeRequest(value: unknown): IOcrRecognizeRequest {
    if (!isRecord(value)) {
        throw new Error('OCR recognize request must be an object');
    }
    const pageNumber = decodeSafeIntegerArg([value.pageNumber], 0, 'pageNumber', 1);
    const imageData = decodeUint8ArrayArg([value.imageData], 0, 'imageData');
    const languages = decodeStringArrayArg([value.languages], 0, 'languages');
    const imageWidth = value.imageWidth === undefined
        ? undefined
        : decodeSafeIntegerArg([value.imageWidth], 0, 'imageWidth', 1);
    const imageHeight = value.imageHeight === undefined
        ? undefined
        : decodeSafeIntegerArg([value.imageHeight], 0, 'imageHeight', 1);
    return {
        pageNumber,
        imageData,
        languages,
        ...(imageWidth === undefined ? {} : {imageWidth}),
        ...(imageHeight === undefined ? {} : {imageHeight}),
    };
}

function decodeRecognizeRequests(value: unknown) {
    return decodeBoundedArray(value, 'OCR pages').map(decodeRecognizeRequest);
}

function decodeSearchablePdfPages(value: unknown) {
    return decodeBoundedArray(value, 'OCR searchable PDF pages').map((page) => {
        if (!isRecord(page)) {
            throw new Error('OCR searchable PDF page must be an object');
        }
        return {
            pageNumber: decodeSafeIntegerArg([page.pageNumber], 0, 'pageNumber', 1),
            languages: decodeStringArrayArg([page.languages], 0, 'languages'),
        };
    });
}

function decodeSearchablePdfOptions(value: unknown): number | IOcrSearchablePdfOptions | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value === 'number') {
        return decodeSafeIntegerArg([value], 0, 'renderDpi', 1);
    }
    if (!isRecord(value)) {
        throw new Error('OCR searchable PDF options must be an object');
    }
    const renderDpi = value.renderDpi === undefined
        ? undefined
        : decodeSafeIntegerArg([value.renderDpi], 0, 'renderDpi', 1);
    const pageSegmentationMode = value.pageSegmentationMode === undefined
        ? undefined
        : decodeSafeIntegerArg([value.pageSegmentationMode], 0, 'pageSegmentationMode', 0);
    if (
        value.qualityProfile !== undefined
        && value.qualityProfile !== 'balanced'
        && value.qualityProfile !== 'accurate'
        && value.qualityProfile !== 'poor-scan'
    ) {
        throw new Error('invalid OCR quality profile');
    }
    if (
        value.preprocessingMode !== undefined
        && value.preprocessingMode !== 'off'
        && value.preprocessingMode !== 'clean'
    ) {
        throw new Error('invalid OCR preprocessing mode');
    }
    if (
        value.supersessionPolicy !== undefined
        && value.supersessionPolicy !== 'missing-only'
        && value.supersessionPolicy !== 'replace-evb'
        && value.supersessionPolicy !== 'replace-all'
    ) {
        throw new Error('invalid OCR supersession policy');
    }
    if (value.replaceAllAcknowledged !== undefined && typeof value.replaceAllAcknowledged !== 'boolean') {
        throw new Error('invalid OCR replace-all acknowledgement');
    }
    if (value.supersessionPolicy === 'replace-all' && value.replaceAllAcknowledged !== true) {
        throw new Error('replace-all OCR requires acknowledgement');
    }
    return {
        ...(renderDpi === undefined ? {} : {renderDpi}),
        ...(value.qualityProfile === undefined ? {} : {qualityProfile: value.qualityProfile}),
        ...(value.preprocessingMode === undefined ? {} : {preprocessingMode: value.preprocessingMode}),
        ...(pageSegmentationMode === undefined ? {} : {pageSegmentationMode}),
        ...(value.supersessionPolicy === undefined ? {} : {supersessionPolicy: value.supersessionPolicy}),
        ...(value.replaceAllAcknowledged === undefined ? {} : {replaceAllAcknowledged: value.replaceAllAcknowledged}),
    };
}

function decodeRecognizeResult(value: unknown) {
    if (
        !isRecord(value)
        || !Number.isSafeInteger(value.pageNumber)
        || typeof value.pageNumber !== 'number'
        || value.pageNumber < 1
        || typeof value.success !== 'boolean'
        || typeof value.text !== 'string'
    ) {
        throw new Error('invalid OCR recognize result');
    }
    return {
        pageNumber: value.pageNumber,
        success: value.success,
        text: value.text,
        ...decodeOptionalErrorFields(value),
    };
}

function decodeRecognizeBatchResult(value: unknown) {
    if (!isRecord(value) || !isRecord(value.results) || !Array.isArray(value.errors)) {
        throw new Error('invalid OCR batch result');
    }
    const results: Record<number, string> = {};
    for (const [
        pageNumber,
        text,
    ] of Object.entries(value.results)) {
        if (!/^\d+$/u.test(pageNumber) || typeof text !== 'string') {
            throw new Error('invalid OCR batch result entry');
        }
        results[Number(pageNumber)] = text;
    }
    if (value.errors.some(error => typeof error !== 'string')) {
        throw new Error('invalid OCR batch errors');
    }
    return {
        results,
        errors: value.errors.map(String),
        ...decodeOptionalErrorFields(value),
    };
}

function decodeJobStartResult(value: unknown) {
    if (
        !isRecord(value)
        || typeof value.started !== 'boolean'
        || typeof value.jobId !== 'string'
        || (value.installed !== undefined && (!Array.isArray(value.installed) || value.installed.some(item => typeof item !== 'string')))
        || (value.errors !== undefined && (!Array.isArray(value.errors) || value.errors.some(item => typeof item !== 'string')))
    ) {
        throw new Error('invalid OCR job result');
    }
    return {
        started: value.started,
        jobId: value.jobId,
        ...(value.installed === undefined ? {} : {installed: value.installed.map(String)}),
        ...(value.errors === undefined ? {} : {errors: value.errors.map(String)}),
        ...decodeOptionalErrorFields(value),
    };
}

function decodeCancelResult(value: unknown): IOcrCancelResult {
    if (
        !isRecord(value)
        || typeof value.canceled !== 'boolean'
        || (
            value.reason !== undefined
            && value.reason !== 'invalid-request'
            && value.reason !== 'not-found'
            && value.reason !== 'failed'
        )
    ) {
        throw new Error('invalid OCR cancellation result');
    }
    const reason: IOcrCancelResult['reason'] = value.reason;
    return {
        canceled: value.canceled,
        ...(reason === undefined ? {} : {reason}),
        ...decodeOptionalErrorFields(value),
    };
}

function decodeAckResult(value: unknown) {
    if (!isRecord(value) || typeof value.cleaned !== 'boolean') {
        throw new Error('invalid OCR result file acknowledgement');
    }
    return {
        cleaned: value.cleaned,
        ...decodeOptionalErrorFields(value),
    };
}

function decodeToolEntry(value: unknown, name: string): {
    found: boolean;
    path: string;
    version?: string;
    languages?: string[];
    onDemandLanguages?: string[];
} {
    if (!isRecord(value) || typeof value.found !== 'boolean' || typeof value.path !== 'string') {
        throw new Error(`invalid ${name} tool status`);
    }
    if (value.version !== undefined && typeof value.version !== 'string') {
        throw new Error(`invalid ${name} tool version`);
    }
    let languages: string[] | undefined;
    if (value.languages !== undefined) {
        if (!Array.isArray(value.languages) || value.languages.some(item => typeof item !== 'string')) {
            throw new Error(`invalid ${name} tool languages`);
        }
        languages = value.languages.map(item => String(item));
    }
    let onDemandLanguages: string[] | undefined;
    if (value.onDemandLanguages !== undefined) {
        if (!Array.isArray(value.onDemandLanguages) || value.onDemandLanguages.some(item => typeof item !== 'string')) {
            throw new Error(`invalid ${name} tool on-demand languages`);
        }
        onDemandLanguages = value.onDemandLanguages.map(item => String(item));
    }
    return {
        found: value.found,
        path: value.path,
        ...(value.version === undefined ? {} : {version: value.version}),
        ...(languages === undefined ? {} : {languages}),
        ...(onDemandLanguages === undefined ? {} : {onDemandLanguages}),
    };
}

function decodeToolValidationResult(value: unknown): IOcrToolValidationResult {
    if (!isRecord(value) || typeof value.valid !== 'boolean' || !isRecord(value.tools) || !Array.isArray(value.errors)) {
        throw new Error('invalid OCR tool validation result');
    }
    const tesseract = decodeToolEntry(value.tools.tesseract, 'tesseract');
    const tessdata = decodeToolEntry(value.tools.tessdata, 'tessdata');
    const pdftoppm = decodeToolEntry(value.tools.pdftoppm, 'pdftoppm');
    const pdftotext = decodeToolEntry(value.tools.pdftotext, 'pdftotext');
    const qpdf = decodeToolEntry(value.tools.qpdf, 'qpdf');
    const popplerRuntime = value.tools.popplerRuntime;
    if (
        !isRecord(popplerRuntime)
        || typeof popplerRuntime.dataDirFound !== 'boolean'
        || (popplerRuntime.dataDir !== undefined && typeof popplerRuntime.dataDir !== 'string')
        || typeof popplerRuntime.fontConfigDirFound !== 'boolean'
        || (popplerRuntime.fontConfigDir !== undefined && typeof popplerRuntime.fontConfigDir !== 'string')
        || value.errors.some(error => typeof error !== 'string')
    ) {
        throw new Error('invalid OCR tool validation details');
    }
    const errors = value.errors.map(error => String(error));
    return {
        valid: value.valid,
        tools: {
            tesseract: {
                found: tesseract.found,
                path: tesseract.path,
                ...(tesseract.version === undefined ? {} : {version: tesseract.version}),
            },
            tessdata: {
                found: tessdata.found,
                path: tessdata.path,
                ...(tessdata.languages === undefined ? {} : {languages: [...tessdata.languages]}),
                ...(tessdata.onDemandLanguages === undefined ? {} : {onDemandLanguages: [...tessdata.onDemandLanguages]}),
            },
            pdftoppm: {
                found: pdftoppm.found,
                path: pdftoppm.path,
            },
            pdftotext: {
                found: pdftotext.found,
                path: pdftotext.path,
            },
            popplerRuntime: {
                dataDirFound: popplerRuntime.dataDirFound,
                ...(popplerRuntime.dataDir === undefined ? {} : {dataDir: popplerRuntime.dataDir}),
                fontConfigDirFound: popplerRuntime.fontConfigDirFound,
                ...(popplerRuntime.fontConfigDir === undefined ? {} : {fontConfigDir: popplerRuntime.fontConfigDir}),
            },
            qpdf: {
                found: qpdf.found,
                path: qpdf.path,
            },
        },
        errors,
        ...decodeOptionalErrorFields(value),
    };
}

function decodePreprocessingValidation(value: unknown) {
    if (
        !isRecord(value)
        || typeof value.valid !== 'boolean'
        || !Array.isArray(value.available)
        || value.available.some(item => typeof item !== 'string')
        || !Array.isArray(value.missing)
        || value.missing.some(item => typeof item !== 'string')
    ) {
        throw new Error('invalid preprocessing validation result');
    }
    return {
        valid: value.valid,
        available: value.available.map(String),
        missing: value.missing.map(String),
        ...decodeOptionalErrorFields(value),
    };
}

function decodeOcrJobProjection(value: unknown) {
    if (value === null) {
        return null;
    }
    if (
        !isRecord(value)
        || typeof value.jobId !== 'string'
        || typeof value.requestId !== 'string'
        || !isOneOf(OCR_JOB_STATUSES, value.status)
        || !isOneOf(OCR_JOB_PHASES, value.phase)
        || typeof value.percent !== 'number'
        || !Number.isFinite(value.percent)
        || typeof value.updatedAtMs !== 'number'
        || !Number.isFinite(value.updatedAtMs)
        || (value.current !== undefined && !isFiniteNumber(value.current))
        || (value.total !== undefined && !isFiniteNumber(value.total))
        || (value.error !== undefined && typeof value.error !== 'string')
        || (
            value.supersessionPolicy !== undefined
            && value.supersessionPolicy !== 'missing-only'
            && value.supersessionPolicy !== 'replace-evb'
            && value.supersessionPolicy !== 'replace-all'
        )
        || (value.replaceAllAcknowledged !== undefined && typeof value.replaceAllAcknowledged !== 'boolean')
    ) {
        throw new Error('invalid OCR job projection');
    }
    const projection: IOcrJobProjectionState = {
        jobId: value.jobId,
        requestId: value.requestId,
        status: value.status,
        phase: value.phase,
        percent: value.percent,
        updatedAtMs: value.updatedAtMs,
        ...(value.current === undefined ? {} : {current: value.current}),
        ...(value.total === undefined ? {} : {total: value.total}),
        ...(value.error === undefined ? {} : {error: value.error}),
        ...(value.supersessionPolicy === undefined ? {} : {supersessionPolicy: value.supersessionPolicy}),
        ...(value.replaceAllAcknowledged === undefined ? {} : {replaceAllAcknowledged: value.replaceAllAcknowledged}),
    };
    return projection;
}

function decodePreprocessPageResult(value: unknown) {
    if (!isRecord(value) || typeof value.success !== 'boolean' || !(value.imageData instanceof Uint8Array)) {
        throw new Error('invalid preprocess page result');
    }
    if (value.message !== undefined && typeof value.message !== 'string') {
        throw new Error('invalid preprocess page message');
    }
    return {
        success: value.success,
        imageData: value.imageData,
        ...(value.message === undefined ? {} : {message: value.message}),
        ...decodeOptionalErrorFields(value),
    };
}

function buildMalformedCompleteResult(
    requestId: string,
    message = 'Malformed OCR completion payload',
): IOcrCompleteResult {
    return {
        requestId,
        success: false,
        errors: [message],
        errorEnvelope: {
            code: 'OCR_INVALID_PAYLOAD',
            message,
            retryable: false,
            timestamp: Date.now(),
        },
    };
}

function decodeOcrProgress(payload: unknown): IOcrProgress | null {
    if (
        !isRecord(payload)
        || typeof payload.requestId !== 'string'
        || !isFiniteNumber(payload.currentPage)
        || !isFiniteNumber(payload.processedCount)
        || !isFiniteNumber(payload.totalPages)
    ) {
        return null;
    }
    if (
        payload.phase !== undefined
        && (
            typeof payload.phase !== 'string'
            || !isOneOf(OCR_PROGRESS_PHASES, payload.phase)
        )
    ) {
        return null;
    }
    if (payload.phaseProgress !== undefined && !isFiniteNumber(payload.phaseProgress)) {
        return null;
    }
    if (payload.activePages !== undefined && (
        !Array.isArray(payload.activePages)
        || payload.activePages.some(page => !isFiniteNumber(page))
    )) {
        return null;
    }
    if (payload.languageCode !== undefined && typeof payload.languageCode !== 'string') {
        return null;
    }
    if (
        payload.status !== undefined
        && payload.status !== 'running'
        && payload.status !== 'success'
        && payload.status !== 'canceled'
        && payload.status !== 'failed'
    ) {
        return null;
    }
    if (payload.error !== undefined && typeof payload.error !== 'string') {
        return null;
    }

    return {
        requestId: payload.requestId,
        currentPage: payload.currentPage,
        processedCount: payload.processedCount,
        totalPages: payload.totalPages,
        ...(payload.phase === undefined ? {} : {phase: payload.phase}),
        ...(payload.phaseProgress === undefined ? {} : {phaseProgress: payload.phaseProgress}),
        ...(payload.activePages === undefined ? {} : {activePages: payload.activePages as number[]}),
        ...(payload.languageCode === undefined ? {} : {languageCode: payload.languageCode}),
        ...(payload.status === undefined ? {} : {status: payload.status}),
        ...(payload.error === undefined ? {} : {error: payload.error}),
    };
}

function decodeOcrDiagnostics(value: unknown): IOcrDiagnostic[] | null | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value)) {
        return null;
    }
    const diagnostics: IOcrDiagnostic[] = [];
    for (const diagnostic of value) {
        if (
            !isRecord(diagnostic)
            || !isOneOf(OCR_DIAGNOSTIC_CODES, diagnostic.code)
            || (diagnostic.severity !== 'info' && diagnostic.severity !== 'warning')
            || typeof diagnostic.message !== 'string'
            || (diagnostic.pageNumber !== undefined && (
                typeof diagnostic.pageNumber !== 'number'
                || !Number.isSafeInteger(diagnostic.pageNumber)
                || diagnostic.pageNumber < 1
            ))
        ) {
            return null;
        }
        diagnostics.push({
            code: diagnostic.code,
            severity: diagnostic.severity,
            message: diagnostic.message,
            ...(diagnostic.pageNumber === undefined ? {} : {pageNumber: diagnostic.pageNumber}),
        });
    }
    return diagnostics;
}

function decodeOcrEventErrorEnvelope(payload: unknown): IOcrErrorEnvelope | null {
    if (
        !isRecord(payload)
        || !isOneOf(OCR_ERROR_CODES, payload.code)
        || typeof payload.message !== 'string'
        || typeof payload.retryable !== 'boolean'
        || !isFiniteNumber(payload.timestamp)
    ) {
        return null;
    }
    if (payload.details !== undefined && typeof payload.details !== 'string') {
        return null;
    }

    return {
        code: payload.code,
        message: payload.message,
        retryable: payload.retryable,
        timestamp: payload.timestamp,
        ...(payload.details === undefined ? {} : {details: payload.details}),
    };
}

const ocrEventErrorEnvelope = s.declared<IOcrErrorEnvelope>()(
    s.fromNullableDecoder(
        decodeOcrEventErrorEnvelope,
        'OCR error envelope',
        () => ({
            code: 'OCR_INTERNAL_ERROR',
            message: 'OCR failed',
            retryable: false,
            timestamp: 0,
        }),
    ),
);

function decodeOcrCompleteResult(payload: unknown): IOcrCompleteResult | null {
    if (!isRecord(payload)) {
        return null;
    }
    if (typeof payload.requestId !== 'string') {
        return null;
    }

    if (
        typeof payload.success !== 'boolean'
        || !Array.isArray(payload.errors)
        || payload.errors.some(error => typeof error !== 'string')
    ) {
        return buildMalformedCompleteResult(payload.requestId);
    }
    if (payload.pdfPath !== undefined && typeof payload.pdfPath !== 'string') {
        return buildMalformedCompleteResult(payload.requestId);
    }
    const sourceDocumentRevisionToken = payload.sourceDocumentRevisionToken === undefined
        ? undefined
        : parseDocumentRevisionToken(payload.sourceDocumentRevisionToken);
    if (sourceDocumentRevisionToken === null) {
        return buildMalformedCompleteResult(payload.requestId);
    }
    if (payload.requiresCleanupAck !== undefined && typeof payload.requiresCleanupAck !== 'boolean') {
        return buildMalformedCompleteResult(payload.requestId);
    }
    const resultSha256 = payload.resultSha256 === undefined
        ? undefined
        : typeof payload.resultSha256 === 'string' && /^[a-f0-9]{64}$/u.test(payload.resultSha256)
            ? payload.resultSha256
            : null;
    if (resultSha256 === null) {
        return buildMalformedCompleteResult(payload.requestId);
    }
    if (
        payload.success
        && (
            typeof payload.pdfPath !== 'string'
            || payload.pdfPath.trim().length === 0
            || sourceDocumentRevisionToken === undefined
            || resultSha256 === undefined
            || typeof payload.requiresCleanupAck !== 'boolean'
        )
    ) {
        return buildMalformedCompleteResult(payload.requestId);
    }
    let errorEnvelope: IOcrErrorEnvelope | null = null;
    if (payload.errorEnvelope !== undefined) {
        try {
            errorEnvelope = ocrEventErrorEnvelope.decode(payload.errorEnvelope);
        } catch {
            return buildMalformedCompleteResult(
                payload.requestId,
                'Malformed OCR completion error envelope',
            );
        }
    }
    const errors = payload.errors.map(error => error as string);
    const diagnostics = decodeOcrDiagnostics(payload.diagnostics);
    if (diagnostics === null) {
        return buildMalformedCompleteResult(
            payload.requestId,
            'Malformed OCR completion diagnostics',
        );
    }

    return {
        requestId: payload.requestId,
        success: payload.success,
        errors,
        ...(diagnostics === undefined ? {} : {diagnostics}),
        ...(payload.pdfPath === undefined ? {} : {pdfPath: payload.pdfPath}),
        ...(sourceDocumentRevisionToken === undefined ? {} : {sourceDocumentRevisionToken}),
        ...(resultSha256 === undefined ? {} : {resultSha256}),
        ...(payload.requiresCleanupAck === undefined ? {} : {requiresCleanupAck: payload.requiresCleanupAck}),
        ...(errorEnvelope === null ? {} : {errorEnvelope}),
    };
}

interface IOcrSearchablePdfPage {
    pageNumber: number;
    languages: string[]
}
type TOcrCreateSearchablePdfArgs = [
    sourcePdfPath: string,
    pages: IOcrSearchablePdfPage[],
    requestId: string,
    renderDpiOrOptions?: number | IOcrSearchablePdfOptions,
];
type TOcrAcknowledgeResultFileArgs = [requestId: string, pdfPath?: TDocumentRef];
type TResolveDocumentTextCatalogArgs =
    [workingCopyPath: TDocumentRef, documentRevision: TDocumentRevisionToken, pageCount?: number];

function decodeDocumentRevisionArg(
    args: readonly unknown[],
    index: number,
    fieldName = 'documentRevision',
) {
    const documentRevision = parseDocumentRevisionToken(args[index]);
    if (documentRevision === null) {
        throw new Error(`${fieldName} must be a valid revision token`);
    }
    return documentRevision;
}

const recognizeArgs = argsSchema<[IOcrRecognizeRequest]>(
    args => [decodeRecognizeRequest(requireArgs(args, 1)[0])],
    () => [{
        pageNumber: 1,
        imageData: new Uint8Array([1]),
        languages: ['eng'],
    }],
);
const recognizeBatchArgs = argsSchema<[IOcrRecognizeRequest[], string]>(
    (args) => {
        requireArgs(args, 2);
        return [
            decodeRecognizeRequests(args[0]),
            decodeStringArg(args, 1, 'requestId'),
        ];
    },
    () => [
        [{
            pageNumber: 1,
            imageData: new Uint8Array([1]),
            languages: ['eng'],
        }],
        'ocr-batch-fixture',
    ],
);
const createSearchablePdfArgs = argsSchema<TOcrCreateSearchablePdfArgs>(
    (args) => {
        requireArgs(args, {
            min: 3,
            max: 4,
        });
        const requiredArgs: [
            string,
            IOcrSearchablePdfPage[],
            string,
        ] = [
            assertAbsolutePath(
                args[0],
                'ocrCreateSearchablePdf.sourcePdfPath',
            ),
            decodeSearchablePdfPages(args[1]),
            assertRequestId(
                args[2],
                'ocrCreateSearchablePdf.requestId',
            ),
        ];
        const options = decodeSearchablePdfOptions(args[3]);
        return options === undefined
            ? requiredArgs
            : [
                ...requiredArgs,
                options,
            ];
    },
    () => [
        '/tmp/ocr-fixture.pdf',
        [{
            pageNumber: 1,
            languages: ['eng'],
        }],
        'ocr-searchable-pdf-fixture',
        {renderDpi: 300},
    ],
);
const requestIdArgs = argsSchema<[string]>(
    args => [assertRequestId(requireArgs(args, 1)[0], 'requestId')],
    () => ['ocr-request-fixture'],
);
const acknowledgeResultFileArgs = argsSchema<TOcrAcknowledgeResultFileArgs>(
    (args) => {
        requireArgs(args, {
            min: 1,
            max: 2,
        });
        const requestId = assertRequestId(
            args[0],
            'ocrAcknowledgeResultFile.requestId',
        );
        const pdfPath = assertOptionalAbsolutePath(
            args[1],
            'ocrAcknowledgeResultFile.pdfPath',
        );
        return pdfPath === undefined
            ? [requestId]
            : [
                requestId,
                pdfPath,
            ];
    },
    () => [
        'ocr-request-fixture',
        '/tmp/ocr-result-fixture.pdf',
    ],
);
const resolveDocumentTextCatalogArgs = argsSchema<TResolveDocumentTextCatalogArgs>(
    (args) => {
        requireArgs(args, {
            min: 2,
            max: 3,
        });
        const requiredArgs: [
            TDocumentRef,
            TDocumentRevisionToken,
        ] = [
            assertAbsolutePath(
                args[0],
                'resolveDocumentTextCatalog.workingCopyPath',
            ),
            decodeDocumentRevisionArg(
                args,
                1,
                'resolveDocumentTextCatalog.documentRevision',
            ),
        ];
        return args[2] === undefined
            ? requiredArgs
            : [
                ...requiredArgs,
                decodeSafeIntegerArg(args, 2, 'pageCount', 0),
            ];
    },
    () => [
        '/tmp/ocr-fixture.pdf',
        parseDocumentRevisionToken('drt1:ocr-fixture')!,
        1,
    ],
);
const resolveDocumentOcrAvailabilityArgs = argsSchema<[
    TDocumentRef,
    TDocumentRevisionToken,
]>(
    (args) => {
        requireArgs(args, 2);
        return [
            assertAbsolutePath(
                args[0],
                'resolveDocumentOcrAvailability.workingCopyPath',
            ),
            decodeDocumentRevisionArg(
                args,
                1,
                'resolveDocumentOcrAvailability.documentRevision',
            ),
        ];
    },
    () => [
        '/tmp/ocr-fixture.pdf',
        parseDocumentRevisionToken('drt1:ocr-fixture')!,
    ],
);
const resolveDocumentOcrPageArgs = argsSchema<[
    TDocumentRef,
    TDocumentRevisionToken,
    number,
]>(
    (args) => {
        requireArgs(args, 3);
        return [
            assertAbsolutePath(
                args[0],
                'resolveDocumentOcrPage.workingCopyPath',
            ),
            decodeDocumentRevisionArg(
                args,
                1,
                'resolveDocumentOcrPage.documentRevision',
            ),
            decodeSafeIntegerArg(args, 2, 'pageNumber', 1),
        ];
    },
    () => [
        '/tmp/ocr-fixture.pdf',
        parseDocumentRevisionToken('drt1:ocr-fixture')!,
        1,
    ],
);
const preprocessPageArgs = argsSchema<[Uint8Array, boolean]>(
    (args) => {
        requireArgs(args, 2);
        if (typeof args[1] !== 'boolean') {
            throw new Error('usePreprocessing must be a boolean');
        }
        return [
            decodeUint8ArrayArg(args, 0, 'imageData'),
            args[1],
        ];
    },
    () => [
        new Uint8Array([1]),
        true,
    ],
);

const recognizeResult = resultSchema<IOcrRecognizeResult>(decodeRecognizeResult, () => ({
    pageNumber: 1,
    success: true,
    text: 'fixture',
}));
const recognizeBatchResult = resultSchema<IOcrRecognizeBatchResult>(decodeRecognizeBatchResult, () => ({
    results: {1: 'fixture'},
    errors: [],
}));
const jobStartResult = resultSchema<IOcrJobStartResult>(decodeJobStartResult, () => ({
    started: true,
    jobId: 'ocr-job-fixture',
}));
const cancelResult = resultSchema(decodeCancelResult, () => ({canceled: false}));
const jobProjectionResult =
    resultSchema<IOcrJobProjectionState | null>(decodeOcrJobProjection, () => null);
const acknowledgeResult =
    resultSchema<IOcrResultFileAckResult>(decodeAckResult, () => ({cleaned: true}));
const languagesResult = resultSchema<IOcrLanguage[]>(
    value => requireDecoded(value, decodeOcrLanguages, 'OCR languages'),
    () => [{
        code: 'eng',
        script: 'latin',
    }],
);
const documentTextCatalogResult = resultSchema<IDocumentTextSnapshot>(
    value => requireDecoded(
        value,
        decodeDocumentTextSnapshot,
        'DocumentTextCatalog snapshot',
    ),
    () => ({
        documentRevision: parseDocumentRevisionToken('drt1:ocr-fixture')!,
        pageCount: 0,
        pages: [],
        contentDigest: '',
    }),
);
const documentOcrAvailabilityResult = resultSchema<IDocumentOcrAvailability>(
    value => requireDecoded(
        value,
        decodeDocumentOcrAvailability,
        'document OCR availability',
    ),
    () => ({
        documentRevision: parseDocumentRevisionToken('drt1:ocr-fixture')!,
        pageCount: 0,
        pageNumbers: [],
    }),
);
const documentOcrPageResult = resultSchema<IDocumentOcrPageSnapshot>(
    value => requireDecoded(
        value,
        decodeDocumentOcrPageSnapshot,
        'document OCR page',
    ),
    () => ({
        documentRevision: parseDocumentRevisionToken('drt1:ocr-fixture')!,
        pageCount: 0,
        page: null,
    }),
);
const toolValidationResult = resultSchema<IOcrToolValidationResult>(
    decodeToolValidationResult,
    () => ({
        valid: true,
        tools: {
            tesseract: {
                found: true,
                path: '/tools/tesseract',
            },
            tessdata: {
                found: true,
                path: '/tools/tessdata',
                languages: ['eng'],
            },
            pdftoppm: {
                found: true,
                path: '/tools/pdftoppm',
            },
            pdftotext: {
                found: true,
                path: '/tools/pdftotext',
            },
            popplerRuntime: {
                dataDirFound: true,
                fontConfigDirFound: true,
            },
            qpdf: {
                found: true,
                path: '/tools/qpdf',
            },
        },
        errors: [],
    }),
);
const preprocessingValidationResult = resultSchema<IPreprocessingValidationResult>(
    decodePreprocessingValidation,
    () => ({
        valid: true,
        available: ['unpaper'],
        missing: [],
    }),
);
const preprocessPageResult = resultSchema<IPreprocessPageResult>(
    decodePreprocessPageResult,
    () => ({
        success: true,
        imageData: new Uint8Array([1]),
    }),
);
const progress = s.declared<IOcrProgress>()(
    s.fromNullableDecoder(decodeOcrProgress, 'OCR progress', () => ({
        requestId: 'ocr-request-fixture',
        currentPage: 1,
        processedCount: 0,
        totalPages: 1,
        status: 'running',
    })),
);
const completeResult = s.declared<IOcrCompleteResult>()(
    s.fromNullableDecoder(decodeOcrCompleteResult, 'OCR completion', () => ({
        requestId: 'ocr-request-fixture',
        success: false,
        errors: [],
    })),
);
const progressReplay = {
    owner: 'ipc-progress-pump',
    mode: 'latest-per-key',
    key: (payload: IOcrProgress) => payload.requestId,
    terminal: (payload: IOcrProgress) =>
        payload.status === 'success'
        || payload.status === 'canceled'
        || payload.status === 'failed',
    intervalMs: 50,
    terminalRetentionMs: 30_000,
} as const;

function assertRequestId(value: unknown, fieldName: string) {
    return assertNonEmptyString(value, fieldName, OCR_REQUEST_ID_MAX_LENGTH);
}

function defineOcrMethod<
    const TName extends string,
    const TChannel extends string,
    const TArgs extends IRuntimeSchema<unknown[]>,
    const TResult extends IRuntimeSchema<unknown>,
>(definition: {
    name: TName;
    channel: TChannel;
    args: TArgs;
    result: TResult;
    timeout?: boolean;
    optionalWhenImplemented?: boolean;
}) {
    return {
        kind: 'async',
        channel: definition.channel,
        ipc: {
            args: definition.args,
            result: definition.result,
            ...(definition.timeout ? {timeoutMs: OCR_NATIVE_IPC_TIMEOUT_MS} : {}),
        },
        main: {
            method: definition.name,
            context: 'sender',
        },
        browser: definition.optionalWhenImplemented
            ? OMITTED_BROWSER_METHOD
            : {method: definition.name},
        ...(definition.optionalWhenImplemented
            ? {
                optionalWhenImplemented: true,
                required: {
                    browser: false,
                    electron: false,
                },
            }
            : {}),
        lazy: 'forwarded',
    } as const;
}

export const OCR_PLATFORM_FEATURE = definePlatformFeature({
    path: ['ocr'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        recognize: defineOcrMethod({
            name: 'recognize',
            channel: 'ocr:recognize',
            args: recognizeArgs,
            result: recognizeResult,
            timeout: true,
        }),
        recognizeBatch: defineOcrMethod({
            name: 'recognizeBatch',
            channel: 'ocr:recognizeBatch',
            args: recognizeBatchArgs,
            result: recognizeBatchResult,
            timeout: true,
        }),
        cancel: defineOcrMethod({
            name: 'cancel',
            channel: 'ocr:cancel',
            args: requestIdArgs,
            result: cancelResult,
        }),
        getJobState: defineOcrMethod({
            name: 'getJobState',
            channel: 'ocr:job:get-state',
            args: requestIdArgs,
            result: jobProjectionResult,
            timeout: true,
        }),
        subscribeJob: defineOcrMethod({
            name: 'subscribeJob',
            channel: 'ocr:job:subscribe',
            args: requestIdArgs,
            result: jobProjectionResult,
            timeout: true,
        }),
        reconnectJob: defineOcrMethod({
            name: 'reconnectJob',
            channel: 'ocr:job:reconnect',
            args: requestIdArgs,
            result: jobProjectionResult,
            timeout: true,
        }),
        getLanguages: defineOcrMethod({
            name: 'getLanguages',
            channel: 'ocr:getLanguages',
            args: s.tuple([]),
            result: languagesResult,
        }),
        resolveDocumentTextCatalog: defineOcrMethod({
            name: 'resolveDocumentTextCatalog',
            channel: 'ocr:resolveDocumentTextCatalog',
            args: resolveDocumentTextCatalogArgs,
            result: documentTextCatalogResult,
            timeout: true,
        }),
        resolveDocumentOcrAvailability: defineOcrMethod({
            name: 'resolveDocumentOcrAvailability',
            channel: 'ocr:resolveDocumentOcrAvailability',
            args: resolveDocumentOcrAvailabilityArgs,
            result: documentOcrAvailabilityResult,
            timeout: true,
            optionalWhenImplemented: true,
        }),
        resolveDocumentOcrPage: defineOcrMethod({
            name: 'resolveDocumentOcrPage',
            channel: 'ocr:resolveDocumentOcrPage',
            args: resolveDocumentOcrPageArgs,
            result: documentOcrPageResult,
            timeout: true,
            optionalWhenImplemented: true,
        }),
        validateTools: defineOcrMethod({
            name: 'validateTools',
            channel: 'ocr:validateTools',
            args: s.tuple([]),
            result: toolValidationResult,
            timeout: true,
        }),
        acknowledgeResultFile: defineOcrMethod({
            name: 'acknowledgeResultFile',
            channel: 'ocr:ackResultFile',
            args: acknowledgeResultFileArgs,
            result: acknowledgeResult,
        }),
        createSearchablePdf: defineOcrMethod({
            name: 'createSearchablePdf',
            channel: 'ocr:createSearchablePdf',
            args: createSearchablePdfArgs,
            result: jobStartResult,
            timeout: true,
        }),
    },
    events: {
        onProgress: {
            kind: 'event',
            channel: OCR_PROGRESS_EVENT_CHANNEL,
            payload: progress,
            subscription: {
                channel: 'ocr:progress:subscribe',
                request: 'once-per-preload-event-channel',
                main: {
                    method: 'subscribeProgress',
                    context: 'sender',
                },
                replay: progressReplay,
            },
            browser: {method: 'onProgress'},
            lazy: 'forwarded',
        },
        onComplete: {
            kind: 'event',
            channel: OCR_COMPLETE_EVENT_CHANNEL,
            payload: completeResult,
            browser: {method: 'onComplete'},
            lazy: 'forwarded',
        },
    },
});

export const OCR_PREPROCESSING_PLATFORM_FEATURE = definePlatformFeature({
    path: [
        'ocr',
        'preprocessing',
    ],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        validate: defineOcrMethod({
            name: 'validate',
            channel: 'preprocessing:validate',
            args: s.tuple([]),
            result: preprocessingValidationResult,
            timeout: true,
        }),
        preprocessPage: defineOcrMethod({
            name: 'preprocessPage',
            channel: 'preprocessing:preprocessPage',
            args: preprocessPageArgs,
            result: preprocessPageResult,
            timeout: true,
        }),
    },
    events: {},
});

type TOcrFeatureCapability = TFeatureCapability<typeof OCR_PLATFORM_FEATURE>;
type TOcrHotReloadMethod = 'resolveDocumentOcrAvailability' | 'resolveDocumentOcrPage';

export type IOcrCapability =
    Omit<TOcrFeatureCapability, TOcrHotReloadMethod>
    & Partial<Pick<TOcrFeatureCapability, TOcrHotReloadMethod>>
    & {
        installLanguages: (languages: string[], requestId: string) => Promise<IOcrJobStartResult>;
        preprocessing: TFeatureCapability<typeof OCR_PREPROCESSING_PLATFORM_FEATURE>;
    };
export type IOcrInvokeMap =
    TFeatureInvokeMap<typeof OCR_PLATFORM_FEATURE>
    & TFeatureInvokeMap<typeof OCR_PREPROCESSING_PLATFORM_FEATURE>;
export type IOcrEventMap = TFeatureEventMap<typeof OCR_PLATFORM_FEATURE>;
