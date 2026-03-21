import { existsSync } from 'fs';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
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

const log = createLogger('page-ops-crop');
const __dirname = dirname(fileURLToPath(import.meta.url));
const CROP_WORKER_FILENAME = 'page-ops-crop-worker.js';

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

type TCropWorkerOutput =
    | {
        type: 'result';
        ok: true;
        data?: IPageGeometry;
    }
    | {
        type: 'result';
        ok: false;
        error: string;
    };

function resolveCropWorkerPath() {
    const defaultPath = join(__dirname, CROP_WORKER_FILENAME);
    const unpackedPath = defaultPath.replace('app.asar', 'app.asar.unpacked');
    if (unpackedPath !== defaultPath && existsSync(unpackedPath)) {
        return unpackedPath;
    }
    return defaultPath;
}

async function runCropWorkerTask<T>(workerInput: TCropWorkerInput): Promise<T> {
    const workerPath = resolveCropWorkerPath();
    if (!existsSync(workerPath)) {
        throw new Error(`Crop worker unavailable at path: ${workerPath}`);
    }

    return measureElectronPerfAsync(`page-ops:${workerInput.type}`, () => new Promise<T>((resolve, reject) => {
        let settled = false;
        let online = false;
        const worker = new Worker(workerPath, { workerData: workerInput });

        const finalize = (callback: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            worker.removeAllListeners();
            void worker.terminate().catch(() => {});
            callback();
        };

        worker.once('online', () => {
            online = true;
        });

        worker.once('message', (payload: TCropWorkerOutput) => {
            finalize(() => {
                if (!payload || payload.type !== 'result') {
                    reject(new Error('Crop worker returned an invalid payload'));
                    return;
                }
                if (!payload.ok) {
                    reject(new Error(payload.error));
                    return;
                }
                resolve(payload.data as T);
            });
        });

        worker.once('error', (error) => {
            const resolvedError = error instanceof Error ? error : new Error(String(error));
            finalize(() => {
                if (!online) {
                    reject(new Error(`Crop worker startup failed: ${resolvedError.message}`));
                    return;
                }
                reject(resolvedError);
            });
        });

        worker.once('exit', (code) => {
            if (settled || code === 0) {
                return;
            }
            finalize(() => {
                reject(new Error(`Crop worker exited with code ${code}`));
            });
        });
    }), {
        thresholdMs: 25,
        details: {
            workingCopyPath: workerInput.workingCopyPath,
            pageCount: 'pages' in workerInput ? workerInput.pages.length : 1,
        },
    });
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
        log.warn(`Crop worker unavailable, falling back to in-process crop: ${error instanceof Error ? error.message : String(error)}`);
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
        log.warn(`Crop worker unavailable, falling back to in-process crop reset: ${error instanceof Error ? error.message : String(error)}`);
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
        log.warn(`Crop worker unavailable, falling back to in-process page geometry: ${error instanceof Error ? error.message : String(error)}`);
        return getPageGeometryLocal(workingCopyPath, pageNumber);
    }
}
