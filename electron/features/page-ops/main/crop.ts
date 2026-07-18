import { existsSync } from 'fs';
import { stat } from 'fs/promises';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import type {
    ICropMargins,
    IPdfBox,
    IPageGeometry,
} from '@contracts/shared';
import {
    isFiniteNumber,
    isRecord,
} from '@contracts/runtimeGuards';
import { createLogger } from '@electron/utils/createLogger';
import { measureElectronPerfAsync } from '@electron/utils/measureElectronPerfAsync';
import {
    cropPagesLocal,
    getPageGeometryLocal,
    removeCropFromPagesLocal,
} from '@electron/features/page-ops/main/cropLocal';
import { getErrorMessage } from '@electron/utils/error';
import {
    resolveUnpackedWorkerPath,
    runResultWorkerTask,
} from '@electron/utils/workerTask';
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import type { TCropWorkerInput } from '@electron/features/page-ops/main/cropWorkerProtocol';

const log = createLogger('page-ops-crop');
const __dirname = dirname(fileURLToPath(import.meta.url));
const CROP_WORKER_FILENAME = WORKER_BUNDLES_BY_ID['page-ops-crop'].fileName;
const CROP_WORKER_TIMEOUT_MS = 2 * 60 * 1000;
const CROP_LOCAL_FALLBACK_MAX_BYTES = 64 * 1024 * 1024;
const CROP_LOCAL_FALLBACK_MAX_REQUESTED_PAGES = 100;

class CropWorkerUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CropWorkerUnavailableError';
    }
}

function resolveCropWorkerPath() {
    return resolveUnpackedWorkerPath(__dirname, CROP_WORKER_FILENAME);
}

function decodeUndefinedResult(data: unknown): undefined | null {
    return data === undefined ? undefined : null;
}


function decodePdfBox(value: unknown): IPdfBox | null {
    if (!isRecord(value)) {
        return null;
    }
    if (
        !isFiniteNumber(value.x)
        || !isFiniteNumber(value.y)
        || !isFiniteNumber(value.width)
        || !isFiniteNumber(value.height)
    ) {
        return null;
    }
    return {
        x: value.x,
        y: value.y,
        width: value.width,
        height: value.height,
    };
}

function decodePageGeometryResult(data: unknown): IPageGeometry | null {
    if (!isRecord(data) || !isFiniteNumber(data.rotation)) {
        return null;
    }

    const mediaBox = decodePdfBox(data.mediaBox);
    if (!mediaBox) {
        return null;
    }

    const cropBox = data.cropBox === null
        ? null
        : decodePdfBox(data.cropBox);
    if (cropBox === null && data.cropBox !== null) {
        return null;
    }

    return {
        mediaBox,
        cropBox,
        rotation: data.rotation,
    };
}

async function runCropWorkerTask<T>(
    workerInput: TCropWorkerInput,
    decodeResult: (data: unknown) => T | null,
    signal?: AbortSignal,
): Promise<T> {
    const workerPath = resolveCropWorkerPath();
    if (!existsSync(workerPath)) {
        throw new CropWorkerUnavailableError(`Crop worker unavailable at path: ${workerPath}`);
    }

    return measureElectronPerfAsync(`page-ops:${workerInput.type}`, () => runResultWorkerTask<T>({
        workerPath,
        workerData: workerInput,
        invalidPayloadMessage: 'Crop worker returned an invalid payload',
        invalidResultMessage: 'Crop worker returned an invalid result',
        createStartupError: message => new CropWorkerUnavailableError(`Crop worker startup failed: ${message}`),
        createStartupExitError: code => new CropWorkerUnavailableError(`Crop worker exited before startup with code ${code}`),
        createWorkerExitError: code => new Error(`Crop worker exited with code ${code}`),
        timeoutMs: CROP_WORKER_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
        createCancelMessage: () => ({type: 'cancel'}),
        resourceLimits: {
            maxOldGenerationSizeMb: 512,
            maxYoungGenerationSizeMb: 64,
            stackSizeMb: 8,
        },
        decodeResult,
    }), {
        thresholdMs: 25,
        details: {
            workingCopyPath: workerInput.workingCopyPath,
            pageCount: 'pages' in workerInput ? workerInput.pages.length : 1,
        },
    });
}

