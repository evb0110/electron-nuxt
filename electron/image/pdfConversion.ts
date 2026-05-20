import { existsSync } from 'fs';
import {
    mkdtemp,
    readFile,
    rm,
    stat,
} from 'fs/promises';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import {
    basename,
    dirname,
    extname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import { PDFDocument } from 'pdf-lib';
import { createLogger } from '@electron/utils/logger';
import {
    createCombinedPdf,
    isImagePath,
    PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS,
} from '@electron/image/pdfCombineShared';
import { convertDjvuToPdfFile } from '@electron/features/djvu/main/ddjvuConversion';
import { getErrorMessage } from '@electron/utils/error';
import {
    isFiniteWorkerMessageNumber,
    isWorkerMessageRecord,
} from '@electron/utils/workerMessage';
import { WORKER_BUNDLES_BY_ID } from '@contracts/electronWorkerBundles.js';

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

const logger = createLogger('pdfConversion');
const __dirname = dirname(fileURLToPath(import.meta.url));
const COMBINE_WORKER_FILENAME = WORKER_BUNDLES_BY_ID['pdf-combine'].fileName;
const PDF_COMBINE_WORKER_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_PDF_COMBINE_WORKER_TIMEOUT_MS ?? `${5 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 10_000) {
        return 5 * 60 * 1000;
    }
    return parsed;
})();
const PDF_COMBINE_MAX_INPUT_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_PDF_COMBINE_MAX_INPUT_MB ?? '512', 10);
    if (!Number.isFinite(parsed) || parsed < 16) {
        return 512 * 1024 * 1024;
    }
    return parsed * 1024 * 1024;
})();
const PDF_COMBINE_MAX_TOTAL_INPUT_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_PDF_COMBINE_MAX_TOTAL_INPUT_MB ?? '1024', 10);
    if (!Number.isFinite(parsed) || parsed < 16) {
        return 1024 * 1024 * 1024;
    }
    return parsed * 1024 * 1024;
})();
const PDF_COMBINE_LOCAL_FALLBACK_MAX_TOTAL_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_PDF_COMBINE_LOCAL_FALLBACK_MAX_TOTAL_MB ?? '16', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 16 * 1024 * 1024;
    }
    return Math.min(parsed, 256) * 1024 * 1024;
})();
export const SUPPORTED_IMAGE_EXTENSIONS = PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS;

const WORKER_SUPPORTED_IMAGE_EXTENSIONS = new Set<string>(
    [
        '.png',
        '.jpg',
        '.jpeg',
        '.tif',
        '.tiff',
    ],
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

function parseCombineWorkerProgressPayload(
    message: Record<string, unknown>,
): TCombineWorkerPayload | null {
    if (
        !isFiniteWorkerMessageNumber(message.processed)
        || !isFiniteWorkerMessageNumber(message.total)
        || !isFiniteWorkerMessageNumber(message.percent)
        || !isFiniteWorkerMessageNumber(message.elapsedMs)
    ) {
        return null;
    }

    return {
        type: 'progress',
        processed: message.processed,
        total: message.total,
        percent: message.percent,
        elapsedMs: message.elapsedMs,
        estimatedRemainingMs: isFiniteWorkerMessageNumber(message.estimatedRemainingMs)
            ? message.estimatedRemainingMs
            : null,
    };
}

function parseCombineWorkerResultPayload(
    message: Record<string, unknown>,
): TCombineWorkerPayload | null {
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
}

function parseCombineWorkerPayload(message: unknown): TCombineWorkerPayload | null {
    if (!isWorkerMessageRecord(message) || typeof message.type !== 'string') {
        return null;
    }

    switch (message.type) {
        case 'progress':
            return parseCombineWorkerProgressPayload(message);
        case 'result':
            return parseCombineWorkerResultPayload(message);
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
        inputPaths.length === 1 ? `${stem}.pdf` : `combined-${Date.now()}.pdf`;

    return join(dir, outputName);
}

async function createPdfFromInputPathsLocal(
    inputPaths: string[],
    options?: ICreatePdfFromInputPathsOptions,
): Promise<Uint8Array> {
    return createCombinedPdf(inputPaths, {
        ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
        unsupportedFileError: (sourcePath) => `Unsupported file type: ${sourcePath}`,
        appendDjvuPages: async (targetPdf, sourcePath) => {
            const tempDir = await mkdtemp(join(tmpdir(), 'pdf-combine-djvu-'));
            const tempPdfPath = join(tempDir, `${randomUUID()}.pdf`);

            try {
                const result = await convertDjvuToPdfFile(
                    sourcePath,
                    tempPdfPath,
                    `pdf-combine-djvu-${randomUUID()}`,
                    { subsample: 1 },
                );

                if (!result.success) {
                    throw new Error(result.error ?? `Failed to convert DjVu file: ${sourcePath}`);
                }

                const sourceBytes = await readFile(tempPdfPath);
                const sourcePdf = await PDFDocument.load(sourceBytes);
                const copiedPages = await targetPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
                for (const page of copiedPages) {
                    targetPdf.addPage(page);
                }
                return copiedPages.length;
            } finally {
                await rm(tempDir, {
                    recursive: true,
                    force: true,
                }).catch(() => undefined);
            }
        },
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
    let totalBytes = 0;
    for (const inputPath of inputPaths) {
        const fileStat = await stat(inputPath);
        if (!fileStat.isFile()) {
            throw new Error(`Input path is not a regular file: ${inputPath}`);
        }
        if (fileStat.size <= 0) {
            throw new Error(`Input file is empty: ${inputPath}`);
        }
        if (fileStat.size > PDF_COMBINE_MAX_INPUT_BYTES) {
            throw new Error(`Input file is too large to combine safely: ${inputPath}`);
        }
        totalBytes += fileStat.size;
        if (totalBytes > PDF_COMBINE_MAX_TOTAL_INPUT_BYTES) {
            throw new Error('Combined input files are too large to combine safely');
        }
    }
    return { totalBytes };
}

function canUseLocalWorkerStartupFallback(totalBytes: number) {
    return totalBytes <= PDF_COMBINE_LOCAL_FALLBACK_MAX_TOTAL_BYTES;
}

function getLocalWorkerStartupFallbackDisabledError() {
    const maxMb = Math.floor(PDF_COMBINE_LOCAL_FALLBACK_MAX_TOTAL_BYTES / (1024 * 1024));
    return new Error(`Image combine worker startup failed and main-process fallback is disabled for inputs larger than ${maxMb}MB`);
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
                `Image combine worker failed to start: ${getErrorMessage(error)}`,
            ));
            return;
        }

        let settled = false;
        let cleanedUp = false;
        let timeoutHandle: NodeJS.Timeout | null = null;
        let workerOnline = false;
        let ignoreLateWorkerError: (() => undefined) | null = null;

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
            ignoreLateWorkerError = () => undefined;
            worker.on('error', ignoreLateWorkerError);
            void worker.terminate().catch(() => undefined).finally(() => {
                if (ignoreLateWorkerError) {
                    worker.removeListener('error', ignoreLateWorkerError);
                    ignoreLateWorkerError = null;
                }
            });
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
                        `Image combine worker failed before becoming ready: ${getErrorMessage(error)}`,
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

    const resourceUsage = await enforceInputResourceLimits(normalizedPaths);

    if (!canCombineInWorker(normalizedPaths)) {
        return createPdfFromInputPathsLocal(normalizedPaths, options);
    }

    try {
        return await createPdfFromInputPathsWorker(normalizedPaths, options);
    } catch (workerError) {
        if (!(workerError instanceof PdfCombineWorkerStartupError)) {
            logger.warn(
                `Image combine worker failed without safe fallback: ${
                    getErrorMessage(workerError)
                }`,
            );
            throw workerError;
        }

        logger.warn(
            `Image combine worker failed, falling back to in-process conversion: ${getErrorMessage(workerError)}`,
        );
        if (!canUseLocalWorkerStartupFallback(resourceUsage.totalBytes)) {
            throw getLocalWorkerStartupFallbackDisabledError();
        }
        return createPdfFromInputPathsLocal(normalizedPaths, options);
    }
}
