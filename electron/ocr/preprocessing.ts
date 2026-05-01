import {spawn} from 'child_process';
import { existsSync } from 'fs';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { app } from 'electron';
import { createLogger } from '@electron/utils/logger';
import { resolvePlatformArchTag } from '@electron/utils/platform-arch';
import { appendTextChunkWithByteCap } from '@electron/native-tools/output-buffer';

const log = createLogger('preprocessing');

interface IPreprocessingOptions {
    binary: string;
    args: string[];
    timeout?: number;
    signal?: AbortSignal;
}

interface IPreprocessingResult {
    success: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
}

interface IPreprocessingValidationResult {
    valid: boolean;
    available: string[];
    missing: string[];
}

const PREPROCESS_KILL_GRACE_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_PREPROCESS_KILL_GRACE_MS ?? '2000', 10);
    if (!Number.isFinite(parsed) || parsed < 250) {
        return 2_000;
    }
    return parsed;
})();
const PREPROCESS_MAX_STDOUT_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_PREPROCESS_MAX_STDOUT_BYTES ?? '131072', 10);
    if (!Number.isFinite(parsed) || parsed < 1_024) {
        return 131_072;
    }
    return parsed;
})();
const PREPROCESS_MAX_STDERR_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_PREPROCESS_MAX_STDERR_BYTES ?? '131072', 10);
    if (!Number.isFinite(parsed) || parsed < 1_024) {
        return 131_072;
    }
    return parsed;
})();
const PREPROCESS_VERSION_PROBE_TIMEOUT_MS = 3_000;

let preprocessingValidationPromise: Promise<IPreprocessingValidationResult> | null = null;


/**
 * Get paths to preprocessing binaries
 * Falls back gracefully if binaries don't exist
 */
interface IPreprocessingBinaries {
    leptonica: string | null;
    unpaper: string | null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function getPreprocessingBinaries(): IPreprocessingBinaries {
    let resourcesBase: string;

    if (app.isPackaged) {
        resourcesBase = process.resourcesPath;
    } else {
        // Development: in bundled code, __dirname is dist-electron, so go up one level
        // In source code from dist-electron/ocr, we'd go ../.. but esbuild bundles to dist-electron/main.js
        // So __dirname will be dist-electron, and we need to go up once: ../resources
        resourcesBase = join(__dirname, '..', 'resources');
    }

    const tesseractDir = join(resourcesBase, 'tesseract');
    const arch = resolvePlatformArchTag();

    const binDir = join(tesseractDir, arch, 'bin');
    const ext = process.platform === 'win32' ? '.exe' : '';

    const leptonica = join(binDir, `leptonica${ext}`);
    const unpaper = join(binDir, `unpaper${ext}`);

    // Debug logging
    log.debug(`getPreprocessingBinaries: __dirname=${__dirname}, resourcesBase=${resourcesBase}, arch=${arch}, binDir=${binDir}`);
    log.debug(`  leptonica path: ${leptonica}, exists: ${existsSync(leptonica)}`);
    log.debug(`  unpaper path: ${unpaper}, exists: ${existsSync(unpaper)}`);

    return {
        leptonica: existsSync(leptonica) ? leptonica : null,
        unpaper: existsSync(unpaper) ? unpaper : null,
    };
}

async function isBinaryRunnable(binaryPath: string): Promise<boolean> {
    if (!existsSync(binaryPath)) {
        return false;
    }

    return new Promise((resolve) => {
        const proc = spawn(binaryPath, ['--version'], {
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
        });

        let settled = false;
        const finalize = (value: boolean) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeoutHandle);
            resolve(value);
        };

        const timeoutHandle = setTimeout(() => {
            try {
                proc.kill('SIGKILL');
            } catch {
                // Ignore termination errors when probing the binary.
            }
            finalize(false);
        }, PREPROCESS_VERSION_PROBE_TIMEOUT_MS);
        timeoutHandle.unref?.();

        proc.once('error', () => finalize(false));
        proc.once('close', code => finalize(code === 0));
    });
}

