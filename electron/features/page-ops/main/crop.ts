import { existsSync } from 'fs';
import { stat } from 'fs/promises';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import type {
    ICropMargins,
    IPageGeometry,
} from '@contracts/shared';
import { createLogger } from '@electron/utils/logger';
import { measureElectronPerfAsync } from '@electron/utils/devPerf';
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

const log = createLogger('page-ops-crop');
const __dirname = dirname(fileURLToPath(import.meta.url));
const CROP_WORKER_FILENAME = 'page-ops-cropWorker.js';
const CROP_WORKER_TIMEOUT_MS = 2 * 60 * 1000;
const CROP_LOCAL_FALLBACK_MAX_BYTES = 64 * 1024 * 1024;
const CROP_LOCAL_FALLBACK_MAX_REQUESTED_PAGES = 100;

class CropWorkerUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CropWorkerUnavailableError';
    }
}

type TCropWorkerInput =
    | {
        type: 'crop';
        workingCopyPath: string;
        pages: number[];
        margins: ICropMargins;
    }
    | {
        type: 'removeCrop';
        workingCopyPath: string;
        pages: number[];
    }
    | {
        type: 'getPageGeometry';
        workingCopyPath: string;
        pageNumber: number;
    };

function resolveCropWorkerPath() {
    return resolveUnpackedWorkerPath(__dirname, CROP_WORKER_FILENAME);
}

async function runCropWorkerTask<T>(workerInput: TCropWorkerInput): Promise<T> {
    const workerPath = resolveCropWorkerPath();
    if (!existsSync(workerPath)) {
        throw new CropWorkerUnavailableError(`Crop worker unavailable at path: ${workerPath}`);
    }

    return measureElectronPerfAsync(`page-ops:${workerInput.type}`, () => runResultWorkerTask<T>({
        workerPath,
        workerData: workerInput,
        invalidPayloadMessage: 'Crop worker returned an invalid payload',
        createStartupError: message => new CropWorkerUnavailableError(`Crop worker startup failed: ${message}`),
        createStartupExitError: code => new CropWorkerUnavailableError(`Crop worker exited before startup with code ${code}`),
        createWorkerExitError: code => new Error(`Crop worker exited with code ${code}`),
        timeoutMs: CROP_WORKER_TIMEOUT_MS,
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

export async function cropPages(
    workingCopyPath: string,
    pages: number[],
    margins: ICropMargins,
    senderWebContentsId?: number,
) {
    try {
        await runCropWorkerTask<undefined>({
            type: 'crop',
            workingCopyPath,
            pages,
            margins,
        });
    } catch (error) {
        if (!shouldFallbackToLocalCrop(error)) {
            throw error;
        }
        await assertLocalCropFallbackAllowed(workingCopyPath, pages.length);
        log.warn(`Crop worker unavailable, falling back to in-process crop: ${getErrorMessage(error)}`);
        await cropPagesLocal(workingCopyPath, pages, margins, senderWebContentsId);
    }
}

export async function removeCropFromPages(
    workingCopyPath: string,
    pages: number[],
    senderWebContentsId?: number,
) {
    try {
        await runCropWorkerTask<undefined>({
            type: 'removeCrop',
            workingCopyPath,
            pages,
        });
    } catch (error) {
        if (!shouldFallbackToLocalCrop(error)) {
            throw error;
        }
        await assertLocalCropFallbackAllowed(workingCopyPath, pages.length);
        log.warn(`Crop worker unavailable, falling back to in-process crop reset: ${getErrorMessage(error)}`);
        await removeCropFromPagesLocal(workingCopyPath, pages, senderWebContentsId);
    }
}

export async function getPageGeometry(
    workingCopyPath: string,
    pageNumber: number,
): Promise<IPageGeometry> {
    try {
        return await runCropWorkerTask<IPageGeometry>({
            type: 'getPageGeometry',
            workingCopyPath,
            pageNumber,
        });
    } catch (error) {
        if (!shouldFallbackToLocalCrop(error)) {
            throw error;
        }
        await assertLocalCropFallbackAllowed(workingCopyPath, 1);
        log.warn(`Crop worker unavailable, falling back to in-process page geometry: ${getErrorMessage(error)}`);
        return getPageGeometryLocal(workingCopyPath, pageNumber);
    }
}
