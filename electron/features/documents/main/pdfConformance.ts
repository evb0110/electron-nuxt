import { randomUUID } from 'node:crypto';
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
import type {
    IPdfConformanceProfile,
    IPdfValidationResult,
} from '@contracts/pdfConformance';
import { createDefaultPdfConformanceProfile } from '@pdf-core/pdfConformanceHelpers';
import { runNativeToolCommand } from '@electron/native-tools/exec';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { getNativeToolPaths } from '@electron/native-tools/paths';
import { createLogger } from '@electron/utils/logger';
import { getErrorMessage } from '@electron/utils/error';
import {
    resolveUnpackedWorkerPath,
    runResultWorkerTask,
} from '@electron/utils/workerTask';
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';

const logger = createLogger('documents-pdfConformance');
const QPDF_VALIDATE_TIMEOUT_MS = 30_000;
const PDF_CONFORMANCE_WORKER_FILENAME = WORKER_BUNDLES_BY_ID['pdf-conformance'].fileName;
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
    return resolveUnpackedWorkerPath(__dirname, PDF_CONFORMANCE_WORKER_FILENAME);
}

function decodePdfConformanceResult(data: unknown): IPdfConformanceProfile | null {
    if (data === undefined) {
        return {
            ...createDefaultPdfConformanceProfile(),
            saveRestrictions: [],
        };
    }
    if (!data || typeof data !== 'object') {
        return null;
    }
    return data as IPdfConformanceProfile;
}

function createDefaultPdfConformanceResult(): IPdfConformanceProfile {
    return {
        ...createDefaultPdfConformanceProfile(),
        saveRestrictions: [],
    };
}

function runPdfConformanceWorker(filePath: string) {
    return runResultWorkerTask<IPdfConformanceProfile>({
        workerPath: getPdfConformanceWorkerPath(),
        workerData: { filePath },
        invalidPayloadMessage: 'PDF conformance worker returned an invalid payload',
        invalidResultMessage: 'PDF conformance worker returned an invalid payload',
        createStartupError: (message) => new PdfConformanceWorkerStartupError(
            `PDF conformance worker failed before becoming ready: ${message}`,
        ),
        createStartError: (message) => new PdfConformanceWorkerStartupError(
            `PDF conformance worker failed to start: ${message}`,
        ),
        createStartupExitError: (code) => new PdfConformanceWorkerStartupError(
            `PDF conformance worker exited during startup with code ${code}`,
        ),
        createWorkerExitError: (code) => new Error(`PDF conformance worker exited with code ${code}`),
        timeoutMs: 60_000,
        decodeResult: (data) => {
            if (data === undefined) {
                return createDefaultPdfConformanceResult();
            }
            return decodePdfConformanceResult(data);
        },
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

function createEmptyPdfValidationResult(): IPdfValidationResult {
    return {
        isValid: false,
        tool: 'qpdf',
        errors: ['PDF validation failed: empty document data'],
        warnings: [],
    };
}

export async function validatePdfFile(filePath: string): Promise<IPdfValidationResult> {
    try {
        const qpdf = getNativeToolPaths().qpdf;
        const result = await runNativeToolCommand(qpdf, [
            '--check',
            filePath,
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
    }
}

export async function validatePdfData(
    data: Uint8Array,
    fileName?: string,
): Promise<IPdfValidationResult> {
    if (!(data instanceof Uint8Array) || data.byteLength === 0) {
        return createEmptyPdfValidationResult();
    }

    const tempPath = join(
        getAppTempDir(),
        `pdf-validate-${randomUUID()}-${sanitizeValidationFileName(fileName)}`,
    );

    await writeFile(tempPath, data);

    try {
        return await validatePdfFile(tempPath);
    } finally {
        await unlink(tempPath).catch(() => undefined);
    }
}
