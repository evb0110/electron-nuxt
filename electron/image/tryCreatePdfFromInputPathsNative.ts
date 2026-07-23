import {
    copyFile,
    mkdtemp,
    readFile,
    rm,
    stat,
    statfs,
} from 'fs/promises';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import {
    extname,
    dirname,
    join,
} from 'path';
import {
    cancelConversion,
    convertDjvuToPdfFile,
} from '@electron/features/djvu/public';
import { getDjvuPageCount } from '@electron/djvu/metadata';
import {
    assertNonEmptyPdfOutput,
    getPdfPageCount,
    QPDF_OUTPUT_SUCCESS_EXIT_CODES,
    QPDF_TIMEOUT_MS,
    runQpdfCommand,
} from '@electron/features/page-ops/publicNative';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import {
    isNativePdfImageCombineBitmapPath,
    tryWritePdfWithNativeImageCombiner,
} from '@electron/image/tryCreatePdfWithNativeImageCombiner';
import {
    abortErrorFromSignal,
    isAbortError,
} from '@electron/utils/abort';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';

interface INativePdfAssemblerProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

interface INativePdfAssemblerOptions {
    onProgress?: (progress: INativePdfAssemblerProgress) => void;
    signal?: AbortSignal;
}

interface IProgressState {
    processed: number;
    total: number;
    startedAt: number;
}

const log = createLogger('nativePdfAssembler');

interface INativePdfAssemblerResourceLimits {
    maxOutputBytes: number;
    maxPages: number;
}

const IN_MEMORY_NATIVE_ASSEMBLER_MAX_PAGES = 500;
const FILE_BACKED_NATIVE_ASSEMBLER_MAX_PAGES = 10_000;
const PDF_COMBINE_MAX_PAGES_LIMIT = 10_000;

function isNativePdfAssemblerDisabled() {
    return process.env.EVB_PDF_NATIVE_ASSEMBLER_DISABLE === '1'
        || (process.env.VITEST === 'true' && process.env.EVB_PDF_NATIVE_ASSEMBLER_ENABLE !== '1');
}

function isPdfPath(inputPath: string) {
    return extname(inputPath).toLowerCase() === '.pdf';
}

function isDjvuPath(inputPath: string) {
    const extension = extname(inputPath).toLowerCase();
    return extension === '.djvu' || extension === '.djv';
}

function canUseNativePdfAssembler(inputPaths: string[]) {
    return !isNativePdfAssemblerDisabled()
        && inputPaths.length > 0
        // qpdf page assembly does not merge source catalogs. PDF and DjVu
        // inputs must use the shared metadata planner; this fast path is
        // intentionally image-only.
        && inputPaths.every(isNativePdfImageCombineBitmapPath);
}

function estimateRemainingMs(elapsedMs: number, processed: number, total: number) {
    if (processed <= 0 || processed >= total) {
        return 0;
    }

    return Math.max(0, Math.round((elapsedMs / processed) * (total - processed)));
}

function emitProgress(
    state: IProgressState,
    options: INativePdfAssemblerOptions | undefined,
    processed: number,
) {
    if (!options?.onProgress) {
        return;
    }

    const clampedProcessed = Math.max(0, Math.min(state.total, processed));
    const elapsedMs = Math.max(0, Date.now() - state.startedAt);
    options.onProgress({
        processed: clampedProcessed,
        total: state.total,
        percent: Math.round((clampedProcessed / state.total) * 100),
        elapsedMs,
        estimatedRemainingMs: estimateRemainingMs(elapsedMs, clampedProcessed, state.total),
    });
}

function throwIfAborted(signal: AbortSignal | undefined) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

function getResourceLimits(defaultMaxPages = IN_MEMORY_NATIVE_ASSEMBLER_MAX_PAGES): INativePdfAssemblerResourceLimits {
    return {
        maxOutputBytes: parseIntegerEnv('EVB_PDF_COMBINE_MAX_OUTPUT_MB', 512, 1, 4096) * 1024 * 1024,
        maxPages: parseIntegerEnv('EVB_PDF_COMBINE_MAX_PAGES', defaultMaxPages, 1, PDF_COMBINE_MAX_PAGES_LIMIT),
    };
}

