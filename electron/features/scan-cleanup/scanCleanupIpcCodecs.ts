import type { TIpcCodecMap } from '@contracts/ipcMain';
import { isRecord } from '@contracts/runtimeGuards';
import type {
    IScanCleanupProgress,
    IScanCleanupPreviewMetadata,
    IScanCleanupPreviewRequest,
    IScanCleanupPreviewResult,
    IScanCleanupStartRequest,
    IScanCleanupSummary,
    TScanCleanupErrorCode,
    TScanCleanupJobState,
} from '@contracts/electronApiScanCleanup';
import {
    SCAN_CLEANUP_CHANNELS,
    type IScanCleanupInvokeMap,
} from '@electron/features/scan-cleanup/contract';
import { requireIpcArgumentCount } from '@electron/platform-ipc/ipcCodecValidation';

const PREVIEW_MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const PREVIEW_MAX_TOTAL_BYTES = 96 * 1024 * 1024;

function decodeSourcePath(args: readonly unknown[]) {
    requireIpcArgumentCount(args, {
        min: 1,
        max: 1,
    });
    if (typeof args[0] !== 'string' || args[0].trim().length === 0) throw new Error('invalid scan-cleanup source path');
    return [args[0]] as [string];
}

function decodeJobId(args: readonly unknown[]) {
    requireIpcArgumentCount(args, {
        min: 1,
        max: 1,
    });
    const value = args[0];
    if (typeof value !== 'string' || value.trim().length === 0) throw new Error('invalid scan-cleanup job id');
    return [value] as [string];
}

function decodeOpenPdfPaths(args: readonly unknown[]) {
    requireIpcArgumentCount(args, {
        min: 1,
        max: 1,
    });
    if (!Array.isArray(args[0]) || args[0].some(path => typeof path !== 'string')) {
        throw new Error('invalid scan-cleanup open PDF paths');
    }
    return [args[0]] as [string[]];
}

function decodeOptions(options: unknown): IScanCleanupStartRequest['options'] {
    if (!isRecord(options)) throw new Error('invalid scan-cleanup options');
    if (
        ![
            'auto',
            'force-single',
            'force-two-page',
        ].includes(String(options.layoutMode))
        || ![
            'bw',
            'grayscale',
        ].includes(String(options.outputMode))
        || typeof options.thickness !== 'number'
        || !Number.isSafeInteger(options.thickness)
        || options.thickness < -5
        || options.thickness > 5
        || typeof options.crop !== 'boolean'
        || typeof options.matchPageSize !== 'boolean'
        || ![
            'top-left',
            'top-center',
            'top-right',
            'center-left',
            'center',
            'center-right',
            'bottom-left',
            'bottom-center',
            'bottom-right',
        ].includes(String(options.pageAlignment))
        || typeof options.despeckle !== 'boolean'
        || typeof options.marginsMm !== 'number'
        || !Number.isFinite(options.marginsMm)
        || options.marginsMm < 0
        || options.marginsMm > 25
    ) throw new Error('invalid scan-cleanup options');
    return {
        layoutMode: options.layoutMode as IScanCleanupStartRequest['options']['layoutMode'],
        outputMode: options.outputMode as IScanCleanupStartRequest['options']['outputMode'],
        thickness: options.thickness,
        crop: options.crop,
        matchPageSize: options.matchPageSize,
        pageAlignment: options.pageAlignment as IScanCleanupStartRequest['options']['pageAlignment'],
        marginsMm: options.marginsMm,
        despeckle: options.despeckle,
    };
}

function decodeStartRequest(value: unknown): IScanCleanupStartRequest {
    if (!isRecord(value) || typeof value.sourcePdfPath !== 'string') {
        throw new Error('invalid scan-cleanup request');
    }
    return {
        sourcePdfPath: value.sourcePdfPath,
        options: decodeOptions(value.options),
    };
}

