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
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';
import { ensureWorkingCopyDirectory } from '@electron/ipc/workingCopyCreation';

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

type TCropWorkerInput =
    | {
        type: 'crop';
        workingCopyPath: string;
        pages: number[];
        margins: ICropMargins;
        senderWebContentsId?: number;
    }
    | {
        type: 'removeCrop';
        workingCopyPath: string;
        pages: number[];
        senderWebContentsId?: number;
    }
    | {
        type: 'getPageGeometry';
        workingCopyPath: string;
        pageNumber: number;
        senderWebContentsId?: number;
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
) {
    await ensureManagedWorkingCopy(workingCopyPath, senderWebContentsId);
    try {
        await runCropWorkerTask<undefined>({
            type: 'crop',
            workingCopyPath,
            pages,
            margins,
            ...(senderWebContentsId !== undefined ? { senderWebContentsId } : {}),
        });
    } catch (error) {
        if (!shouldFallbackToLocalCrop(error)) {
            throw error;
        }
        await assertLocalCropFallbackAllowed(workingCopyPath, pages.length);
        log.warn(`Crop worker unavailable, falling back to in-process crop: ${getErrorMessage(error)}`);
        await cropPagesLocal(workingCopyPath, pages, margins);
    }
}

export async function removeCropFromPages(
    workingCopyPath: string,
    pages: number[],
    senderWebContentsId?: number,
) {
    await ensureManagedWorkingCopy(workingCopyPath, senderWebContentsId);
    try {
        await runCropWorkerTask<undefined>({
            type: 'removeCrop',
            workingCopyPath,
            pages,
            ...(senderWebContentsId !== undefined ? { senderWebContentsId } : {}),
        });
    } catch (error) {
        if (!shouldFallbackToLocalCrop(error)) {
            throw error;
        }
        await assertLocalCropFallbackAllowed(workingCopyPath, pages.length);
        log.warn(`Crop worker unavailable, falling back to in-process crop reset: ${getErrorMessage(error)}`);
        await removeCropFromPagesLocal(workingCopyPath, pages);
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
        });
    } catch (error) {
        if (!shouldFallbackToLocalCrop(error)) {
            throw error;
        }
        log.warn(`Crop worker unavailable, falling back to in-process page geometry: ${getErrorMessage(error)}`);
        return getPageGeometryLocal(workingCopyPath, pageNumber);
    }
}