function assertPageLimit(nextPageCount: number, limits: INativePdfAssemblerResourceLimits) {
    if (nextPageCount > limits.maxPages) {
        throw new Error(`Combined PDF is capped at ${limits.maxPages} pages`);
    }
}

function assertOutputLimit(byteLength: number, limits: INativePdfAssemblerResourceLimits) {
    if (byteLength > limits.maxOutputBytes) {
        throw new Error('Combined PDF output is too large to return safely');
    }
}

async function readLimitedPdfOutput(outputPath: string, limits: INativePdfAssemblerResourceLimits) {
    const outputStat = await stat(outputPath);
    assertOutputLimit(outputStat.size, limits);
    const outputBytes = new Uint8Array(await readFile(outputPath));
    assertOutputLimit(outputBytes.byteLength, limits);
    return outputBytes;
}

async function flushImageChunk(
    imagePaths: string[],
    tempDir: string,
    chunkPaths: string[],
    progress: IProgressState,
    currentPageCount: number,
    limits: INativePdfAssemblerResourceLimits,
    countGeneratedPages: boolean,
    options?: INativePdfAssemblerOptions,
) {
    if (imagePaths.length === 0) {
        return 0;
    }

    throwIfAborted(options?.signal);
    const chunkInputPaths = [...imagePaths];
    const chunkPath = join(tempDir, `image-chunk-${chunkPaths.length + 1}-${randomUUID()}.pdf`);
    const onProgress = (chunkProgress: INativePdfAssemblerProgress) => emitProgress(
        progress,
        options,
        progress.processed + chunkProgress.processed,
    );
    const ok = await tryWritePdfWithNativeImageCombiner(chunkInputPaths, chunkPath, {
        maxPages: limits.maxPages,
        onProgress,
        ...(options?.signal ? { signal: options.signal } : {}),
    });
    throwIfAborted(options?.signal);
    if (!ok) {
        return null;
    }

    await assertNonEmptyPdfOutput(chunkPath, 'Combining image pages');
    const chunkPageCount = countGeneratedPages
        ? await getPdfPageCount(chunkPath, options?.signal ? { signal: options.signal } : {})
        : 0;
    if (countGeneratedPages) {
        assertPageLimit(currentPageCount + chunkPageCount, limits);
    }
    progress.processed += chunkInputPaths.length;
    emitProgress(progress, options, progress.processed);
    chunkPaths.push(chunkPath);
    imagePaths.length = 0;
    return chunkPageCount;
}

async function convertDjvuChunk(
    inputPath: string,
    tempDir: string,
    options?: INativePdfAssemblerOptions,
) {
    throwIfAborted(options?.signal);
    const outputPath = join(tempDir, `djvu-chunk-${randomUUID()}.pdf`);
    const jobId = `pdf-native-assembler-djvu-${randomUUID()}`;
    const abortHandler = options?.signal
        ? () => {
            void cancelConversion(jobId);
        }
        : null;
    if (options?.signal && abortHandler) {
        options.signal.addEventListener('abort', abortHandler, { once: true });
    }
    try {
        const pageCount = await getOptionalDjvuPageCount(inputPath, options?.signal);
        throwIfAborted(options?.signal);
        const result = await convertDjvuToPdfFile(
            inputPath,
            outputPath,
            jobId,
            {
                subsample: 1,
                ...(pageCount > 0 ? { pageCount } : {}),
                ...(options?.signal ? { signal: options.signal } : {}),
            },
        );
        throwIfAborted(options?.signal);
        if (!result.success) {
            throw new Error(result.error ?? `Failed to convert DjVu file: ${inputPath}`);
        }
    } finally {
        if (options?.signal && abortHandler) {
            options.signal.removeEventListener('abort', abortHandler);
        }
    }

    await assertNonEmptyPdfOutput(outputPath, 'Converting DjVu input');
    return outputPath;
}