function decodePreviewRequest(value: unknown): IScanCleanupPreviewRequest {
    if (
        !isRecord(value)
        || typeof value.sourcePdfPath !== 'string'
        || value.sourcePdfPath.trim().length === 0
        || !Number.isSafeInteger(value.pageNumber)
        || Number(value.pageNumber) < 1
    ) throw new Error('invalid scan-cleanup preview request');
    return {
        sourcePdfPath: value.sourcePdfPath,
        pageNumber: Number(value.pageNumber),
        options: decodeOptions(value.options),
    };
}

function decodePreviewArgs(args: readonly unknown[]) {
    requireIpcArgumentCount(args, {
        min: 1,
        max: 1,
    });
    return [decodePreviewRequest(args[0])] as [IScanCleanupPreviewRequest];
}

function decodePreviewBytes(value: unknown, label: string) {
    if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > PREVIEW_MAX_IMAGE_BYTES) {
        throw new Error(`invalid scan-cleanup preview ${label}`);
    }
    return value;
}

function decodePositiveInteger(value: unknown, label: string) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw new Error(`invalid scan-cleanup preview ${label}`);
    }
    return value;
}

function decodeFiniteNumber(value: unknown, label: string) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`invalid scan-cleanup preview ${label}`);
    }
    return value;
}

function decodePreviewRect(value: unknown, label: string) {
    if (!isRecord(value)) throw new Error(`invalid scan-cleanup preview ${label}`);
    const rect = {
        x: decodeFiniteNumber(value.x, `${label} x`),
        y: decodeFiniteNumber(value.y, `${label} y`),
        width: decodeFiniteNumber(value.width, `${label} width`),
        height: decodeFiniteNumber(value.height, `${label} height`),
    };
    if (rect.width < 0 || rect.height < 0) throw new Error(`invalid scan-cleanup preview ${label}`);
    return rect;
}

function decodePreviewAffine(value: unknown) {
    if (value === null) {
        return null;
    }
    if (
        !isRecord(value)
        || !Array.isArray(value.matrix)
        || value.matrix.length !== 3
        || value.matrix.some(row => !Array.isArray(row)
            || row.length !== 3
            || row.some(item => typeof item !== 'number' || !Number.isFinite(item)))
    ) throw new Error('invalid scan-cleanup preview affine');
    const rows = value.matrix as unknown[];
    return {matrix: rows.map((row, rowIndex) => (row as unknown[]).map((item, columnIndex) => (
        decodeFiniteNumber(item, `affine ${rowIndex}:${columnIndex}`)
    )))};
}

function decodePreviewMetadata(value: unknown): IScanCleanupPreviewMetadata {
    if (!isRecord(value)) throw new Error('invalid scan-cleanup preview metadata');
    if (
        ![
            'full',
            'left',
            'right',
        ].includes(String(value.half))
        || ![
            'single-uncut-page',
            'page-with-offcut',
            'two-page-spread',
        ].includes(String(value.layoutClassification))
        || !Array.isArray(value.appliedMargins)
        || value.appliedMargins.length !== 4
        || value.appliedMargins.some(item => typeof item !== 'number' || !Number.isFinite(item) || item < 0)
        || !Array.isArray(value.warnings)
        || value.warnings.some(item => typeof item !== 'string')
    ) throw new Error('invalid scan-cleanup preview metadata');
    return {
        half: value.half as IScanCleanupPreviewMetadata['half'],
        layoutClassification: value.layoutClassification as IScanCleanupPreviewMetadata['layoutClassification'],
        sourceRegion: decodePreviewRect(value.sourceRegion, 'source region'),
        contentBox: value.contentBox === null ? null : decodePreviewRect(value.contentBox, 'content box'),
        appliedMargins: value.appliedMargins as IScanCleanupPreviewMetadata['appliedMargins'],
        outputWidth: decodePositiveInteger(value.outputWidth, 'output width'),
        outputHeight: decodePositiveInteger(value.outputHeight, 'output height'),
        forwardTransform: decodePreviewAffine(value.forwardTransform),
        warnings: value.warnings as string[],
    };
}

