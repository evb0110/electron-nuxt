import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'fs';
import {
    unlink,
    writeFile,
} from 'fs/promises';
import {
    basename,
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import type {
    IPdfConformanceProfile,
    IPdfValidationResult,
} from '@contracts/pdf-conformance';
import { createDefaultPdfConformanceProfile } from '@electron/features/documents/main/pdf-conformance-helpers';
import { runNativeToolCommand } from '@electron/native-tools/exec';
import { getNativeToolPaths } from '@electron/native-tools/paths';
import { createLogger } from '@electron/utils/logger';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('documents-pdf-conformance');
const QPDF_VALIDATE_TIMEOUT_MS = 30_000;
const PDF_CONFORMANCE_WORKER_FILENAME = 'pdf-conformance-worker.js';
const PDF_CONFORMANCE_WORKER_DRAIN_TIMEOUT_MS = 5_000;
const __dirname = dirname(fileURLToPath(import.meta.url));

function sanitizeValidationFileName(fileName?: string) {
    const fallback = 'document.pdf';
    const baseName = basename(fileName?.trim() || fallback);
    const sanitized = baseName.replace(/[^\w.-]+/gu, '-');
    return sanitized.toLowerCase().endsWith('.pdf') ? sanitized : `${sanitized}.pdf`;
}

function extractQpdfWarnings(text: string) {
    return text
        .split(/\r?\n/u)
        .map(line => line.trim())
        .filter(Boolean)
        .filter(line => !/^checking /iu.test(line));
}

class PdfConformanceWorkerStartupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PdfConformanceWorkerStartupError';
    }
}

function getPdfConformanceWorkerPath() {
    const defaultPath = join(__dirname, PDF_CONFORMANCE_WORKER_FILENAME);
    const unpackedPath = defaultPath.replace('app.asar', 'app.asar.unpacked');
    if (unpackedPath !== defaultPath && existsSync(unpackedPath)) {
        return unpackedPath;
    }

    return defaultPath;
}

function runPdfConformanceWorker(filePath: string) {
    return new Promise<IPdfConformanceProfile>((resolve, reject) => {
        let worker: Worker;
        try {
            worker = new Worker(getPdfConformanceWorkerPath(), { workerData: { filePath } });
        } catch (error) {
            reject(new PdfConformanceWorkerStartupError(
                `PDF conformance worker failed to start: ${getErrorMessage(error)}`,
            ));
            return;
        }

        let settled = false;
        let workerOnline = false;
        let timeoutHandle: NodeJS.Timeout | null = null;
        let drainHandle: NodeJS.Timeout | null = null;

        const cleanupWorker = () => {
            worker.removeAllListeners('message');
            worker.removeAllListeners('error');
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
        };

        const clearDrainTimer = () => {
            if (!drainHandle) {
                return;
            }

            clearTimeout(drainHandle);
            drainHandle = null;
        };

        const scheduleWorkerDrain = () => {
            clearDrainTimer();
            drainHandle = setTimeout(() => {
                drainHandle = null;
                void worker.terminate().catch(() => undefined);
            }, PDF_CONFORMANCE_WORKER_DRAIN_TIMEOUT_MS);
            drainHandle.unref?.();
        };

        const finalize = (callback: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanupWorker();
            callback();
            scheduleWorkerDrain();
        };

        worker.once('online', () => {
            workerOnline = true;
        });

        worker.once('message', (message: unknown) => {
            finalize(() => {
                if (!message || typeof message !== 'object') {
                    reject(new Error('PDF conformance worker returned an invalid payload'));
                    return;
                }

                const payload = message as {
                    type?: unknown;
                    ok?: unknown;
                    error?: unknown;
                    data?: unknown;
                };

                if (payload.type !== 'result') {
                    reject(new Error('PDF conformance worker returned an invalid payload'));
                    return;
                }
                if (payload.ok !== true) {
                    reject(new Error(typeof payload.error === 'string' ? payload.error : 'PDF conformance worker failed'));
                    return;
                }

                resolve((payload.data as IPdfConformanceProfile) ?? {
                    ...createDefaultPdfConformanceProfile(),
                    saveRestrictions: [],
                });
            });
        });

        worker.once('error', (error) => {
            finalize(() => {
                if (!workerOnline) {
                    reject(new PdfConformanceWorkerStartupError(
                        `PDF conformance worker failed before becoming ready: ${getErrorMessage(error)}`,
                    ));
                    return;
                }

                reject(error);
            });
        });

        worker.once('exit', (code) => {
            clearDrainTimer();
            if (settled || code === 0) {
                return;
            }

            finalize(() => {
                if (!workerOnline) {
                    reject(new PdfConformanceWorkerStartupError(
                        `PDF conformance worker exited during startup with code ${code}`,
                    ));
                    return;
                }

                reject(new Error(`PDF conformance worker exited with code ${code}`));
            });
        });

        timeoutHandle = setTimeout(() => {
            finalize(() => {
                reject(new Error('PDF conformance worker timed out'));
            });
        }, 60_000);
        timeoutHandle.unref?.();
    });
}

export async function analyzePdfConformanceFile(filePath: string): Promise<IPdfConformanceProfile> {
    try {
        return await runPdfConformanceWorker(filePath);
    } catch (error) {
        if (error instanceof PdfConformanceWorkerStartupError) {
            logger.warn(`PDF conformance worker unavailable for ${filePath}: ${error.message}`);
        } else {
            logger.warn(
                `PDF conformance worker failed for ${filePath}: ${
                    getErrorMessage(error)
                }`,
            );
        }
        throw error;
    }
}

export async function validatePdfData(
    data: Uint8Array,
    fileName?: string,
): Promise<IPdfValidationResult> {
    if (!(data instanceof Uint8Array) || data.byteLength === 0) {
        return {
            isValid: false,
            tool: 'qpdf',
            errors: ['PDF validation failed: empty document data'],
            warnings: [],
        };
    }

    const tempPath = join(
        app.getPath('temp'),
        `pdf-validate-${randomUUID()}-${sanitizeValidationFileName(fileName)}`,
    );

    await writeFile(tempPath, data);

    try {
        const qpdf = getNativeToolPaths().qpdf;
        const result = await runNativeToolCommand(qpdf, [
            '--check',
            tempPath,
        ], {
            timeoutMs: QPDF_VALIDATE_TIMEOUT_MS,
            commandLabel: 'qpdf(validate-pdf)',
        });

        return {
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [
                ...extractQpdfWarnings(result.stdout),
                ...extractQpdfWarnings(result.stderr),
            ],
        };
    } catch (error) {
        return {
            isValid: false,
            tool: 'qpdf',
            errors: [error instanceof Error ? error.message : 'PDF validation failed'],
            warnings: [],
        };
    } finally {
        await unlink(tempPath).catch(() => undefined);
    }
}
