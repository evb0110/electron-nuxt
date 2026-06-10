import {
    mkdtemp,
    readFile,
    rm,
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
    QPDF_OUTPUT_SUCCESS_EXIT_CODES,
    QPDF_TIMEOUT_MS,
    runQpdfCommand,
} from '@electron/features/page-ops/public';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
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

async function flushImageChunk(
    imagePaths: string[],
    tempDir: string,
    chunkPaths: string[],
    progress: IProgressState,
    options?: INativePdfAssemblerOptions,
) {
    if (imagePaths.length === 0) {
        return true;
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
        return false;
    }

    await assertNonEmptyPdfOutput(chunkPath, 'Combining image pages');
    progress.processed += chunkInputPaths.length;
    emitProgress(progress, options, progress.processed);
    chunkPaths.push(chunkPath);
    imagePaths.length = 0;
    return true;
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
        const chunkPaths: string[] = [];
        const imageChunkPaths: string[] = [];

        for (const inputPath of inputPaths) {
            if (isNativePdfImageCombineBitmapPath(inputPath)) {
                imageChunkPaths.push(inputPath);
                continue;
            }

            if (!await flushImageChunk(imageChunkPaths, tempDir, chunkPaths, progress, options)) {
                return null;
            }

            if (isPdfPath(inputPath)) {
                chunkPaths.push(inputPath);
            } else if (isDjvuPath(inputPath)) {
                chunkPaths.push(await convertDjvuChunk(inputPath, tempDir));
            } else {
                return null;
            }

            progress.processed += 1;
            emitProgress(progress, options, progress.processed);
        }

        if (!await flushImageChunk(imageChunkPaths, tempDir, chunkPaths, progress, options)) {
            return null;
        }

        if (chunkPaths.length === 0) {
            return null;
        }

        if (chunkPaths.length === 1) {
            emitProgress(progress, options, progress.total);
            return new Uint8Array(await readFile(chunkPaths[0]!));
        }

        await mergePdfChunks(chunkPaths, outputPath);
        emitProgress(progress, options, progress.total);
        return new Uint8Array(await readFile(outputPath));
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