async function getOptionalDjvuPageCount(inputPath: string, signal?: AbortSignal) {
    try {
        return await getDjvuPageCount(inputPath, signal ? { signal } : {});
    } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
            throw error;
        }
        log.debug(`Failed to read DjVu page count before native assemble conversion: ${getErrorMessage(error)}`);
        return 0;
    }
}

async function mergePdfChunks(chunkPaths: string[], outputPath: string, signal?: AbortSignal) {
    await runQpdfCommand([
        '--empty',
        '--pages',
        ...chunkPaths,
        '--',
        outputPath,
    ], {
        timeoutMs: QPDF_TIMEOUT_MS,
        allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
        commandLabel: 'qpdf(native-pdf-assembler)',
        ...(signal ? { signal } : {}),
    });
    await assertNonEmptyPdfOutput(outputPath, 'Assembling PDF inputs');
}

async function writePdfFromInputPathsNativeWithTempDir(
    inputPaths: string[],
    outputPath: string,
    tempDir: string,
    limits: INativePdfAssemblerResourceLimits,
    options?: INativePdfAssemblerOptions,
): Promise<number | null> {
    try {
        throwIfAborted(options?.signal);
        const progress: IProgressState = {
            processed: 0,
            total: inputPaths.length,
            startedAt: Date.now(),
        };
        assertPageLimit(inputPaths.length, limits);
        const chunkPaths: string[] = [];
        const imageChunkPaths: string[] = [];
        let pageCount = 0;

        for (const inputPath of inputPaths) {
            throwIfAborted(options?.signal);
            if (isNativePdfImageCombineBitmapPath(inputPath)) {
                imageChunkPaths.push(inputPath);
                continue;
            }

            const addedImagePages = await flushImageChunk(
                imageChunkPaths,
                tempDir,
                chunkPaths,
                progress,
                pageCount,
                limits,
                true,
                options,
            );
            if (addedImagePages === null) {
                return null;
            }
            pageCount += addedImagePages;

            if (isPdfPath(inputPath)) {
                const sourcePageCount = await getPdfPageCount(inputPath, options?.signal ? { signal: options.signal } : {});
                assertPageLimit(pageCount + sourcePageCount, limits);
                chunkPaths.push(inputPath);
                pageCount += sourcePageCount;
            } else if (isDjvuPath(inputPath)) {
                const convertedPath = await convertDjvuChunk(inputPath, tempDir, options);
                const sourcePageCount = await getPdfPageCount(convertedPath, options?.signal ? { signal: options.signal } : {});
                assertPageLimit(pageCount + sourcePageCount, limits);
                chunkPaths.push(convertedPath);
                pageCount += sourcePageCount;
            } else {
                return null;
            }

            progress.processed += 1;
            emitProgress(progress, options, progress.processed);
        }

        throwIfAborted(options?.signal);
        const addedImagePages = await flushImageChunk(
            imageChunkPaths,
            tempDir,
            chunkPaths,
            progress,
            pageCount,
            limits,
            true,
            options,
        );
        if (addedImagePages === null) {
            return null;
        }
        pageCount += addedImagePages;

        if (chunkPaths.length === 0) {
            return null;
        }

        if (chunkPaths.length === 1) {
            await copyFile(chunkPaths[0]!, outputPath);
            await assertNonEmptyPdfOutput(outputPath, 'Assembling PDF inputs');
            throwIfAborted(options?.signal);
            emitProgress(progress, options, progress.total);
            return pageCount;
        }

        await mergePdfChunks(chunkPaths, outputPath, options?.signal);
        throwIfAborted(options?.signal);
        emitProgress(progress, options, progress.total);
        return pageCount;
    } catch (error) {
        if (options?.signal?.aborted || isAbortError(error)) {
            throw error;
        }
        log.warn(`Native PDF assembler failed, falling back to JS combine: ${getErrorMessage(error)}`);
        return null;
    }
}