export function decodeScanCleanupPreviewResult(value: unknown): IScanCleanupPreviewResult {
    if (
        !isRecord(value)
        || !Array.isArray(value.outputs)
        || value.outputs.length < 1
        || value.outputs.length > 2
    ) throw new Error('invalid scan-cleanup preview result');
    const rawImageData = decodePreviewBytes(value.rawImageData, 'raw image');
    let totalBytes = rawImageData.byteLength;
    const outputs = value.outputs.map(output => {
        if (!isRecord(output) || !isRecord(output.metadata)) throw new Error('invalid scan-cleanup preview output');
        const imageData = decodePreviewBytes(output.imageData, 'output image');
        totalBytes += imageData.byteLength;
        return {
            imageData,
            metadata: decodePreviewMetadata(output.metadata),
        };
    });
    if (totalBytes > PREVIEW_MAX_TOTAL_BYTES) throw new Error('invalid scan-cleanup preview total image bytes');
    const pageNumber = decodePositiveInteger(value.pageNumber, 'page number');
    const totalPages = decodePositiveInteger(value.totalPages, 'total pages');
    if (pageNumber > totalPages) throw new Error('invalid scan-cleanup preview page number');
    return {
        pageNumber,
        totalPages,
        rawImageData,
        rawWidth: decodePositiveInteger(value.rawWidth, 'raw width'),
        rawHeight: decodePositiveInteger(value.rawHeight, 'raw height'),
        outputs,
    };
}

function decodeStartArgs(args: readonly unknown[]) {
    requireIpcArgumentCount(args, {
        min: 1,
        max: 1,
    });
    return [decodeStartRequest(args[0])] as [IScanCleanupStartRequest];
}

function decodeStartResult(value: unknown) {
    if (!isRecord(value) || typeof value.started !== 'boolean' || typeof value.jobId !== 'string') throw new Error('invalid scan-cleanup start result');
    return {
        started: value.started,
        jobId: value.jobId,
        ...(typeof value.outputPdfPath === 'string' ? {outputPdfPath: value.outputPdfPath} : {}),
        ...(typeof value.error === 'string' ? {error: value.error} : {}),
        ...(typeof value.errorCode === 'string' ? {errorCode: value.errorCode as NonNullable<IScanCleanupInvokeMap[typeof SCAN_CLEANUP_CHANNELS.start]['result']['errorCode']>} : {}),
    };
}

function isScanCleanupPhase(value: unknown): value is IScanCleanupProgress['phase'] {
    return value === 'queued'
        || value === 'normalizing'
        || value === 'rasterizing'
        || value === 'cleaning'
        || value === 'assembling'
        || value === 'handoff';
}

function isScanCleanupErrorCode(value: unknown): value is TScanCleanupErrorCode {
    return value === 'invalid-request'
        || value === 'tools-unavailable'
        || value === 'sidecar-failed'
        || value === 'canceled'
        || value === 'internal';
}

function decodeProgress(value: unknown): IScanCleanupProgress {
    if (
        !isRecord(value)
        || !isScanCleanupPhase(value.phase)
        || typeof value.processedCount !== 'number'
        || !Number.isSafeInteger(value.processedCount)
        || value.processedCount < 0
        || typeof value.totalPages !== 'number'
        || !Number.isSafeInteger(value.totalPages)
        || value.totalPages < 0
        || typeof value.percent !== 'number'
        || !Number.isFinite(value.percent)
        || value.percent < 0
        || value.percent > 100
    ) throw new Error('invalid scan-cleanup progress');
    return {
        phase: value.phase,
        processedCount: value.processedCount,
        totalPages: value.totalPages,
        percent: value.percent,
    };
}

function decodeNonNegativeInteger(value: unknown, fieldName: string) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`invalid scan-cleanup ${fieldName}`);
    }
    return value;
}

