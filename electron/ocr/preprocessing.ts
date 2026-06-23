import {spawn} from 'child_process';
import { existsSync } from 'fs';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { app } from 'electron';
import { buildTesseractEnv } from '@electron/ocr/buildTesseractEnv';
import { createLogger } from '@electron/utils/createLogger';
import { resolvePlatformArchTag } from '@electron/utils/platformArch';
import { appendTextChunkWithByteCap } from '@electron/native-tools/appendTextChunkWithByteCap';
import { resolveOcrResourcesBase } from '@electron/ocr/resolveOcrResourcesBase';
import {
    createDetachedChildProcessSpawnOptions,
    terminateDetachedChildProcess,
} from '@electron/utils/nativeChildProcess';
import type { IPreprocessingValidationResult } from '@contracts/electronApiOcr';

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

const PREPROCESS_KILL_GRACE_MS = parseIntegerEnv('EVB_PREPROCESS_KILL_GRACE_MS', 2_000, 250);
const PREPROCESS_MAX_STDOUT_BYTES = parseIntegerEnv('EVB_PREPROCESS_MAX_STDOUT_BYTES', 131_072, 1_024);
const PREPROCESS_MAX_STDERR_BYTES = parseIntegerEnv('EVB_PREPROCESS_MAX_STDERR_BYTES', 131_072, 1_024);
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

function parseIntegerEnv(name: string, fallback: number, minimum: number) {
    const parsed = Number.parseInt(process.env[name] ?? `${fallback}`, 10);
    if (!Number.isFinite(parsed) || parsed < minimum) {
        return fallback;
    }
    return parsed;
}

function formatTruncatedOutput(text: string, truncated: boolean, maxBytes: number, label: 'stdout' | 'stderr') {
    return truncated
        ? `[${label} truncated to ${maxBytes} bytes]\n${text}`
        : text;
}

function prependPathEntry(entry: string, existing: string | undefined) {
    return existing && existing.length > 0 ? `${entry}${process.platform === 'win32' ? ';' : ':'}${existing}` : entry;
}

function buildPreprocessingEnv(binary: string): NodeJS.ProcessEnv {
    const binDir = dirname(binary);
    const resourcesBase = resolveOcrResourcesBase(__dirname, app.isPackaged);
    const env = buildTesseractEnv(join(resourcesBase, 'tesseract', 'tessdata'));
    env.PATH = prependPathEntry(binDir, env.PATH);
    return env;
}

function spawnPreprocessingProcess(binary: string, args: string[], stdio: 'ignore' | 'pipe') {
    return spawn(binary, args, createDetachedChildProcessSpawnOptions({
        env: buildPreprocessingEnv(binary),
        shell: false,
        windowsHide: true,
        stdio: stdio === 'ignore'
            ? 'ignore'
            : [
                'ignore',
                'pipe',
                'pipe',
            ],
    }));
}

function terminatePreprocessingProcess(proc: ReturnType<typeof spawn>) {
    return terminateDetachedChildProcess(proc, PREPROCESS_KILL_GRACE_MS);
}

function getPreprocessingBinaries(): IPreprocessingBinaries {
    const resourcesBase = resolveOcrResourcesBase(__dirname, app.isPackaged);
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
        const proc = spawnPreprocessingProcess(binaryPath, ['--version'], 'ignore');

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
            void terminatePreprocessingProcess(proc).finally(() => finalize(false));
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
        const proc = spawnPreprocessingProcess(options.binary, options.args, 'pipe');

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let settled = false;
        let forceFinalizeHandle: NodeJS.Timeout | null = null;

        const timeout = options.timeout && options.timeout > 0 ? options.timeout : 60000; // 60 seconds default
        const timeoutHandle = setTimeout(() => {
            timedOut = true;
            log.debug('Process timeout');
            void terminatePreprocessingProcess(proc);

            forceFinalizeHandle = setTimeout(() => {
                finalize({
                    success: false,
                    error: `Process timed out after ${timeout}ms`,
                    stderr: formatTruncatedOutput(stderr, stderrTruncated, PREPROCESS_MAX_STDERR_BYTES, 'stderr'),
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
                void terminatePreprocessingProcess(proc).finally(() => {
                    finalize({
                        success: false,
                        error: abortError.message,
                    });
                });

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

        proc.stdout?.on('data', (data: Buffer) => {
            const appended = appendTextChunkWithByteCap(stdout, data, PREPROCESS_MAX_STDOUT_BYTES);
            stdout = appended.text;
            stdoutTruncated = stdoutTruncated || appended.truncated;
        });

        proc.stderr?.on('data', (data: Buffer) => {
            const msg = data.toString();
            const appended = appendTextChunkWithByteCap(stderr, data, PREPROCESS_MAX_STDERR_BYTES);
            stderr = appended.text;
            stderrTruncated = stderrTruncated || appended.truncated;
            log.debug(`stderr: ${msg.trim()}`);
        });

        proc.on('close', (code) => {
            if (timedOut) {
                log.debug(`Process timed out after ${timeout}ms`);
                finalize({
                    success: false,
                    error: `Process timed out after ${timeout}ms`,
                    stderr: formatTruncatedOutput(stderr, stderrTruncated, PREPROCESS_MAX_STDERR_BYTES, 'stderr'),
                });
            } else if (code === 0) {
                log.debug('Process completed successfully');
                finalize({
                    success: true,
                    stdout: formatTruncatedOutput(stdout, stdoutTruncated, PREPROCESS_MAX_STDOUT_BYTES, 'stdout'),
                    stderr: formatTruncatedOutput(stderr, stderrTruncated, PREPROCESS_MAX_STDERR_BYTES, 'stderr'),
                });
            } else {
                log.debug(`Process exited with code ${code}`);
                const stderrSummary = formatTruncatedOutput(stderr, stderrTruncated, PREPROCESS_MAX_STDERR_BYTES, 'stderr');
                finalize({
                    success: false,
                    error: stderrSummary || `Process exited with code ${code}`,
                    stderr: stderrSummary,
                });
            }
        });

        proc.on('error', (err) => {
            log.debug(`Process error: ${err.message}`);
            const stderrSummary = formatTruncatedOutput(stderr, stderrTruncated, PREPROCESS_MAX_STDERR_BYTES, 'stderr');
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

    const preprocessingOptions: IPreprocessingOptions = {
        binary: bins.unpaper,
        args,
        timeout: 30000,
    };
    if (signal !== undefined) {
        preprocessingOptions.signal = signal;
    }
    return runPreprocessing(preprocessingOptions);
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
    preprocessingValidationPromise ??= buildPreprocessingValidation().catch((error) => {
        preprocessingValidationPromise = null;
        throw error;
    });

    return preprocessingValidationPromise;
}
