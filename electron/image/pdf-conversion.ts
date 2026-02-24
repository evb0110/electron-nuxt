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

interface ICombineWorkerPayload {
    type?: string;
    ok?: boolean;
    error?: string;
    data?: unknown;
    processed?: number;
    total?: number;
    percent?: number;
    elapsedMs?: number;
    estimatedRemainingMs?: number | null;
}

export interface ICreatePdfFromInputPathsProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

interface ICreatePdfFromInputPathsOptions {onProgress?: (progress: ICreatePdfFromInputPathsProgress) => void;}

const logger = createLogger('pdf-conversion');
const __dirname = dirname(fileURLToPath(import.meta.url));
const COMBINE_WORKER_FILENAME = 'pdf-combine-worker.js';

export const SUPPORTED_IMAGE_EXTENSIONS = SHARED_SUPPORTED_IMAGE_EXTENSIONS;

const WORKER_SUPPORTED_IMAGE_EXTENSIONS = new Set<string>(
    SUPPORTED_IMAGE_EXTENSIONS,
);

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

    const firstPath = inputPaths[0]!;
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
            const payload = message as ICombineWorkerPayload;

            if (payload.type === 'progress') {
                if (
                    options?.onProgress
                    && Number.isFinite(payload.processed)
                    && Number.isFinite(payload.total)
                    && Number.isFinite(payload.percent)
                    && Number.isFinite(payload.elapsedMs)
                ) {
                    options.onProgress({
                        processed: Number(payload.processed),
                        total: Number(payload.total),
                        percent: Number(payload.percent),
                        elapsedMs: Number(payload.elapsedMs),
                        estimatedRemainingMs:
                            typeof payload.estimatedRemainingMs === 'number'
                                ? payload.estimatedRemainingMs
                                : null,
                    });
                }
                return;
            }

            if (settled) {
                return;
            }
            settled = true;
            terminateWorker();

            if (payload.type === 'result' && !payload.ok) {
                reject(new Error(payload.error || 'Image combine worker failed'));
                return;
            }
            if (payload.type === 'result' && payload.ok !== true) {
                reject(new Error(payload.error || 'Image combine worker failed'));
                return;
            }
            if (payload.type !== 'result' && payload.ok !== true) {
                reject(new Error(payload.error || 'Image combine worker failed'));
                return;
            }

            const data = decodeWorkerPdfBytes(payload.data);
            if (!data) {
                reject(new Error('Image combine worker returned invalid PDF data'));
                return;
            }

            resolve(data);
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