async function assertNativeCombineDiskSpace(inputPaths: string[], outputPath: string, limits: INativePdfAssemblerResourceLimits) {
    if (typeof statfs !== 'function') {
        return;
    }
    const inputStats = await Promise.all(inputPaths.map(path => stat(path)));
    const estimatedOutputBytes = Math.min(
        limits.maxOutputBytes,
        Math.max(16 * 1024 * 1024, inputStats.reduce((total, entry) => total + entry.size, 0) * 2),
    );
    const filesystem = await statfs(dirname(outputPath));
    const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    const requiredBytes = estimatedOutputBytes * 2;
    if (!Number.isFinite(availableBytes) || availableBytes < requiredBytes) {
        throw new Error(`Insufficient disk space for PDF combine (requires ${requiredBytes} bytes)`);
    }
}

export async function tryWritePdfFromInputPathsNative(
    inputPaths: string[],
    outputPath: string,
    options?: INativePdfAssemblerOptions,
): Promise<boolean> {
    if (!canUseNativePdfAssembler(inputPaths)) {
        return false;
    }

    const normalizedOutputPath = typeof outputPath === 'string' ? outputPath : '';
    if (!normalizedOutputPath) {
        return false;
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'pdf-native-assembler-'));
    const stagedOutputPath = makeSiblingTempPath(normalizedOutputPath);
    const limits = getResourceLimits(FILE_BACKED_NATIVE_ASSEMBLER_MAX_PAGES);

    try {
        await assertNativeCombineDiskSpace(inputPaths, normalizedOutputPath, limits);
        const expectedPageCount = await writePdfFromInputPathsNativeWithTempDir(
            inputPaths,
            stagedOutputPath,
            tempDir,
            limits,
            options,
        );
        if (expectedPageCount === null) {
            return false;
        }

        const outputStat = await stat(stagedOutputPath);
        assertOutputLimit(outputStat.size, limits);
        const outputPageCount = await getPdfPageCount(
            stagedOutputPath,
            options?.signal ? {signal: options.signal} : {},
        );
        if (outputPageCount !== expectedPageCount || outputPageCount < 1) {
            throw new Error(`Combined PDF page-count postcondition failed: expected ${expectedPageCount}, got ${outputPageCount}`);
        }

        await atomicReplace(stagedOutputPath, normalizedOutputPath);
        return true;
    } finally {
        await rm(stagedOutputPath, { force: true }).catch(() => undefined);
        await rm(tempDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
    }
}

export async function tryCreatePdfFromInputPathsNative(
    inputPaths: string[],
    options?: INativePdfAssemblerOptions,
): Promise<Uint8Array | null> {
    if (!canUseNativePdfAssembler(inputPaths)) {
        return null;
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'pdf-native-assembler-'));
    const outputPath = join(tempDir, `${randomUUID()}.pdf`);
    const limits = getResourceLimits();

    try {
        const expectedPageCount = await writePdfFromInputPathsNativeWithTempDir(
            inputPaths,
            outputPath,
            tempDir,
            limits,
            options,
        );
        if (expectedPageCount === null) {
            return null;
        }
        const outputPageCount = await getPdfPageCount(outputPath, options?.signal ? {signal: options.signal} : {});
        if (outputPageCount !== expectedPageCount || outputPageCount < 1) {
            throw new Error(`Combined PDF page-count postcondition failed: expected ${expectedPageCount}, got ${outputPageCount}`);
        }
        return await readLimitedPdfOutput(outputPath, limits);
    } catch (error) {
        if (options?.signal?.aborted || isAbortError(error)) {
            throw error;
        }
        log.warn(`Native PDF assembler failed, falling back to JS combine: ${getErrorMessage(error)}`);
        return null;
    } finally {
        await rm(tempDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
    }
}
