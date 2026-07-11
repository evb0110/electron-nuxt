import type {
    IDjvuConvertOptions,
    IDjvuPagePreviewOptions,
    IDjvuPrintOptions,
    IDjvuProgress,
    TDocumentOutputJobState,
} from '@contracts/electronApiDjvu';
import type { TIpcCodecMap } from '@contracts/ipcMain';
import {
    isFiniteNumber,
    isRecord,
} from '@contracts/runtimeGuards';
import {
    DJVU_CHANNELS,
    type IDjvuInvokeMap,
} from '@electron/features/djvu/contract';
import {
    decodePositiveIntegerArrayArg,
    decodeSafeIntegerArg,
    decodeStringArg,
} from '@electron/platform-ipc/ipcArgumentValidation';
import {
    decodeNoArgs,
    decodeUndefinedResult,
    decodeUint8ArrayResult,
} from '@electron/platform-ipc/ipcCodecValidation';

function decodeOptionalPositiveInteger(value: unknown, fieldName: string) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${fieldName} must be a positive safe integer`);
    }
    return value;
}

function decodeOptionalString(value: unknown, fieldName: string) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new Error(`${fieldName} must be a string`);
    }
    return value;
}

function decodePdfStrategy(value: unknown) {
    if (value === undefined) {
        return undefined;
    }
    if (value !== 'direct' && value !== 'compact-djvu-aware' && value !== 'auto') {
        throw new Error('pdfStrategy is invalid');
    }
    return value;
}

function decodeConvertOptions(value: unknown): IDjvuConvertOptions {
    if (!isRecord(value)) {
        throw new Error('convert options must be an object');
    }
    const subsample = decodeOptionalPositiveInteger(value.subsample, 'subsample');
    const pdfStrategy = decodePdfStrategy(value.pdfStrategy);
    const requestId = decodeOptionalString(value.requestId, 'requestId');
    const jobId = decodeOptionalString(value.jobId, 'jobId');
    const documentRef = decodeOptionalString(value.documentRef, 'documentRef');
    if (value.preserveBookmarks !== undefined && typeof value.preserveBookmarks !== 'boolean') {
        throw new Error('preserveBookmarks must be a boolean');
    }
    return {
        ...(subsample === undefined ? {} : {subsample}),
        ...(value.preserveBookmarks === undefined ? {} : {preserveBookmarks: value.preserveBookmarks}),
        ...(pdfStrategy === undefined ? {} : {pdfStrategy}),
        ...(requestId === undefined ? {} : {requestId}),
        ...(jobId === undefined ? {} : {jobId}),
        ...(documentRef === undefined ? {} : {documentRef}),
    };
}

function decodePrintOptions(value: unknown): IDjvuPrintOptions {
    if (
        !isRecord(value)
        || (value.viewMode !== 'single' && value.viewMode !== 'facing' && value.viewMode !== 'facing-first-single')
        || (value.orientation !== 'auto' && value.orientation !== 'portrait' && value.orientation !== 'landscape')
    ) {
        throw new Error('print options are invalid');
    }
    const fileName = decodeOptionalString(value.fileName, 'fileName');
    const requestId = decodeOptionalString(value.requestId, 'requestId');
    const subsample = decodeOptionalPositiveInteger(value.subsample, 'subsample');
    const pdfStrategy = decodePdfStrategy(value.pdfStrategy);
    let pageNumbers: number[] | undefined;
    if (value.pageNumbers !== undefined) {
        pageNumbers = decodePositiveIntegerArrayArg([value.pageNumbers], 0, 'pageNumbers');
    }
    return {
        viewMode: value.viewMode,
        orientation: value.orientation,
        ...(fileName === undefined ? {} : {fileName}),
        ...(pageNumbers === undefined ? {} : {pageNumbers}),
        ...(requestId === undefined ? {} : {requestId}),
        ...(subsample === undefined ? {} : {subsample}),
        ...(pdfStrategy === undefined ? {} : {pdfStrategy}),
    };
}

function decodePreviewOptions(value: unknown): IDjvuPagePreviewOptions | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isRecord(value)) {
        throw new Error('preview options must be an object');
    }
    const previewPriority = value.previewPriority;
    if (previewPriority !== undefined && !isFiniteNumber(previewPriority)) {
        throw new Error('previewPriority must be finite');
    }
    const previewRequestId = decodeOptionalString(value.previewRequestId, 'previewRequestId');
    const subsample = decodeOptionalPositiveInteger(value.subsample, 'subsample');
    const targetWidthPx = decodeOptionalPositiveInteger(value.targetWidthPx, 'targetWidthPx');
    return {
        ...(previewPriority === undefined ? {} : {previewPriority}),
        ...(previewRequestId === undefined ? {} : {previewRequestId}),
        ...(subsample === undefined ? {} : {subsample}),
        ...(targetWidthPx === undefined ? {} : {targetWidthPx}),
    };
}

function decodeOptionalResultString(value: unknown, fieldName: string) {
    return decodeOptionalString(value, fieldName);
}

function decodeSuccessResult(value: unknown): Record<PropertyKey, unknown> & {success: boolean} {
    if (!isRecord(value) || typeof value.success !== 'boolean') {
        throw new Error('result must include success');
    }
    return {
        ...value,
        success: value.success,
    };
}

function decodeOpenResult(value: unknown) {
    const result = decodeSuccessResult(value);
    const jobId = decodeOptionalResultString(result.jobId, 'jobId');
    const error = decodeOptionalResultString(result.error, 'error');
    const pageCount = decodeOptionalPositiveInteger(result.pageCount, 'pageCount');
    return {
        success: result.success,
        ...(pageCount === undefined ? {} : {pageCount}),
        ...(jobId === undefined ? {} : {jobId}),
        ...(error === undefined ? {} : {error}),
    };
}

function decodeJobStartHandle(value: unknown) {
    if (!isRecord(value) || typeof value.jobId !== 'string' || typeof value.requestId !== 'string') {
        throw new Error('invalid DjVu job start handle');
    }
    return {
        jobId: value.jobId,
        requestId: value.requestId,
    };
}

function decodeConvertResult(value: unknown) {
    const result = decodeSuccessResult(value);
    const pdfPath = decodeOptionalResultString(result.pdfPath, 'pdfPath');
    const jobId = decodeOptionalResultString(result.jobId, 'jobId');
    const requestId = decodeOptionalResultString(result.requestId, 'requestId');
    const documentRef = decodeOptionalResultString(result.documentRef, 'documentRef');
    const error = decodeOptionalResultString(result.error, 'error');
    return {
        success: result.success,
        ...(pdfPath === undefined ? {} : {pdfPath}),
        ...(jobId === undefined ? {} : {jobId}),
        ...(requestId === undefined ? {} : {requestId}),
        ...(documentRef === undefined ? {} : {documentRef}),
        ...(error === undefined ? {} : {error}),
    };
}

function decodePrintResult(value: unknown) {
    const result = decodeSuccessResult(value);
    const jobId = decodeOptionalResultString(result.jobId, 'jobId');
    const error = decodeOptionalResultString(result.error, 'error');
    if (result.canceled !== undefined && typeof result.canceled !== 'boolean') {
        throw new Error('canceled must be a boolean');
    }
    return {
        success: result.success,
        ...(result.canceled === undefined ? {} : {canceled: result.canceled}),
        ...(jobId === undefined ? {} : {jobId}),
        ...(error === undefined ? {} : {error}),
    };
}

function decodeCanceledResult(value: unknown) {
    if (!isRecord(value) || typeof value.canceled !== 'boolean') {
        throw new Error('result must include canceled');
    }
    return {canceled: value.canceled};
}

function decodeJobProgress(value: unknown): IDjvuProgress {
    if (
        !isRecord(value)
        || typeof value.jobId !== 'string'
        || !isFiniteNumber(value.percent)
        || ![
            'converting',
            'bookmarks',
            'optimizing',
            'loading',
            'printing',
        ].includes(String(value.phase))
    ) {
        throw new Error('invalid document output progress');
    }
    return {
        jobId: value.jobId,
        phase: value.phase as IDjvuProgress['phase'],
        percent: value.percent,
        ...(typeof value.requestId === 'string' ? {requestId: value.requestId} : {}),
        ...(typeof value.documentRef === 'string' ? {documentRef: value.documentRef} : {}),
        ...(isFiniteNumber(value.current) ? {current: value.current} : {}),
        ...(isFiniteNumber(value.total) ? {total: value.total} : {}),
        ...(value.status === 'running' || value.status === 'success' || value.status === 'canceled' || value.status === 'failed'
            ? {status: value.status}
            : {}),
        ...(typeof value.error === 'string' ? {error: value.error} : {}),
    };
}

function decodeJobState(value: unknown): TDocumentOutputJobState | null {
    if (value === null) {
        return null;
    }
    if (
        !isRecord(value)
        || typeof value.jobId !== 'string'
        || (value.operation !== 'djvu-convert' && value.operation !== 'djvu-print')
        || ![
            'queued',
            'running',
            'handoff',
            'completed',
            'canceled',
            'failed',
        ].includes(String(value.status))
        || !isFiniteNumber(value.updatedAtMs)
    ) {
        throw new Error('invalid document output job state');
    }
    const progress = decodeJobProgress(value.progress);
    if (value.status === 'handoff') {
        if (typeof value.artifactPath !== 'string') throw new Error('handoff state requires artifactPath');
        return {
            jobId: value.jobId,
            operation: value.operation,
            status: 'handoff',
            artifactPath: value.artifactPath,
            progress,
            updatedAtMs: value.updatedAtMs,
        };
    }
    if (value.status === 'completed') {
        return {
            jobId: value.jobId,
            operation: value.operation,
            status: 'completed',
            ...(typeof value.artifactPath === 'string' ? {artifactPath: value.artifactPath} : {}),
            progress,
            updatedAtMs: value.updatedAtMs,
        };
    }
    if (value.status === 'failed' || value.status === 'canceled') {
        return {
            jobId: value.jobId,
            operation: value.operation,
            status: value.status,
            ...(typeof value.error === 'string' ? {error: value.error} : {}),
            progress,
            updatedAtMs: value.updatedAtMs,
        };
    }
    return {
        jobId: value.jobId,
        operation: value.operation,
        status: value.status === 'queued' ? 'queued' : 'running',
        progress,
        updatedAtMs: value.updatedAtMs,
    };
}

function decodeInfoResult(value: unknown) {
    if (
        !isRecord(value)
        || typeof value.pageCount !== 'number'
        || !Number.isSafeInteger(value.pageCount)
        || value.pageCount < 0
        || !isFiniteNumber(value.sourceDpi)
        || typeof value.hasBookmarks !== 'boolean'
        || typeof value.hasText !== 'boolean'
        || !isRecord(value.metadata)
        || Object.values(value.metadata).some(item => typeof item !== 'string')
    ) {
        throw new Error('invalid DjVu info result');
    }
    const metadata: Record<string, string> = {};
    for (const [
        key,
        item,
    ] of Object.entries(value.metadata)) {
        if (typeof item !== 'string') {
            throw new Error('invalid DjVu metadata');
        }
        metadata[key] = item;
    }
    return {
        pageCount: value.pageCount,
        sourceDpi: value.sourceDpi,
        hasBookmarks: value.hasBookmarks,
        hasText: value.hasText,
        metadata,
    };
}

function decodePageSize(value: unknown) {
    if (!isRecord(value) || !isFiniteNumber(value.width) || !isFiniteNumber(value.height) || !isFiniteNumber(value.dpi)) {
        throw new Error('invalid DjVu page size');
    }
    return {
        width: value.width,
        height: value.height,
        dpi: value.dpi,
    };
}

function decodePageSizesResult(value: unknown) {
    if (!Array.isArray(value)) {
        throw new Error('page sizes must be an array');
    }
    return value.map(decodePageSize);
}

function decodePagePreviewResult(value: unknown) {
    if (!isRecord(value) || !isFiniteNumber(value.width) || !isFiniteNumber(value.height)) {
        throw new Error('invalid DjVu page preview');
    }
    return {
        bytes: decodeUint8ArrayResult(value.bytes),
        width: value.width,
        height: value.height,
    };
}

function decodeSizeEstimate(value: unknown) {
    if (
        !isRecord(value)
        || typeof value.subsample !== 'number'
        || !Number.isSafeInteger(value.subsample)
        || value.subsample < 1
        || typeof value.label !== 'string'
        || typeof value.description !== 'string'
        || !isFiniteNumber(value.resultingDpi)
        || typeof value.estimatedBytes !== 'number'
        || !Number.isSafeInteger(value.estimatedBytes)
        || value.estimatedBytes < 0
    ) {
        throw new Error('invalid DjVu size estimate');
    }
    return {
        subsample: value.subsample,
        label: value.label,
        description: value.description,
        resultingDpi: value.resultingDpi,
        estimatedBytes: value.estimatedBytes,
    };
}

function decodeSizeEstimatesResult(value: unknown) {
    if (!Array.isArray(value)) {
        throw new Error('size estimates must be an array');
    }
    return value.map(decodeSizeEstimate);
}

export const DJVU_IPC_CODECS = {
    [DJVU_CHANNELS.startOpenForViewing]: {
        decodeArgs: (args: readonly unknown[]) => [
            decodeStringArg(args, 0, 'djvuPath'),
            decodeStringArg(args, 1, 'requestId'),
        ],
        decodeResult: decodeJobStartHandle,
    },
    [DJVU_CHANNELS.awaitOpenJob]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'jobId')],
        decodeResult: decodeOpenResult,
    },
    [DJVU_CHANNELS.openForViewing]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'djvuPath')],
        decodeResult: decodeOpenResult,
    },
    [DJVU_CHANNELS.releaseViewingPath]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'djvuPath')],
        decodeResult: decodeUndefinedResult,
    },
    [DJVU_CHANNELS.convertToPdf]: {
        decodeArgs: (args: readonly unknown[]) => [
            decodeStringArg(args, 0, 'djvuPath'),
            decodeStringArg(args, 1, 'outputPath'),
            decodeConvertOptions(args[2]),
        ],
        decodeResult: decodeConvertResult,
    },
    [DJVU_CHANNELS.startConvertToPdf]: {
        decodeArgs: (args: readonly unknown[]) => [
            decodeStringArg(args, 0, 'djvuPath'),
            decodeStringArg(args, 1, 'outputPath'),
            decodeConvertOptions(args[2]),
        ],
        decodeResult: decodeJobStartHandle,
    },
    [DJVU_CHANNELS.awaitConvertJob]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'jobId')],
        decodeResult: decodeConvertResult,
    },
    [DJVU_CHANNELS.printDjvuPath]: {
        decodeArgs: (args: readonly unknown[]) => [
            decodeStringArg(args, 0, 'djvuPath'),
            decodePrintOptions(args[1]),
        ],
        decodeResult: decodePrintResult,
    },
    [DJVU_CHANNELS.cancel]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'jobId')],
        decodeResult: decodeCanceledResult,
    },
    [DJVU_CHANNELS.getJobState]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'jobId')],
        decodeResult: decodeJobState,
    },
    [DJVU_CHANNELS.subscribeJob]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'jobId')],
        decodeResult: decodeJobState,
    },
    [DJVU_CHANNELS.cancelPagePreview]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'requestId')],
        decodeResult: decodeCanceledResult,
    },
    [DJVU_CHANNELS.getInfo]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'djvuPath')],
        decodeResult: decodeInfoResult,
    },
    [DJVU_CHANNELS.getPageSizes]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'djvuPath')],
        decodeResult: decodePageSizesResult,
    },
    [DJVU_CHANNELS.renderPagePreview]: {
        decodeArgs: (args: readonly unknown[]) => [
            decodeStringArg(args, 0, 'djvuPath'),
            decodeSafeIntegerArg(args, 1, 'pageNumber', 1),
            decodePreviewOptions(args[2]),
        ],
        decodeResult: decodePagePreviewResult,
    },
    [DJVU_CHANNELS.estimateSizes]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'djvuPath')],
        decodeResult: decodeSizeEstimatesResult,
    },
    [DJVU_CHANNELS.cleanupTemp]: {
        decodeArgs: (args: readonly unknown[]) => [decodeStringArg(args, 0, 'tempPdfPath')],
        decodeResult: decodeUndefinedResult,
    },
    [DJVU_CHANNELS.subscribeProgress]: {
        decodeArgs: decodeNoArgs,
        decodeResult: decodeUndefinedResult,
    },
} satisfies TIpcCodecMap<IDjvuInvokeMap>;
