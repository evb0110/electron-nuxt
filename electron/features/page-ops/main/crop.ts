import { existsSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import type {
    ICropMargins,
    IPageGeometry,
} from '@contracts/shared';
import { createLogger } from '@electron/utils/logger';
import { measureElectronPerfAsync } from '@electron/utils/dev-perf';
import {
    cropPagesLocal,
    getPageGeometryLocal,
    removeCropFromPagesLocal,
} from '@electron/features/page-ops/main/crop-local';
import { getErrorMessage } from '@electron/utils/error';
import {
    resolveUnpackedWorkerPath,
    runResultWorkerTask,
} from '@electron/utils/worker-task';

const log = createLogger('page-ops-crop');
const __dirname = dirname(fileURLToPath(import.meta.url));
const CROP_WORKER_FILENAME = 'page-ops-crop-worker.js';
const CROP_WORKER_TIMEOUT_MS = 2 * 60 * 1000;

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

export async function cropPages(
    workingCopyPath: string,
    pages: number[],
    margins: ICropMargins,
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
        log.warn(`Crop worker unavailable, falling back to in-process crop: ${getErrorMessage(error)}`);
        await cropPagesLocal(workingCopyPath, pages, margins);
    }
}

export async function removeCropFromPages(
    workingCopyPath: string,
    pages: number[],
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
        log.warn(`Crop worker unavailable, falling back to in-process crop reset: ${getErrorMessage(error)}`);
        await removeCropFromPagesLocal(workingCopyPath, pages);
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
        log.warn(`Crop worker unavailable, falling back to in-process page geometry: ${getErrorMessage(error)}`);
        return getPageGeometryLocal(workingCopyPath, pageNumber);
    }
}