async function buildPreprocessingValidation(): Promise<IPreprocessingValidationResult> {
    const bins = getPreprocessingBinaries();
    const unpaperRunnable = bins.unpaper ? await isBinaryRunnable(bins.unpaper) : false;
    const available: string[] = [];
    const missing: string[] = [];

    if (unpaperRunnable) {
        available.push('unpaper');
    } else {
        missing.push('unpaper');
    }

    if (bins.leptonica) {
        available.push('leptonica');
    } else {
        missing.push('leptonica');
    }

    return {
        // unpaper is required for preprocessing - leptonica is optional/diagnostic
        valid: unpaperRunnable,
        available,
        missing,
    };
}

/**
 * Generic preprocessing tool runner
 * Executes preprocessing binaries with given arguments
 */
async function runPreprocessing(
    options: IPreprocessingOptions,
): Promise<IPreprocessingResult> {
    log.debug(`Running: ${options.binary} ${options.args.join(' ')}`);
    if (options.signal?.aborted) {
        return {
            success: false,
            error: 'Preprocessing aborted',
        };
    }

    if (!existsSync(options.binary)) {
        const error = `Binary not found: ${options.binary}`;
        log.debug(`Error: ${error}`);
        return {
            success: false,
            error, 
        };
    }

    return new Promise((resolve) => {
        const proc = spawn(options.binary, options.args);

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let settled = false;
        let killHandle: NodeJS.Timeout | null = null;
        let forceFinalizeHandle: NodeJS.Timeout | null = null;

        const timeout = options.timeout || 60000; // 60 seconds default
        const timeoutHandle = setTimeout(() => {
            timedOut = true;
            log.debug('Process timeout');
            try {
                proc.kill('SIGTERM');
            } catch {
                // Process may have exited already.
            }
            killHandle = setTimeout(() => {
                try {
                    proc.kill('SIGKILL');
                } catch {
                    // Process may have exited already.
                }
            }, PREPROCESS_KILL_GRACE_MS);
            killHandle.unref?.();

            forceFinalizeHandle = setTimeout(() => {
                const stderrSummary = stderrTruncated
                    ? `[stderr truncated to ${PREPROCESS_MAX_STDERR_BYTES} bytes]\n${stderr}`
                    : stderr;
                finalize({
                    success: false,
                    error: `Process timed out after ${timeout}ms`,
                    stderr: stderrSummary,
                });
            }, PREPROCESS_KILL_GRACE_MS + 1_000);
            forceFinalizeHandle.unref?.();
        }, timeout);
        timeoutHandle.unref?.();

        const finalize = (result: IPreprocessingResult) => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timeoutHandle);
            if (killHandle) {
                clearTimeout(killHandle);
                killHandle = null;
            }
            if (forceFinalizeHandle) {
                clearTimeout(forceFinalizeHandle);
                forceFinalizeHandle = null;
            }
            if (options.signal && abortHandler) {
                options.signal.removeEventListener('abort', abortHandler);
            }
            resolve(result);
        };

        const abortHandler = options.signal
            ? () => {
                const abortError = new Error('Preprocessing aborted');
                timedOut = false;
                try {
                    proc.kill('SIGTERM');
                } catch {
                    // Process may have exited already.
                }
                killHandle = setTimeout(() => {
                    try {
                        proc.kill('SIGKILL');
                    } catch {
                        // Process may have exited already.
                    }
                }, PREPROCESS_KILL_GRACE_MS);
                killHandle.unref?.();

                forceFinalizeHandle = setTimeout(() => {
                    finalize({
                        success: false,
                        error: abortError.message,
                    });
                }, PREPROCESS_KILL_GRACE_MS + 1_000);
                forceFinalizeHandle.unref?.();
            }
            : null;
        if (options.signal && abortHandler) {
            options.signal.addEventListener('abort', abortHandler, { once: true });
        }

        proc.stdout.on('data', (data: Buffer) => {
            const appended = appendTextChunkWithByteCap(stdout, data, PREPROCESS_MAX_STDOUT_BYTES);
            stdout = appended.text;
            stdoutTruncated = stdoutTruncated || appended.truncated;
        });

        proc.stderr.on('data', (data: Buffer) => {
            const msg = data.toString();
            const appended = appendTextChunkWithByteCap(stderr, data, PREPROCESS_MAX_STDERR_BYTES);
            stderr = appended.text;
            stderrTruncated = stderrTruncated || appended.truncated;
            log.debug(`stderr: ${msg.trim()}`);
        });

        proc.on('close', (code) => {
            if (timedOut) {
                log.debug(`Process timed out after ${timeout}ms`);
                const stderrSummary = stderrTruncated
                    ? `[stderr truncated to ${PREPROCESS_MAX_STDERR_BYTES} bytes]\n${stderr}`
                    : stderr;
                finalize({
                    success: false,
                    error: `Process timed out after ${timeout}ms`,
                    stderr: stderrSummary,
                });
            } else if (code === 0) {
                log.debug('Process completed successfully');
                const stdoutSummary = stdoutTruncated
                    ? `[stdout truncated to ${PREPROCESS_MAX_STDOUT_BYTES} bytes]\n${stdout}`
                    : stdout;
                const stderrSummary = stderrTruncated
                    ? `[stderr truncated to ${PREPROCESS_MAX_STDERR_BYTES} bytes]\n${stderr}`
                    : stderr;
                finalize({
                    success: true,
                    stdout: stdoutSummary,
                    stderr: stderrSummary,
                });
            } else {
                log.debug(`Process exited with code ${code}`);
                const stderrSummary = stderrTruncated
                    ? `[stderr truncated to ${PREPROCESS_MAX_STDERR_BYTES} bytes]\n${stderr}`
                    : stderr;
                finalize({
                    success: false,
                    error: stderrSummary || `Process exited with code ${code}`,
                    stderr: stderrSummary,
                });
            }
        });

        proc.on('error', (err) => {
            log.debug(`Process error: ${err.message}`);
            const stderrSummary = stderrTruncated
                ? `[stderr truncated to ${PREPROCESS_MAX_STDERR_BYTES} bytes]\n${stderr}`
                : stderr;
            finalize({
                success: false,
                error: err.message,
                stderr: stderrSummary,
            });
        });
    });
}

