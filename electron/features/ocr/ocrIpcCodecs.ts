import type {
    IOcrErrorEnvelope,
    IOcrCancelResult,
    IOcrRecognizeRequest,
    IOcrSearchablePdfOptions,
    IOcrJobProjectionState,
    IOcrToolValidationResult,
} from '@contracts/electronApiOcr';
import {
    OCR_ERROR_CODES,
    OCR_PROGRESS_PHASES,
} from '@contracts/electronApiOcr';
import type { TIpcCodecMap } from '@contracts/ipcMain';
import { decodeOcrLanguages } from '@contracts/ocrLanguages';
import { decodeDocumentTextSnapshot } from '@contracts/documentTextCatalog';
import { parseDocumentRevisionToken } from '@contracts/documentRevision';
import {
    isFiniteNumber,
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import {
    OCR_CHANNELS,
    type IOcrInvokeMap,
} from '@electron/features/ocr/contract';
import {
    decodeBoundedArray,
    decodeBooleanArg,
    decodeSafeIntegerArg,
    decodeStringArg,
    decodeStringArrayArg,
    decodeUint8ArrayArg,
} from '@electron/platform-ipc/ipcArgumentValidation';

import {
    decodeNoArgs,
    decodeUndefinedResult,
    requireDecoded,
} from '@electron/platform-ipc/ipcCodecValidation';

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

function decodeOptionalErrorFields(value: Record<PropertyKey, unknown>) {
    if (value.error !== undefined && typeof value.error !== 'string') {
        throw new Error('error must be a string');
    }
    const errorEnvelope = decodeOcrErrorEnvelope(value.errorEnvelope);
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

export const OCR_IPC_CODECS = {
    [OCR_CHANNELS.recognize]: {
        decodeArgs: (args: readonly unknown[]) => [decodeRecognizeRequest(args[0])],
        decodeResult: decodeRecognizeResult,
    },
    [OCR_CHANNELS.recognizeBatch]: {
        decodeArgs: (args: readonly unknown[]) => [
            decodeRecognizeRequests(args[0]),
            decodeStringArg(args, 1, 'requestId'),
        ],
        decodeResult: decodeRecognizeBatchResult,
    },
    [OCR_CHANNELS.createSearchablePdf]: {
        decodeArgs: (args: readonly unknown[]) => {
            const requiredArgs: [string, Array<{
                pageNumber: number;
                languages: string[]
            }>, string] = [
                decodeStringArg(args, 0, 'sourcePdfPath'),
                decodeSearchablePdfPages(args[1]),
                decodeStringArg(args, 2, 'requestId'),
            ];
            const options = decodeSearchablePdfOptions(args[3]);
            return options === undefined ? requiredArgs : [
                ...requiredArgs,
                options,
            ];
        },
        decodeResult: decodeJobStartResult,
    },
    [OCR_CHANNELS.cancel]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'requestId')],
        decodeResult: decodeCancelResult,
    },
    [OCR_CHANNELS.getJobState]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'requestId')],
        decodeResult: decodeOcrJobProjection,
    },
    [OCR_CHANNELS.subscribeJob]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'requestId')],
        decodeResult: decodeOcrJobProjection,
    },
    [OCR_CHANNELS.reconnectJob]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'requestId')],
        decodeResult: decodeOcrJobProjection,
    },
    [OCR_CHANNELS.acknowledgeResultFile]: {
        decodeArgs: (args: readonly unknown[]) => [
            decodeStringArg(args, 0, 'requestId'),
            args[1] === undefined ? undefined : decodeStringArg(args, 1, 'pdfPath'),
        ],
        decodeResult: decodeAckResult,
    },
    [OCR_CHANNELS.getLanguages]: {
        decodeArgs: decodeNoArgs,
        decodeResult: (value: unknown) => requireDecoded(value, decodeOcrLanguages, 'OCR languages'),
    },
    [OCR_CHANNELS.resolveDocumentTextCatalog]: {
        decodeArgs: (args: readonly unknown[]) => {
            const documentRevision = parseDocumentRevisionToken(args[1]);
            if (documentRevision === null) {
                throw new Error('documentRevision must be a valid revision token');
            }
            const required: [string, typeof documentRevision] = [
                decodeStringArg(args, 0, 'workingCopyPath'),
                documentRevision,
            ];
            return args[2] === undefined
                ? required
                : [
                    ...required,
                    decodeSafeIntegerArg(args, 2, 'pageCount', 0),
                ];
        },
        decodeResult: (value: unknown) => requireDecoded(
            value,
            decodeDocumentTextSnapshot,
            'DocumentTextCatalog snapshot',
        ),
    },
    [OCR_CHANNELS.validateTools]: {
        decodeArgs: decodeNoArgs,
        decodeResult: decodeToolValidationResult,
    },
    [OCR_CHANNELS.preprocessingValidate]: {
        decodeArgs: decodeNoArgs,
        decodeResult: decodePreprocessingValidation,
    },
    [OCR_CHANNELS.preprocessingPreprocessPage]: {
        decodeArgs: (args: readonly unknown[]) => [
            decodeUint8ArrayArg(args, 0, 'imageData'),
            decodeBooleanArg(args, 1, 'usePreprocessing'),
        ],
        decodeResult: decodePreprocessPageResult,
    },
    [OCR_CHANNELS.subscribeProgress]: {
        decodeArgs: decodeNoArgs,
        decodeResult: decodeUndefinedResult,
    },
} satisfies TIpcCodecMap<IOcrInvokeMap>;