function shouldFallbackToLocalCrop(error: unknown) {
    return error instanceof CropWorkerUnavailableError;
}

async function assertLocalCropFallbackAllowed(workingCopyPath: string, requestedPageCount: number) {
    if (requestedPageCount > CROP_LOCAL_FALLBACK_MAX_REQUESTED_PAGES) {
        throw new Error(
            `Crop worker unavailable and in-process fallback is capped at ${CROP_LOCAL_FALLBACK_MAX_REQUESTED_PAGES} requested pages`,
        );
    }

    const inputStat = await stat(workingCopyPath);
    if (inputStat.size > CROP_LOCAL_FALLBACK_MAX_BYTES) {
        const maxMb = Math.floor(CROP_LOCAL_FALLBACK_MAX_BYTES / (1024 * 1024));
        throw new Error(`Crop worker unavailable and in-process fallback is capped at ${maxMb}MB PDFs`);
    }
}

async function ensureManagedWorkingCopy(workingCopyPath: string, senderWebContentsId?: number) {
    if (!await ensureWorkingCopyDirectory(workingCopyPath, senderWebContentsId)) {
        throw new Error('Working copy path is not managed');
    }
}

export async function cropPages(
    workingCopyPath: string,
    pages: number[],
    margins: ICropMargins,
    senderWebContentsId?: number,
    signal?: AbortSignal,
) {
    await ensureManagedWorkingCopy(workingCopyPath, senderWebContentsId);
    try {
        await runCropWorkerTask<undefined>({
            type: 'crop',
            workingCopyPath,
            pages,
            margins,
            ...(senderWebContentsId !== undefined ? { senderWebContentsId } : {}),
        }, decodeUndefinedResult, signal);
    } catch (error) {
        if (!shouldFallbackToLocalCrop(error)) {
            throw error;
        }
        await assertLocalCropFallbackAllowed(workingCopyPath, pages.length);
        log.warn(`Crop worker unavailable, falling back to in-process crop: ${getErrorMessage(error)}`);
        await cropPagesLocal(workingCopyPath, pages, margins, signal);
    }
}

export async function removeCropFromPages(
    workingCopyPath: string,
    pages: number[],
    senderWebContentsId?: number,
    signal?: AbortSignal,
) {
    await ensureManagedWorkingCopy(workingCopyPath, senderWebContentsId);
    try {
        await runCropWorkerTask<undefined>({
            type: 'removeCrop',
            workingCopyPath,
            pages,
            ...(senderWebContentsId !== undefined ? { senderWebContentsId } : {}),
        }, decodeUndefinedResult, signal);
    } catch (error) {
        if (!shouldFallbackToLocalCrop(error)) {
            throw error;
        }
        await assertLocalCropFallbackAllowed(workingCopyPath, pages.length);
        log.warn(`Crop worker unavailable, falling back to in-process crop reset: ${getErrorMessage(error)}`);
        await removeCropFromPagesLocal(workingCopyPath, pages, signal);
    }
}

export async function getPageGeometry(
    workingCopyPath: string,
    pageNumber: number,
    senderWebContentsId?: number,
): Promise<IPageGeometry> {
    await ensureManagedWorkingCopy(workingCopyPath, senderWebContentsId);
    try {
        return await runCropWorkerTask<IPageGeometry>({
            type: 'getPageGeometry',
            workingCopyPath,
            pageNumber,
            ...(senderWebContentsId !== undefined ? { senderWebContentsId } : {}),
        }, decodePageGeometryResult);
    } catch (error) {
        if (!shouldFallbackToLocalCrop(error)) {
            throw error;
        }
        await assertLocalCropFallbackAllowed(workingCopyPath, 1);
        log.warn(`Crop worker unavailable, falling back to in-process page geometry: ${getErrorMessage(error)}`);
        return getPageGeometryLocal(workingCopyPath, pageNumber);
    }
}