function decodeSummary(value: unknown): IScanCleanupSummary {
    if (
        !isRecord(value)
        || !Array.isArray(value.warnings)
        || value.warnings.some(item => typeof item !== 'string')
    ) throw new Error('invalid scan-cleanup summary');
    return {
        inputPages: decodeNonNegativeInteger(value.inputPages, 'inputPages'),
        outputPages: decodeNonNegativeInteger(value.outputPages, 'outputPages'),
        spreadsSplit: decodeNonNegativeInteger(value.spreadsSplit, 'spreadsSplit'),
        offcutsDiscarded: decodeNonNegativeInteger(value.offcutsDiscarded, 'offcutsDiscarded'),
        deskewSkipped: decodeNonNegativeInteger(value.deskewSkipped, 'deskewSkipped'),
        cropSkipped: decodeNonNegativeInteger(value.cropSkipped, 'cropSkipped'),
        warnings: value.warnings.filter((item): item is string => typeof item === 'string'),
    };
}

export function decodeScanCleanupJobState(value: unknown): TScanCleanupJobState | null {
    if (value === null) {
        return null;
    }
    if (
        !isRecord(value)
        || typeof value.jobId !== 'string'
        || typeof value.updatedAtMs !== 'number'
        || !Number.isFinite(value.updatedAtMs)
    ) {
        throw new Error('invalid scan-cleanup job state');
    }
    const base = {
        jobId: value.jobId,
        progress: decodeProgress(value.progress),
        updatedAtMs: value.updatedAtMs,
    };
    if (value.status === 'queued' || value.status === 'running' || value.status === 'handoff' || value.status === 'canceled') {
        return {
            ...base,
            status: value.status,
        };
    }
    if (value.status === 'completed') {
        if (typeof value.outputPdfPath !== 'string') throw new Error('completed scan-cleanup state requires outputPdfPath');
        return {
            ...base,
            status: 'completed',
            outputPdfPath: value.outputPdfPath,
            summary: decodeSummary(value.summary),
        };
    }
    if (value.status === 'failed') {
        if (typeof value.error !== 'string' || !isScanCleanupErrorCode(value.errorCode)) {
            throw new Error('failed scan-cleanup state requires a typed error');
        }
        return {
            ...base,
            status: 'failed',
            error: value.error,
            errorCode: value.errorCode,
        };
    }
    throw new Error('invalid scan-cleanup job status');
}

export const SCAN_CLEANUP_IPC_CODECS = {
    [SCAN_CLEANUP_CHANNELS.preview]: {
        decodeArgs: decodePreviewArgs,
        decodeResult: decodeScanCleanupPreviewResult,
    },
    [SCAN_CLEANUP_CHANNELS.cancelPreview]: {
        decodeArgs: decodeSourcePath,
        decodeResult: (value: unknown) => {
            if (typeof value !== 'boolean') throw new Error('invalid scan-cleanup preview cancel result');
            return value;
        },
    },
    [SCAN_CLEANUP_CHANNELS.start]: {
        decodeArgs: decodeStartArgs,
        decodeResult: decodeStartResult,
    },
    [SCAN_CLEANUP_CHANNELS.cancel]: {
        decodeArgs: decodeJobId,
        decodeResult: (value: unknown) => {
            if (typeof value !== 'boolean') throw new Error('invalid scan-cleanup cancel result');
            return value;
        },
    },
    [SCAN_CLEANUP_CHANNELS.getJobState]: {
        decodeArgs: decodeJobId,
        decodeResult: decodeScanCleanupJobState,
    },
    [SCAN_CLEANUP_CHANNELS.subscribeJob]: {
        decodeArgs: decodeJobId,
        decodeResult: decodeScanCleanupJobState,
    },
    [SCAN_CLEANUP_CHANNELS.reconnectJob]: {
        decodeArgs: decodeJobId,
        decodeResult: decodeScanCleanupJobState,
    },
    [SCAN_CLEANUP_CHANNELS.pruneGeneratedOutputs]: {
        decodeArgs: decodeOpenPdfPaths,
        decodeResult: (value: unknown) => {
            if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('invalid scan-cleanup prune result');
            return Number(value);
        },
    },
} satisfies TIpcCodecMap<IScanCleanupInvokeMap>;
