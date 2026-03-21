import { existsSync } from 'fs';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import type { IPdfBookmarkEntry } from '@contracts/pdf';
import type {
    IDjvuPdfWorkerProgressMessage,
    TDjvuPdfWorkerMessage,
    TDjvuPdfWorkerTask,
} from '@electron/features/djvu/main/pdf-worker-protocol';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DJVU_PDF_WORKER_FILENAME = 'djvu-pdf-worker.js';

export class DjvuPdfWorkerStartupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DjvuPdfWorkerStartupError';
    }
}

export interface IDjvuPdfWorkerTaskHandle<T> {
    worker: Worker;
    promise: Promise<T>;
}

function resolveDjvuPdfWorkerPath() {
    const defaultPath = join(__dirname, DJVU_PDF_WORKER_FILENAME);
    const unpackedPath = defaultPath.replace('app.asar', 'app.asar.unpacked');
    if (unpackedPath !== defaultPath && existsSync(unpackedPath)) {
        return unpackedPath;
    }
    return defaultPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isPdfWorkerResultData(value: unknown): value is number | Uint8Array | ArrayBuffer {
    return typeof value === 'number'
        || value instanceof Uint8Array
        || value instanceof ArrayBuffer;
}

function parseWorkerMessage(message: unknown): TDjvuPdfWorkerMessage | null {
    if (!isRecord(message) || typeof message.type !== 'string') {
        return null;
    }

    switch (message.type) {
        case 'progress':
            if (
                message.phase !== 'buildPdf'
                || !isFiniteNumber(message.page)
                || !isFiniteNumber(message.total)
            ) {
                return null;
            }
            return {
                type: 'progress',
                phase: 'buildPdf',
                page: message.page,
                total: message.total,
            };
        case 'result':
            if (message.ok === true) {
                if (!isPdfWorkerResultData(message.data)) {
                    return null;
                }
                return {
                    type: 'result',
                    ok: true,
                    data: message.data,
                };
            }
            if (message.ok === false && typeof message.error === 'string') {
                return {
                    type: 'result',
                    ok: false,
                    error: message.error,
                };
            }
            return null;
        default:
            return null;
    }
}

function decodePdfBytes(data: unknown): Uint8Array | null {
    if (data instanceof Uint8Array) {
        return data;
    }
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return null;
}

function createDjvuPdfWorkerTask<T>(
    task: TDjvuPdfWorkerTask,
    options: {
        onProgress?: (message: IDjvuPdfWorkerProgressMessage) => void;
        decodeResult: (data: unknown) => T | null;
    },
): IDjvuPdfWorkerTaskHandle<T> {
    const workerPath = resolveDjvuPdfWorkerPath();
    if (!existsSync(workerPath)) {
        throw new DjvuPdfWorkerStartupError(`DjVu PDF worker unavailable at path: ${workerPath}`);
    }

    const worker = new Worker(workerPath, { workerData: task });
    const promise = new Promise<T>((resolve, reject) => {
        let settled = false;
        let online = false;

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

        worker.on('message', (rawMessage: unknown) => {
            const message = parseWorkerMessage(rawMessage);
            if (!message) {
                finalize(() => {
                    reject(new Error('DjVu PDF worker returned an invalid payload'));
                });
                return;
            }

            if (message.type === 'progress') {
                options.onProgress?.(message);
                return;
            }

            finalize(() => {
                if (!message.ok) {
                    reject(new Error(message.error));
                    return;
                }

                const decoded = options.decodeResult(message.data);
                if (decoded === null) {
                    reject(new Error('DjVu PDF worker returned an invalid result'));
                    return;
                }
                resolve(decoded);
            });
        });

        worker.once('error', (error) => {
            const resolvedError = error instanceof Error ? error : new Error(String(error));
            finalize(() => {
                if (!online) {
                    reject(new DjvuPdfWorkerStartupError(`DjVu PDF worker startup failed: ${resolvedError.message}`));
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
                reject(new Error(`DjVu PDF worker exited with code ${code}`));
            });
        });
    });

    return {
        worker,
        promise,
    };
}

export function createDjvuPdfBuildTask(
    imagePaths: string[],
    dpi: number,
    onProgress?: (message: IDjvuPdfWorkerProgressMessage) => void,
): IDjvuPdfWorkerTaskHandle<Uint8Array> {
    return createDjvuPdfWorkerTask({
        type: 'buildPdf',
        imagePaths,
        dpi,
    }, {
        onProgress,
        decodeResult: decodePdfBytes,
    });
}

export function createDjvuPdfEstimateTask(
    imagePath: string,
    dpi: number,
): IDjvuPdfWorkerTaskHandle<number> {
    return createDjvuPdfWorkerTask({
        type: 'estimatePdfSize',
        imagePath,
        dpi,
    }, {decodeResult: (data) => (typeof data === 'number' && Number.isFinite(data) ? data : null)});
}

export function createDjvuPdfBookmarkTask(
    pdfData: Uint8Array,
    bookmarks: IPdfBookmarkEntry[],
): IDjvuPdfWorkerTaskHandle<Uint8Array> {
    return createDjvuPdfWorkerTask({
        type: 'embedBookmarks',
        pdfData,
        bookmarks,
    }, {decodeResult: decodePdfBytes});
}
