import { existsSync } from 'fs';
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

export const SUPPORTED_IMAGE_EXTENSIONS = SHARED_SUPPORTED_IMAGE_EXTENSIONS;

const WORKER_SUPPORTED_IMAGE_EXTENSIONS = new Set<string>(
    SUPPORTED_IMAGE_EXTENSIONS,
);

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

function createPdfFromInputPathsWorker(
    inputPaths: string[],
    options?: ICreatePdfFromInputPathsOptions,
): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(getCombineWorkerPath(), {workerData: { inputPaths }});

        let settled = false;
        let cleanedUp = false;

        const cleanupWorker = () => {
            if (cleanedUp) {
                return;
            }
            cleanedUp = true;
            worker.removeAllListeners('message');
            worker.removeAllListeners('error');
            worker.removeAllListeners('exit');
        };

        const terminateWorker = () => {
            cleanupWorker();
            void worker.terminate().catch(() => undefined);
        };

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
                reject(error);
            }
        });

        worker.once('exit', (code) => {
            if (!settled && code !== 0) {
                settled = true;
                cleanupWorker();
                reject(new Error(`Image combine worker exited with code ${code}`));
            }
        });
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

    if (!canCombineInWorker(normalizedPaths)) {
        return createPdfFromInputPathsLocal(normalizedPaths, options);
    }

    try {
        return await createPdfFromInputPathsWorker(normalizedPaths, options);
    } catch (workerError) {
        logger.warn(
            `Image combine worker failed, falling back to in-process conversion: ${workerError instanceof Error ? workerError.message : String(workerError)}`,
        );
        return createPdfFromInputPathsLocal(normalizedPaths, options);
    }
}
