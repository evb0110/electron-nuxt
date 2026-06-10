import {
    mkdtemp,
    readFile,
    rm,
    stat,
} from 'fs/promises';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import {
    extname,
    join,
} from 'path';
import { convertDjvuToPdfFile } from '@electron/features/djvu/public';
import {
    assertNonEmptyPdfOutput,
    getPdfPageCount,
    QPDF_OUTPUT_SUCCESS_EXIT_CODES,
    QPDF_TIMEOUT_MS,
    runQpdfCommand,
} from '@electron/features/page-ops/public';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import {
    isNativePdfImageCombineBitmapPath,
    tryWritePdfWithNativeImageCombiner,
} from '@electron/image/tryCreatePdfWithNativeImageCombiner';

interface INativePdfAssemblerProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

interface INativePdfAssemblerOptions {onProgress?: (progress: INativePdfAssemblerProgress) => void;}

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

function isNativeAssemblerSupportedPath(inputPath: string) {
    return isPdfPath(inputPath)
        || isDjvuPath(inputPath)
        || isNativePdfImageCombineBitmapPath(inputPath);
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

function getResourceLimits(): INativePdfAssemblerResourceLimits {
    return {
        maxOutputBytes: parseIntegerEnv('EVB_PDF_COMBINE_MAX_OUTPUT_MB', 512, 1, 4096) * 1024 * 1024,
        maxPages: parseIntegerEnv('EVB_PDF_COMBINE_MAX_PAGES', 500, 1, 10_000),
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

    const chunkInputPaths = [...imagePaths];
    const chunkPath = join(tempDir, `image-chunk-${chunkPaths.length + 1}-${randomUUID()}.pdf`);
    const onProgress = (chunkProgress: INativePdfAssemblerProgress) => emitProgress(
        progress,
        options,
        progress.processed + chunkProgress.processed,
    );
    const ok = await tryWritePdfWithNativeImageCombiner(chunkInputPaths, chunkPath, {onProgress});
    if (!ok) {
        return null;
    }

    await assertNonEmptyPdfOutput(chunkPath, 'Combining image pages');
    const chunkPageCount = countGeneratedPages
        ? await getPdfPageCount(chunkPath)
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
) {
    const outputPath = join(tempDir, `djvu-chunk-${randomUUID()}.pdf`);
    const result = await convertDjvuToPdfFile(
        inputPath,
        outputPath,
        `pdf-native-assembler-djvu-${randomUUID()}`,
        {subsample: 1},
    );
    if (!result.success) {
        throw new Error(result.error ?? `Failed to convert DjVu file: ${inputPath}`);
    }

    await assertNonEmptyPdfOutput(outputPath, 'Converting DjVu input');
    return outputPath;
}

async function mergePdfChunks(chunkPaths: string[], outputPath: string) {
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
    });
    await assertNonEmptyPdfOutput(outputPath, 'Assembling PDF inputs');
}

export async function tryCreatePdfFromInputPathsNative(
    inputPaths: string[],
    options?: INativePdfAssemblerOptions,
): Promise<Uint8Array | null> {
    if (
        isNativePdfAssemblerDisabled()
        || inputPaths.length === 0
        || !inputPaths.every(isNativeAssemblerSupportedPath)
    ) {
        return null;
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'pdf-native-assembler-'));
    const outputPath = join(tempDir, `${randomUUID()}.pdf`);

    try {
        const progress: IProgressState = {
            processed: 0,
            total: inputPaths.length,
            startedAt: Date.now(),
        };
        const limits = getResourceLimits();
        assertPageLimit(inputPaths.length, limits);
        const chunkPaths: string[] = [];
        const imageChunkPaths: string[] = [];
        let pageCount = 0;

        for (const inputPath of inputPaths) {
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
                const sourcePageCount = await getPdfPageCount(inputPath);
                assertPageLimit(pageCount + sourcePageCount, limits);
                chunkPaths.push(inputPath);
                pageCount += sourcePageCount;
            } else if (isDjvuPath(inputPath)) {
                const convertedPath = await convertDjvuChunk(inputPath, tempDir);
                const sourcePageCount = await getPdfPageCount(convertedPath);
                assertPageLimit(pageCount + sourcePageCount, limits);
                chunkPaths.push(convertedPath);
                pageCount += sourcePageCount;
            } else {
                return null;
            }

            progress.processed += 1;
            emitProgress(progress, options, progress.processed);
        }

        const addedImagePages = await flushImageChunk(
            imageChunkPaths,
            tempDir,
            chunkPaths,
            progress,
            pageCount,
            limits,
            chunkPaths.length > 0,
            options,
        );
        if (addedImagePages === null) {
            return null;
        }

        if (chunkPaths.length === 0) {
            return null;
        }

        if (chunkPaths.length === 1) {
            emitProgress(progress, options, progress.total);
            return await readLimitedPdfOutput(chunkPaths[0]!, limits);
        }

        await mergePdfChunks(chunkPaths, outputPath);
        emitProgress(progress, options, progress.total);
        return await readLimitedPdfOutput(outputPath, limits);
    } catch (error) {
        log.warn(`Native PDF assembler failed, falling back to JS combine: ${getErrorMessage(error)}`);
        return null;
    } finally {
        await rm(tempDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
    }
}