/**
 * Clean a scanned document with Unpaper
 * Removes noise, marks, and artifacts from scanned pages
 *
 * @param inputPath Path to input image
 * @param outputPath Path to write output image
 * @param aggressive If true, applies stronger cleaning filters
 */
async function cleanScannedPageWithUnpaper(
    inputPath: string,
    outputPath: string,
    aggressive = false,
    signal?: AbortSignal,
): Promise<IPreprocessingResult> {
    const bins = getPreprocessingBinaries();

    if (!bins.unpaper) {
        return {
            success: false,
            error: 'Unpaper preprocessing binary is not bundled for this platform/arch.',
        };
    }

    const args = [
        '--layout',
        'single',         // Single-page layout
        '--deskew',                   // Deskew
        '--cleanup',                  // Remove artifacts
        '--no-mask-center',          // Don't mask center (preserve document)
        '--despeckle',               // Remove small speckles
    ];

    if (aggressive) {
        args.push(
            '--noise-filter',        // Aggressive noise reduction
            '--blur-filter',          // Slightly blur before OCR (helps with binarization)
        );
    }

    args.push(inputPath, outputPath);

    return runPreprocessing({
        binary: bins.unpaper,
        args,
        timeout: 30000,
        signal,
    });
}

/**
 * Apply full preprocessing pipeline
 * Combines deskew + cleanup for best OCR results
 *
 * @param inputPath Path to input image
 * @param outputPath Path to write output image
 */
export async function preprocessPageForOcr(
    inputPath: string,
    outputPath: string,
    signal?: AbortSignal,
): Promise<IPreprocessingResult> {
    log.debug(`Preprocessing page for OCR: ${inputPath}`);

    return cleanScannedPageWithUnpaper(inputPath, outputPath, false, signal);
}

/**
 * Validate preprocessing setup
 * Check if required binaries are available
 */
export async function validatePreprocessingSetup(): Promise<IPreprocessingValidationResult> {
    if (!preprocessingValidationPromise) {
        preprocessingValidationPromise = buildPreprocessingValidation().catch((error) => {
            preprocessingValidationPromise = null;
            throw error;
        });
    }

    return preprocessingValidationPromise;
}
