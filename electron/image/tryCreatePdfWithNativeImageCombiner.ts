import { spawn } from 'child_process';
import {
    mkdtemp,
    open,
    readFile,
    rm,
    writeFile,
} from 'fs/promises';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import {
    dirname,
    extname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { resolveNativeToolPath } from '@electron/native-tools/resolveNativeToolPath';
import { verifyNativeToolProtocol } from '@electron/native-tools/runNativeToolCommand';
import { createNativeFallbackTestError } from '@electron/native-tools/createNativeFallbackTestError';
import { getErrorMessage } from '@electron/utils/error';
import { createLogger } from '@electron/utils/createLogger';
import { abortErrorFromSignal } from '@electron/utils/abort';
import {
    createDetachedChildProcessSpawnOptions,
    terminateDetachedChildProcess,
} from '@electron/utils/nativeChildProcess';

interface INativePdfImageCombineProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

interface INativePdfImageCombineOptions {
    maxPages?: number;
    onProgress?: (progress: INativePdfImageCombineProgress) => void;
    signal?: AbortSignal;
}

type TNativeProgressPayload = INativePdfImageCombineProgress & {type: 'progress';};
type TNativePdfImageCombineTermination =
    | {
        kind: 'resolve';
        ok: boolean;
    }
    | {
        kind: 'reject';
        error: Error;
    };

const logger = createLogger('nativePdfImageCombine');
const __dirname = dirname(fileURLToPath(import.meta.url));
const isPackaged = __dirname.includes('app.asar');
const SUPPORTED_NATIVE_BITMAP_EXTENSIONS = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.tif',
    '.tiff',
]);
const SUPPORTED_NATIVE_NETPBM_EXTENSIONS = new Set([
    '.pgm',
    '.ppm',
]);
const NATIVE_PDF_IMAGE_COMBINE_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_PDF_IMAGE_COMBINE_TIMEOUT_MS ?? `${5 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 10_000) {
        return 5 * 60 * 1000;
    }
    return parsed;
})();
const NATIVE_PDF_IMAGE_COMBINE_MAX_STDOUT_BUFFER_BYTES = 64 * 1024;
const NATIVE_PDF_IMAGE_COMBINE_TEST_ENABLE_ENV = 'EVB_PDF_IMAGE_COMBINE_ENABLE';
const PDF_HEADER_SCAN_BYTES = 1024;
const PDF_EOF_SCAN_BYTES = 1024 * 1024;

function getBinaryName() {
    return process.platform === 'win32'
        ? 'evb-pdf-image-combine.exe'
        : 'evb-pdf-image-combine';
}

export function isNativePdfImageCombineDisabled() {
    return process.env.EVB_PDF_IMAGE_COMBINE_DISABLE === '1'
        || (process.env.VITEST === 'true' && process.env[NATIVE_PDF_IMAGE_COMBINE_TEST_ENABLE_ENV] !== '1');
}

export function resolveNativePdfImageCombinePath() {
    return resolveNativeToolPath({
        binaryName: getBinaryName(),
        crateName: 'pdf-image-combine',
        currentDir: __dirname,
        envOverridePath: process.env.EVB_PDF_IMAGE_COMBINE_PATH,
        isPackaged,
    });
}

function canUseNativePdfImageCombine(inputPaths: string[], supportedExtensions: Set<string>) {
    return !isNativePdfImageCombineDisabled()
        && inputPaths.length > 0
        && inputPaths.every(path => supportedExtensions.has(extname(path).toLowerCase()))
        && inputPaths.every(canRepresentPathInNativeInputsFile);
}

export function isNativePdfImageCombineBitmapPath(inputPath: string) {
    return SUPPORTED_NATIVE_BITMAP_EXTENSIONS.has(extname(inputPath).toLowerCase());
}

function parseProgressPayload(value: unknown): TNativeProgressPayload | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const payload = value as Record<string, unknown>;
    if (payload.type !== 'progress') {
        return null;
    }
    if (
        typeof payload.processed !== 'number'
        || typeof payload.total !== 'number'
        || typeof payload.percent !== 'number'
        || typeof payload.elapsedMs !== 'number'
    ) {
        return null;
    }

    return {
        type: 'progress',
        processed: payload.processed,
        total: payload.total,
        percent: payload.percent,
        elapsedMs: payload.elapsedMs,
        estimatedRemainingMs: typeof payload.estimatedRemainingMs === 'number'
            ? payload.estimatedRemainingMs
            : null,
    };
}

function canRepresentPathInNativeInputsFile(inputPath: string) {
    return inputPath.length > 0
        && inputPath.trim() === inputPath
        && !/[\r\n]/u.test(inputPath);
}

function createNativeInputsFileContents(inputPaths: string[]) {
    if (!inputPaths.every(canRepresentPathInNativeInputsFile)) {
        throw new Error('Native image combine input paths must not contain leading/trailing whitespace or line breaks');
    }
    return `${inputPaths.join('\n')}\n`;
}

function includesAsciiToken(data: Uint8Array, token: string, start: number, end: number) {
    const tokenBytes = Buffer.from(token, 'ascii');
    const lastStart = end - tokenBytes.byteLength;
    for (let offset = start; offset <= lastStart; offset += 1) {
        let matches = true;
        for (let index = 0; index < tokenBytes.byteLength; index += 1) {
            if (data[offset + index] !== tokenBytes[index]) {
                matches = false;
                break;
            }
        }
        if (matches) {
            return true;
        }
    }
    return false;
}

async function isStructurallyPlausiblePdfFile(outputPath: string) {
    const handle = await open(outputPath, 'r');
    try {
        const fileStat = await handle.stat();
        if (!fileStat.isFile() || fileStat.size <= 0) {
            return false;
        }

        const headerLength = Math.min(fileStat.size, PDF_HEADER_SCAN_BYTES);
        const eofLength = Math.min(fileStat.size, PDF_EOF_SCAN_BYTES);
        const header = Buffer.alloc(headerLength);
        const eof = Buffer.alloc(eofLength);

        await handle.read(header, 0, headerLength, 0);
        await handle.read(eof, 0, eofLength, Math.max(0, fileStat.size - eofLength));

        return includesAsciiToken(header, '%PDF-', 0, header.byteLength)
            && includesAsciiToken(eof, '%%EOF', 0, eof.byteLength);
    } finally {
        await handle.close();
    }
}

async function readValidatedNativePdfOutput(outputPath: string) {
    let fallbackDetail: string | null = null;
    let fallbackCause: unknown;

    try {
        if (await isStructurallyPlausiblePdfFile(outputPath)) {
            return new Uint8Array(await readFile(outputPath));
        }
        logger.warn(`Native image PDF combine produced invalid PDF output at "${outputPath}"`);
        fallbackDetail = `native output at "${outputPath}" is not a structurally valid PDF`;
    } catch (error) {
        logger.warn(`Native image PDF combine output is unavailable at "${outputPath}": ${getErrorMessage(error)}`);
        fallbackDetail = `native output at "${outputPath}" could not be read`;
        fallbackCause = error;
    }

    await rm(outputPath, { force: true }).catch(() => undefined);
    const testFailure = fallbackDetail
        ? createNativeFallbackTestError(
            NATIVE_PDF_IMAGE_COMBINE_TEST_ENABLE_ENV,
            'Native image PDF combine',
            fallbackDetail,
            fallbackCause,
        )
        : null;
    if (testFailure) {
        throw testFailure;
    }
    return null;
}

async function validateNativePdfOutputFile(outputPath: string) {
    let fallbackDetail: string | null = null;
    let fallbackCause: unknown;

    try {
        if (await isStructurallyPlausiblePdfFile(outputPath)) {
            return true;
        }
        logger.warn(`Native image PDF combine produced invalid PDF output at "${outputPath}"`);
        fallbackDetail = `native output at "${outputPath}" is not a structurally valid PDF`;
    } catch (error) {
        logger.warn(`Native image PDF combine output is unavailable at "${outputPath}": ${getErrorMessage(error)}`);
        fallbackDetail = `native output at "${outputPath}" could not be read`;
        fallbackCause = error;
    }

    await rm(outputPath, { force: true }).catch(() => undefined);
    const testFailure = fallbackDetail
        ? createNativeFallbackTestError(
            NATIVE_PDF_IMAGE_COMBINE_TEST_ENABLE_ENV,
            'Native image PDF combine',
            fallbackDetail,
            fallbackCause,
        )
        : null;
    if (testFailure) {
        throw testFailure;
    }
    return false;
}

export async function tryCreatePdfWithNativeImageCombiner(
    inputPaths: string[],
    options?: INativePdfImageCombineOptions,
): Promise<Uint8Array | null> {
    if (!canUseNativePdfImageCombine(inputPaths, SUPPORTED_NATIVE_BITMAP_EXTENSIONS)) {
        return null;
    }

    return createPdfWithNativeImageCombiner(inputPaths, options);
}

export async function tryWritePdfWithNativeImageCombiner(
    inputPaths: string[],
    outputPath: string,
    options?: INativePdfImageCombineOptions,
): Promise<boolean> {
    if (!canUseNativePdfImageCombine(inputPaths, SUPPORTED_NATIVE_BITMAP_EXTENSIONS)) {
        return false;
    }

    return writePdfWithNativeImageCombiner(inputPaths, outputPath, options);
}

export async function tryBuildOptimizedPdfWithNativeImageCombiner(
    imagePaths: string[],
    dpi: number,
    onPageProcessed?: (pageNum: number, totalPages: number) => void,
    options: Pick<INativePdfImageCombineOptions, 'signal'> = {},
): Promise<Uint8Array | null> {
    if (!Number.isFinite(dpi) || dpi <= 0 || !canUseNativePdfImageCombine(imagePaths, SUPPORTED_NATIVE_NETPBM_EXTENSIONS)) {
        return null;
    }

    return createPdfWithNativeImageCombiner(imagePaths, {
        ...(onPageProcessed ? {onProgress: progress => onPageProcessed(progress.processed, progress.total)} : {}),
        ...(options.signal === undefined ? {} : {signal: options.signal}),
    }, [
        '--dpi',
        String(Math.round(dpi)),
    ]);
}

async function createPdfWithNativeImageCombiner(
    inputPaths: string[],
    options?: INativePdfImageCombineOptions,
    extraArgs: string[] = [],
) {
    const binaryPath = resolveNativePdfImageCombinePath();
    if (!binaryPath) {
        const testFailure = createNativeFallbackTestError(
            NATIVE_PDF_IMAGE_COMBINE_TEST_ENABLE_ENV,
            'Native image PDF combine',
            'native binary path could not be resolved',
        );
        if (testFailure) {
            throw testFailure;
        }
        return null;
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'pdf-image-combine-'));
    const outputPath = join(tempDir, `${randomUUID()}.pdf`);
    const inputsPath = join(tempDir, 'inputs.txt');

    try {
        await writeFile(inputsPath, createNativeInputsFileContents(inputPaths), 'utf8');
        const ok = await runNativePdfImageCombine(binaryPath, outputPath, [], options, [
            ...extraArgs,
            '--inputs-file',
            inputsPath,
        ]);
        if (!ok) {
            return null;
        }
        return await readValidatedNativePdfOutput(outputPath);
    } finally {
        await rm(tempDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
    }
}

async function writePdfWithNativeImageCombiner(
    inputPaths: string[],
    outputPath: string,
    options?: INativePdfImageCombineOptions,
) {
    const binaryPath = resolveNativePdfImageCombinePath();
    if (!binaryPath) {
        const testFailure = createNativeFallbackTestError(
            NATIVE_PDF_IMAGE_COMBINE_TEST_ENABLE_ENV,
            'Native image PDF combine',
            'native binary path could not be resolved',
        );
        if (testFailure) {
            throw testFailure;
        }
        return false;
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'pdf-image-combine-'));
    const inputsPath = join(tempDir, 'inputs.txt');

    try {
        await writeFile(inputsPath, createNativeInputsFileContents(inputPaths), 'utf8');
        const ok = await runNativePdfImageCombine(binaryPath, outputPath, [], options, [
            '--inputs-file',
            inputsPath,
        ]);
        if (!ok) {
            await rm(outputPath, { force: true }).catch(() => undefined);
            return false;
        }
        return await validateNativePdfOutputFile(outputPath);
    } catch (error) {
        if (
            error instanceof Error
            && error.message.startsWith('Native image PDF combine fallback is not allowed in tests:')
        ) {
            await rm(outputPath, { force: true }).catch(() => undefined);
        }
        throw error;
    } finally {
        await rm(tempDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
    }
}

async function runNativePdfImageCombine(
    binaryPath: string,
    outputPath: string,
    inputPaths: string[],
    options?: INativePdfImageCombineOptions,
    extraArgs: string[] = [],
) {
    if (options?.signal?.aborted) {
        throw abortErrorFromSignal(options.signal);
    }

    const args = [
        '--output',
        outputPath,
        '--json-progress',
        ...extraArgs,
    ];
    if (inputPaths.length > 0) {
        args.push('--', ...inputPaths);
    }
    const maxPages = normalizeMaxPagesForEnv(options?.maxPages);
    const env = maxPages
        ? {
            ...process.env,
            EVB_PDF_COMBINE_MAX_PAGES: maxPages,
        }
        : undefined;

    await verifyNativeToolProtocol(binaryPath, {
        ...(env ? { env } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
    });
    if (options?.signal?.aborted) {
        throw abortErrorFromSignal(options.signal);
    }

    return new Promise<boolean>((resolve, reject) => {
        const proc = spawn(binaryPath, args, createDetachedChildProcessSpawnOptions({
            ...(env ? { env } : {}),
            shell: false,
            windowsHide: true,
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
        }));

        let settled = false;
        let stdoutBuffer = '';
        let stderr = '';
        let abortHandler: (() => void) | null = null;
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        let forceSettleHandle: ReturnType<typeof setTimeout> | null = null;
        let pendingTermination: TNativePdfImageCombineTermination | null = null;

        const cleanup = () => {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            if (forceSettleHandle) {
                clearTimeout(forceSettleHandle);
                forceSettleHandle = null;
            }
            if (abortHandler) {
                options?.signal?.removeEventListener('abort', abortHandler);
                abortHandler = null;
            }
        };

        const finish = (ok: boolean) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(ok);
        };

        const fail = (error: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(error);
        };

        const createFailure = (detail: string, cause?: unknown) => createNativeFallbackTestError(
            NATIVE_PDF_IMAGE_COMBINE_TEST_ENABLE_ENV,
            'Native image PDF combine',
            detail,
            cause,
        );

        const finishFailure = (detail: string, cause?: unknown) => {
            const failure = createFailure(detail, cause);
            if (failure) {
                fail(failure);
                return;
            }
            finish(false);
        };

        const requestFailureTermination = (detail: string, cause?: unknown) => {
            const failure = createFailure(detail, cause);
            requestTermination(failure
                ? {
                    kind: 'reject',
                    error: failure,
                }
                : {
                    kind: 'resolve',
                    ok: false,
                });
        };

        const settleAfterTermination = (completion: TNativePdfImageCombineTermination) => {
            if (pendingTermination !== completion) {
                return;
            }
            pendingTermination = null;
            if (completion.kind === 'reject') {
                fail(completion.error);
                return;
            }
            finish(completion.ok);
        };

        const requestTermination = (completion: TNativePdfImageCombineTermination) => {
            if (settled || pendingTermination) {
                return;
            }
            pendingTermination = completion;
            proc.stdout?.removeAllListeners('data');
            proc.stderr?.removeAllListeners('data');
            proc.stdout?.destroy?.();
            proc.stderr?.destroy?.();
            void terminateDetachedChildProcess(proc, 1_000)
                .finally(() => settleAfterTermination(completion));
            forceSettleHandle = setTimeout(() => {
                settleAfterTermination(completion);
            }, 3_000);
            forceSettleHandle.unref?.();
        };

        const handleProgressLine = (line: string) => {
            if (!line.trim() || !options?.onProgress) {
                return;
            }
            try {
                const payload = parseProgressPayload(JSON.parse(line));
                if (payload) {
                    options.onProgress({
                        processed: payload.processed,
                        total: payload.total,
                        percent: payload.percent,
                        elapsedMs: payload.elapsedMs,
                        estimatedRemainingMs: payload.estimatedRemainingMs,
                    });
                }
            } catch {
                return;
            }
        };

        timeoutHandle = setTimeout(() => {
            logger.warn(`Native image PDF combine timed out after ${NATIVE_PDF_IMAGE_COMBINE_TIMEOUT_MS}ms`);
            requestFailureTermination(`native process timed out after ${NATIVE_PDF_IMAGE_COMBINE_TIMEOUT_MS}ms`);
        }, NATIVE_PDF_IMAGE_COMBINE_TIMEOUT_MS);
        timeoutHandle.unref?.();

        if (options?.signal) {
            abortHandler = () => {
                requestTermination({
                    kind: 'reject',
                    error: abortErrorFromSignal(options.signal!),
                });
            };
            options.signal.addEventListener('abort', abortHandler, { once: true });
            if (options.signal.aborted) {
                abortHandler();
            }
        }

        proc.stdout?.on('data', (data: Buffer) => {
            stdoutBuffer += data.toString('utf8');
            if (Buffer.byteLength(stdoutBuffer, 'utf8') > NATIVE_PDF_IMAGE_COMBINE_MAX_STDOUT_BUFFER_BYTES) {
                logger.warn(`Native image PDF combine stdout line exceeded ${NATIVE_PDF_IMAGE_COMBINE_MAX_STDOUT_BUFFER_BYTES} bytes`);
                requestFailureTermination(
                    `native stdout line exceeded ${NATIVE_PDF_IMAGE_COMBINE_MAX_STDOUT_BUFFER_BYTES} bytes`,
                );
                return;
            }
            let lineBreak = stdoutBuffer.indexOf('\n');
            while (lineBreak >= 0) {
                const line = stdoutBuffer.slice(0, lineBreak);
                stdoutBuffer = stdoutBuffer.slice(lineBreak + 1);
                handleProgressLine(line);
                lineBreak = stdoutBuffer.indexOf('\n');
            }
        });

        proc.stderr?.on('data', (data: Buffer) => {
            stderr = `${stderr}${data.toString('utf8')}`.slice(-8_192);
        });

        proc.on('error', (error) => {
            logger.warn(`Native image PDF combine failed to start: ${getErrorMessage(error)}`);
            finishFailure('native process failed to start', error);
        });

        proc.on('close', (code) => {
            if (settled) {
                return;
            }
            if (pendingTermination) {
                settleAfterTermination(pendingTermination);
                return;
            }
            if (stdoutBuffer) {
                handleProgressLine(stdoutBuffer);
                stdoutBuffer = '';
            }
            if (code !== 0) {
                const detail = stderr.trim();
                logger.debug(`Native image PDF combine exited with code ${code}${detail ? `: ${detail}` : ''}`);
                finishFailure(`native process exited with code ${code}${detail ? `: ${detail}` : ''}`);
                return;
            }
            finish(true);
        });
    });
}

function normalizeMaxPagesForEnv(value: number | undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
        return null;
    }
    return String(Math.trunc(value));
}
