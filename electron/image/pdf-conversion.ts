import { existsSync } from 'fs';
import { stat } from 'fs/promises';
import {
    basename,
    dirname,
    extname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import { createLogger } from '@electron/utils/logger';
import {
    createCombinedPdf,
    isImagePath,
    SUPPORTED_IMAGE_EXTENSIONS as SHARED_SUPPORTED_IMAGE_EXTENSIONS,
} from '@electron/image/pdf-combine-shared';

export interface ICreatePdfFromInputPathsProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

interface ICreatePdfFromInputPathsOptions {onProgress?: (progress: ICreatePdfFromInputPathsProgress) => void;}

type TCombineWorkerPayload =
    | {
        type: 'progress';
        processed: number;
        total: number;
        percent: number;
        elapsedMs: number;
        estimatedRemainingMs: number | null;
    }
    | {
        type: 'result';
        ok: true;
        data: unknown;
    }
    | {
        type: 'result';
        ok: false;
        error: string;
    };

const logger = createLogger('pdf-conversion');
const __dirname = dirname(fileURLToPath(import.meta.url));
const COMBINE_WORKER_FILENAME = 'pdf-combine-worker.js';
const PDF_COMBINE_WORKER_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_PDF_COMBINE_WORKER_TIMEOUT_MS ?? `${5 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 10_000) {
        return 5 * 60 * 1000;
    }
    return parsed;
})();
const PDF_COMBINE_MAX_INPUT_FILES = (() => {
    const parsed = Number.parseInt(process.env.EVB_PDF_COMBINE_MAX_INPUT_FILES ?? '512', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 512;
    }
    return Math.min(parsed, 10_000);
})();
const PDF_COMBINE_MAX_SINGLE_FILE_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_PDF_COMBINE_MAX_SINGLE_FILE_MB ?? '512', 10);
    if (!Number.isFinite(parsed) || parsed < 8) {
        return 512 * 1024 * 1024;
    }
    return parsed * 1024 * 1024;
})();
const PDF_COMBINE_MAX_TOTAL_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_PDF_COMBINE_MAX_TOTAL_MB ?? '1536', 10);
    if (!Number.isFinite(parsed) || parsed < 64) {
        return 1536 * 1024 * 1024;
    }
    return parsed * 1024 * 1024;
})();

export const SUPPORTED_IMAGE_EXTENSIONS = SHARED_SUPPORTED_IMAGE_EXTENSIONS;

const WORKER_SUPPORTED_IMAGE_EXTENSIONS = new Set<string>(
    SUPPORTED_IMAGE_EXTENSIONS,
);

class PdfCombineWorkerStartupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PdfCombineWorkerStartupError';
    }
}

function assertNever(value: never): never {
    throw new Error(`Unhandled image combine worker payload: ${JSON.stringify(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function parseCombineWorkerPayload(message: unknown): TCombineWorkerPayload | null {
    if (!isRecord(message) || typeof message.type !== 'string') {
        return null;
    }

    switch (message.type) {
        case 'progress':
            if (
                !isFiniteNumber(message.processed)
                || !isFiniteNumber(message.total)
                || !isFiniteNumber(message.percent)
                || !isFiniteNumber(message.elapsedMs)
            ) {
                return null;
            }
            return {
                type: 'progress',
                processed: message.processed,
                total: message.total,
                percent: message.percent,
                elapsedMs: message.elapsedMs,
                estimatedRemainingMs: isFiniteNumber(message.estimatedRemainingMs)
                    ? message.estimatedRemainingMs
                    : null,
            };
        case 'result':
            if (message.ok === true) {
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

export function isPdfPath(filePath: string): boolean {
    return extname(filePath).toLowerCase() === '.pdf';
}

export function isDjvuPath(filePath: string): boolean {
    const extension = extname(filePath).toLowerCase();
    return extension === '.djvu' || extension === '.djv';
}

export function isPdfOrImagePath(filePath: string): boolean {
    return isPdfPath(filePath) || isImagePath(filePath);
}

export function isSupportedOpenPath(filePath: string): boolean {
    return isPdfOrImagePath(filePath) || isDjvuPath(filePath);
}

export function buildCombinedPdfOutputPath(inputPaths: string[]): string {
    if (inputPaths.length === 0) {
        return 'combined.pdf';
    }

    const firstPath = inputPaths[0];
    if (!firstPath) {
        return 'combined.pdf';
    }
    const dir = dirname(firstPath);
    const stem = basename(firstPath, extname(firstPath));
    const outputName =
        inputPaths.length === 1 ? `${stem}.pdf` : `${stem}-combined.pdf`;

    return join(dir, outputName);
}

async function createPdfFromInputPathsLocal(
    inputPaths: string[],
    options?: ICreatePdfFromInputPathsOptions,
): Promise<Uint8Array> {
    return createCombinedPdf(inputPaths, {
        onProgress: options?.onProgress,
        unsupportedFileError: (sourcePath) => `Unsupported file type: ${sourcePath}`,
    });
}

function canCombineInWorker(inputPaths: string[]): boolean {
    return inputPaths.every((sourcePath) => {
        const extension = extname(sourcePath).toLowerCase();
        return (
            extension === '.pdf' || WORKER_SUPPORTED_IMAGE_EXTENSIONS.has(extension)
        );
    });
}

function getCombineWorkerPath(): string {
    const defaultPath = join(__dirname, COMBINE_WORKER_FILENAME);
    const unpackedPath = defaultPath.replace('app.asar', 'app.asar.unpacked');
    if (unpackedPath !== defaultPath && existsSync(unpackedPath)) {
        return unpackedPath;
    }

    return defaultPath;
}

function decodeWorkerPdfBytes(data: unknown): Uint8Array | null {
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

async function enforceInputResourceLimits(inputPaths: string[]) {
    if (inputPaths.length > PDF_COMBINE_MAX_INPUT_FILES) {
        throw new Error(`Too many input files (${inputPaths.length}). Max supported: ${PDF_COMBINE_MAX_INPUT_FILES}`);
    }

    let totalBytes = 0;
    for (const inputPath of inputPaths) {
        const fileStat = await stat(inputPath);
        if (!fileStat.isFile()) {
            throw new Error(`Input path is not a regular file: ${inputPath}`);
        }
        if (fileStat.size <= 0) {
            throw new Error(`Input file is empty: ${inputPath}`);
        }
        if (fileStat.size > PDF_COMBINE_MAX_SINGLE_FILE_BYTES) {
            throw new Error(
                `Input file exceeds size limit (${Math.round(fileStat.size / (1024 * 1024))}MB): ${inputPath}`,
            );
        }
        totalBytes += fileStat.size;
        if (totalBytes > PDF_COMBINE_MAX_TOTAL_BYTES) {
            throw new Error(
                `Combined input size exceeds limit (${Math.round(PDF_COMBINE_MAX_TOTAL_BYTES / (1024 * 1024))}MB)`,
            );
        }
    }
}

function createPdfFromInputPathsWorker(
    inputPaths: string[],
    options?: ICreatePdfFromInputPathsOptions,
): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        let worker: Worker;
        try {
            worker = new Worker(getCombineWorkerPath(), {workerData: { inputPaths }});
        } catch (error) {
            reject(new PdfCombineWorkerStartupError(
                `Image combine worker failed to start: ${error instanceof Error ? error.message : String(error)}`,
            ));
            return;
        }

        let settled = false;
        let cleanedUp = false;
        let timeoutHandle: NodeJS.Timeout | null = null;
        let workerOnline = false;

        const cleanupWorker = () => {
            if (cleanedUp) {
                return;
            }
            cleanedUp = true;
            worker.removeAllListeners('message');
            worker.removeAllListeners('error');
            worker.removeAllListeners('exit');
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
        };

        const terminateWorker = () => {
            cleanupWorker();
            void worker.terminate().catch(() => undefined);
        };

        worker.once('online', () => {
            workerOnline = true;
        });

        worker.on('message', (message: unknown) => {
            const payload = parseCombineWorkerPayload(message);
            if (!payload) {
                if (!settled) {
                    settled = true;
                    terminateWorker();
                    reject(new Error('Image combine worker sent malformed payload'));
                }
                return;
            }

            switch (payload.type) {
                case 'progress':
                    if (options?.onProgress) {
                        options.onProgress({
                            processed: payload.processed,
                            total: payload.total,
                            percent: payload.percent,
                            elapsedMs: payload.elapsedMs,
                            estimatedRemainingMs: payload.estimatedRemainingMs,
                        });
                    }
                    return;
                case 'result': {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    terminateWorker();

                    if (!payload.ok) {
                        reject(new Error(payload.error || 'Image combine worker failed'));
                        return;
                    }

                    const data = decodeWorkerPdfBytes(payload.data);
                    if (!data) {
                        reject(new Error('Image combine worker returned invalid PDF data'));
                        return;
                    }

                    resolve(data);
                    return;
                }
                default:
                    assertNever(payload);
            }
        });

        worker.once('error', (error) => {
            if (!settled) {
                settled = true;
                terminateWorker();
                if (!workerOnline) {
                    reject(new PdfCombineWorkerStartupError(
                        `Image combine worker failed before becoming ready: ${error instanceof Error ? error.message : String(error)}`,
                    ));
                    return;
                }
                reject(error);
            }
        });

        worker.once('exit', (code) => {
            if (!settled && code !== 0) {
                settled = true;
                cleanupWorker();
                if (!workerOnline) {
                    reject(new PdfCombineWorkerStartupError(
                        `Image combine worker exited during startup with code ${code}`,
                    ));
                    return;
                }
                reject(new Error(`Image combine worker exited with code ${code}`));
            }
        });

        timeoutHandle = setTimeout(() => {
            if (settled) {
                return;
            }

            settled = true;
            terminateWorker();
            reject(new Error(`Image combine worker timed out after ${PDF_COMBINE_WORKER_TIMEOUT_MS}ms`));
        }, PDF_COMBINE_WORKER_TIMEOUT_MS);
        timeoutHandle.unref?.();
    });
}

export async function createPdfFromInputPaths(
    inputPaths: string[],
    options?: ICreatePdfFromInputPathsOptions,
): Promise<Uint8Array> {
    const normalizedPaths = inputPaths
        .map((path) => path.trim())
        .filter((path) => path.length > 0);

    if (normalizedPaths.length === 0) {
        throw new Error('No input files were provided');
    }

    await enforceInputResourceLimits(normalizedPaths);

    if (!canCombineInWorker(normalizedPaths)) {
        return createPdfFromInputPathsLocal(normalizedPaths, options);
    }

    try {
        return await createPdfFromInputPathsWorker(normalizedPaths, options);
    } catch (workerError) {
        if (!(workerError instanceof PdfCombineWorkerStartupError)) {
            logger.warn(
                `Image combine worker failed without safe fallback: ${
                    workerError instanceof Error ? workerError.message : String(workerError)
                }`,
            );
            throw workerError;
        }
        logger.warn(
            `Image combine worker failed, falling back to in-process conversion: ${workerError instanceof Error ? workerError.message : String(workerError)}`,
        );
        return createPdfFromInputPathsLocal(normalizedPaths, options);
    }
}
