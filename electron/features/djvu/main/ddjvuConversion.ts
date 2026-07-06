import { existsSync } from 'fs';
import {
    mkdtemp,
    readFile,
    rm,
    stat,
    unlink,
    writeFile,
} from 'fs/promises';
import {
    availableParallelism,
    cpus,
    tmpdir,
} from 'os';
import { join } from 'path';
import { PDFDocument } from 'pdf-lib';
import { limitAsync } from 'es-toolkit/array';
import { clamp } from 'es-toolkit/math';
import { buildDjvuRuntimeEnv } from '@electron/djvu/paths';
import { getDjvuNativeToolPaths } from '@electron/djvu/nativeToolPaths';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {
    cancelNativeCommandGroup,
    runNativeCommand,
} from '@electron/native-tools/runNativeCommand';
import type { IRunCommandOptions } from '@electron/native-tools/runNativeCommand';

interface IDjvuConversionOptions {
    subsample?: number;
    pages?: string;
    pageCount?: number;
    onProgress?: (percent: number) => void;
}

export interface IRegisteredDjvuProcessOptions {
    env?: NodeJS.ProcessEnv;
    onStderr?: (chunk: string) => void;
    onStdout?: (chunk: string) => void;
    timeoutMs?: number;
    maxStderrBytes?: number;
}

interface IDjvuConversionResult {
    success: boolean;
    outputPath: string;
    fileSize: number;
    error?: string;
}

const MAX_RANGE_WORKERS = 12;
const MIN_PAGES_FOR_RANGE_PARALLELISM = 24;
const PROGRESS_CAP = 90;
const DJVU_PROCESS_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_PROCESS_TIMEOUT_MS ?? `${4 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 5_000) {
        return 4 * 60 * 1000;
    }
    return parsed;
})();
const DJVU_IMAGE_PROCESS_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_IMAGE_PROCESS_TIMEOUT_MS ?? `${2 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 5_000) {
        return 2 * 60 * 1000;
    }
    return parsed;
})();
const DJVU_KILL_GRACE_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_KILL_GRACE_MS ?? '2000', 10);
    if (!Number.isFinite(parsed) || parsed < 250) {
        return 2_000;
    }
    return parsed;
})();
const DJVU_MAX_STDERR_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_MAX_STDERR_BYTES ?? '262144', 10);
    if (!Number.isFinite(parsed) || parsed < 1_024) {
        return 262_144;
    }
    return parsed;
})();
const DJVU_PDFLIB_FALLBACK_MAX_PAGES = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_PDFLIB_FALLBACK_MAX_PAGES ?? '256', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 256;
    }
    return Math.min(parsed, 2_000);
})();
const DJVU_PDFLIB_FALLBACK_MAX_TOTAL_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_PDFLIB_FALLBACK_MAX_TOTAL_MB ?? '256', 10);
    if (!Number.isFinite(parsed) || parsed < 16) {
        return 256 * 1024 * 1024;
    }
    return parsed * 1024 * 1024;
})();

const activeProcessIds = new Set<string>();
const canceledProcessIds = new Set<string>();
const logger = createLogger('djvu-convert');
const DJVU_CONVERSION_CANCELED_MESSAGE = 'DjVu conversion canceled';

interface IDjvuPageRangeChunk {
    index: number;
    startPage: number;
    endPage: number;
    outputPath: string;
}

async function cleanupPartialOutput(outputPath: string) {
    try {
        if (!existsSync(outputPath)) {
            return;
        }
        await unlink(outputPath);
    } catch {
        // Ignore cleanup failures for partial outputs.
    }
}

async function _convertDjvuToPdfWithRanges(
    inputPath: string,
    outputPath: string,
    jobId: string,
    options: IDjvuConversionOptions,
): Promise<IDjvuConversionResult> {
    const totalPages = options.pageCount ?? 0;
    const workerCount = getRangeWorkerCount(totalPages);
    if (workerCount < 2) {
        return {
            success: false,
            outputPath,
            fileSize: 0,
            error: 'Parallel conversion is not applicable',
        };
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'djvu-pages-'));
    const chunks = createPageRangeChunks(totalPages, workerCount, tempDir);
    const chunkPaths = chunks.map(chunk => chunk.outputPath);
    let completedPageCount = 0;
    let firstError: string | null = null;

    try {
        const convertChunkWithLimit = limitAsync(async (chunk: IDjvuPageRangeChunk) => {
            if (firstError) {
                return firstError;
            }

            const pageResult = await convertPageRangeToPdf(
                inputPath,
                chunk.outputPath,
                `${jobId}-range-${chunk.index + 1}-pages-${chunk.startPage}-${chunk.endPage}`,
                chunk.startPage,
                chunk.endPage,
                options.subsample,
            );

            if (!pageResult.success) {
                await cancelConversion(jobId);
                firstError = pageResult.error ?? `Failed to convert pages ${chunk.startPage}-${chunk.endPage}`;
                return firstError;
            }

            if (firstError) {
                return firstError;
            }

            completedPageCount += chunk.endPage - chunk.startPage + 1;
            if (options.onProgress) {
                const percent = Math.min(
                    PROGRESS_CAP,
                    Math.round((completedPageCount / totalPages) * PROGRESS_CAP),
                );
                options.onProgress(percent);
            }
            return null;
        }, workerCount);

        const conversionErrors = await Promise.all(chunks.map(convertChunkWithLimit));
        for (const conversionError of conversionErrors) {
            if (conversionError !== null) {
                firstError = firstError ?? conversionError;
                break;
            }
        }

        if (firstError) {
            await cleanupPartialOutput(outputPath);
            return {
                success: false,
                outputPath,
                fileSize: 0,
                error: firstError,
            };
        }

        const mergeResult = await mergePdfChunks(chunkPaths, outputPath, `${jobId}-merge`, totalPages);
        if (!mergeResult.success) {
            await cleanupPartialOutput(outputPath);
            return {
                success: false,
                outputPath,
                fileSize: 0,
                error: mergeResult.error ?? 'Failed to merge converted DjVu PDF chunks',
            };
        }

        try {
            const s = await stat(outputPath);
            if (options.onProgress) {
                options.onProgress(PROGRESS_CAP + 5);
            }
            return {
                success: true,
                outputPath,
                fileSize: s.size,
            };
        } catch (err) {
            return {
                success: false,
                outputPath,
                fileSize: 0,
                error: `Output file not found after parallel conversion: ${getErrorMessage(err)}`,
            };
        }
    } finally {
        await rm(tempDir, {
            recursive: true,
            force: true,
        }).catch(() => {});
    }
}

async function _convertDjvuToPdfSingleProcess(
    inputPath: string,
    outputPath: string,
    jobId: string,
    options: IDjvuConversionOptions,
    totalPages: number,
): Promise<IDjvuConversionResult> {
    const args = buildPdfArgs(inputPath, outputPath, options.subsample, options.pages);
    const pageProgressSeen = new Set<number>();
    const result = await runProcess(
        jobId,
        getDjvuNativeToolPaths().ddjvu,
        args,
        {
            env: buildDjvuRuntimeEnv(),
            onStderr: (chunk) => {
                if (!options.onProgress || totalPages <= 0) {
                    return;
                }
                const pageMatches = chunk.matchAll(/-------- page (\d+)/g);
                for (const match of pageMatches) {
                    const pageNum = parseInt(match[1] ?? '0', 10);
                    if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > totalPages) {
                        continue;
                    }
                    if (pageProgressSeen.has(pageNum)) {
                        continue;
                    }
                    pageProgressSeen.add(pageNum);
                    const percent = Math.min(
                        PROGRESS_CAP,
                        Math.round((pageProgressSeen.size / totalPages) * PROGRESS_CAP),
                    );
                    options.onProgress(percent);
                }
            },
        },
    );

    if (!result.success) {
        await cleanupPartialOutput(outputPath);
        return {
            success: false,
            outputPath,
            fileSize: 0,
            error: result.error,
        };
    }

    try {
        const s = await stat(outputPath);
        return {
            success: true,
            outputPath,
            fileSize: s.size,
        };
    } catch (err) {
        await cleanupPartialOutput(outputPath);
        return {
            success: false,
            outputPath,
            fileSize: 0,
            error: `Output file not found after conversion: ${getErrorMessage(err)}`,
        };
    }
}

export async function convertDjvuToPdfFile(
    inputPath: string,
    outputPath: string,
    jobId: string,
    options: IDjvuConversionOptions = {},
): Promise<IDjvuConversionResult> {
    const totalPages = options.pageCount ?? 0;
    if (_shouldUseParallelRangeConversion(options)) {
        const parallelResult = await _convertDjvuToPdfWithRanges(
            inputPath,
            outputPath,
            jobId,
            options,
        );
        if (parallelResult.success || shouldSkipSingleProcessFallback(parallelResult.error)) {
            return parallelResult;
        }

        logger.warn(
            `[${jobId}] Parallel DjVu range conversion failed, falling back to single process: ${parallelResult.error}`,
        );
        await cleanupPartialOutput(outputPath);
    }

    return _convertDjvuToPdfSingleProcess(
        inputPath,
        outputPath,
        jobId,
        options,
        totalPages,
    );
}

async function convertPageRangeToPdf(
    inputPath: string,
    outputPath: string,
    pageJobId: string,
    startPage: number,
    endPage: number,
    subsample: number | undefined,
) {
    const pages = startPage === endPage
        ? String(startPage)
        : `${startPage}-${endPage}`;
    const args = buildPdfArgs(
        inputPath,
        outputPath,
        subsample,
        pages,
    );
    const result = await runProcess(
        pageJobId,
        getDjvuNativeToolPaths().ddjvu,
        args,
        { env: buildDjvuRuntimeEnv() },
    );

    if (!result.success) {
        return {
            success: false,
            error: result.error ?? `Failed to convert pages ${pages}`,
        };
    }

    return { success: true };
}

async function mergePdfChunks(
    chunkPaths: string[],
    outputPath: string,
    mergeJobId: string,
    totalPages: number,
) {
    const { qpdf } = getPdfNativeToolPaths();
    const qpdfResult = await runProcess(
        mergeJobId,
        qpdf,
        [
            '--empty',
            '--pages',
            ...chunkPaths,
            '--',
            outputPath,
        ],
    );
    if (qpdfResult.success) {
        return { success: true };
    }

    if (isDjvuConversionCancellationError(qpdfResult.error)) {
        return qpdfResult;
    }

    const fallbackPageCount = totalPages > 0 ? totalPages : chunkPaths.length;
    if (fallbackPageCount > DJVU_PDFLIB_FALLBACK_MAX_PAGES) {
        return {
            success: false,
            error: `qpdf merge failed and fallback is disabled for large files (> ${DJVU_PDFLIB_FALLBACK_MAX_PAGES} pages)`,
        };
    }

    logger.warn(`[${mergeJobId}] qpdf merge failed, falling back to pdf-lib merge: ${qpdfResult.error}`);
    try {
        let totalChunkBytes = 0;
        for (const chunkPath of chunkPaths) {
            const chunkStat = await stat(chunkPath);
            totalChunkBytes += chunkStat.size;
            if (totalChunkBytes > DJVU_PDFLIB_FALLBACK_MAX_TOTAL_BYTES) {
                return {
                    success: false,
                    error: `qpdf merge failed and fallback exceeds size cap (${Math.floor(DJVU_PDFLIB_FALLBACK_MAX_TOTAL_BYTES / (1024 * 1024))}MB)`,
                };
            }
        }

        const mergedDoc = await PDFDocument.create();

        for (const chunkPath of chunkPaths) {
            const chunkData = await readFile(chunkPath);
            const chunkDoc = await PDFDocument.load(chunkData, { updateMetadata: false });
            const chunkIndices = chunkDoc.getPageIndices();
            if (chunkIndices.length === 0) {
                continue;
            }
            const pages = await mergedDoc.copyPages(chunkDoc, chunkIndices);
            for (const page of pages) {
                mergedDoc.addPage(page);
            }
        }

        await writeFile(outputPath, new Uint8Array(await mergedDoc.save()));
        return { success: true };
    } catch (error) {
        return {
            success: false,
            error: getErrorMessage(error),
        };
    }
}

function buildPdfArgs(
    inputPath: string,
    outputPath: string,
    subsample?: number,
    pages?: string,
) {
    const args = [
        '-format=pdf',
        '-verbose',
    ];

    if (subsample && subsample > 1) {
        args.push(`-subsample=${subsample}`);
    }

    if (pages) {
        args.push(`-page=${pages}`);
    }

    args.push(inputPath, outputPath);
    return args;
}

type TImageFormat = 'pbm' | 'pgm' | 'ppm';
type TDjvuRenderMode = 'background' | 'black' | 'foreground' | 'mask';

export async function convertDjvuPageToImage(
    inputPath: string,
    outputPath: string,
    pageNum: number,
    jobId: string,
    options: {
        subsample?: number;
        format?: TImageFormat;
        targetHeightPx?: number;
        targetWidthPx?: number;
    } = {},
): Promise<IDjvuConversionResult> {
    return renderDjvuPageToImage(inputPath, outputPath, pageNum, jobId, options);
}

export async function renderDjvuPageToImage(
    inputPath: string,
    outputPath: string,
    pageNum: number,
    jobId: string,
    options: {
        subsample?: number;
        format?: TImageFormat;
        mode?: TDjvuRenderMode;
        targetHeightPx?: number;
        targetWidthPx?: number;
    } = {},
): Promise<IDjvuConversionResult> {
    const { ddjvu } = getDjvuNativeToolPaths();
    const format = options.format ?? 'ppm';

    const args = [
        `-format=${format}`,
        `-page=${pageNum}`,
    ];

    if (options.mode) {
        args.push(`-mode=${options.mode}`);
    }

    if (options.targetWidthPx && options.targetHeightPx) {
        args.push(`-size=${options.targetWidthPx}x${options.targetHeightPx}`);
    } else if (options.subsample && options.subsample > 1) {
        args.push(`-subsample=${options.subsample}`);
    }

    args.push(inputPath, outputPath);

    const result = await runProcess(jobId, ddjvu, args, {
        env: buildDjvuRuntimeEnv(),
        timeoutMs: DJVU_IMAGE_PROCESS_TIMEOUT_MS,
    });
    if (!result.success) {
        return {
            success: false,
            outputPath,
            fileSize: 0,
            error: result.error,
        };
    }

    try {
        const s = await stat(outputPath);
        return {
            success: true,
            outputPath,
            fileSize: s.size,
        };
    } catch (err) {
        return {
            success: false,
            outputPath,
            fileSize: 0,
            error: `Output file not found: ${getErrorMessage(err)}`,
        };
    }
}

export async function runRegisteredDjvuProcess(
    processId: string,
    command: string,
    args: string[],
    options: IRegisteredDjvuProcessOptions = {},
) {
    return runProcess(processId, command, args, options);
}

export async function cancelConversion(jobId: string) {
    let canceled = false;

    if (activeProcessIds.has(jobId)) {
        canceledProcessIds.add(jobId);
        cancelNativeCommandGroup(jobId);
        canceled = true;
    }

    for (const id of activeProcessIds) {
        if (id.startsWith(`${jobId}-`)) {
            canceledProcessIds.add(id);
            cancelNativeCommandGroup(id);
            canceled = true;
        }
    }

    await Promise.resolve();
    return canceled;
}

interface IRunProcessOptions {
    env?: NodeJS.ProcessEnv;
    onStderr?: (chunk: string) => void;
    onStdout?: (chunk: string) => void;
    timeoutMs?: number;
    maxStderrBytes?: number;
}

async function runProcess(
    processId: string,
    command: string,
    args: string[],
    options: IRunProcessOptions = {},
): Promise<{ success: true } | {
    success: false;
    error: string 
}> {
    activeProcessIds.add(processId);
    try {
        const commandOptions: IRunCommandOptions = {
            cancelGroup: processId,
            commandLabel: command,
            maxStderrBytes: options.maxStderrBytes ?? DJVU_MAX_STDERR_BYTES,
            terminationGraceMs: DJVU_KILL_GRACE_MS,
            timeoutMs: options.timeoutMs ?? DJVU_PROCESS_TIMEOUT_MS,
        };
        if (options.env !== undefined) {
            commandOptions.env = options.env;
        }
        if (options.onStderr !== undefined) {
            commandOptions.onStderr = options.onStderr;
        }
        if (options.onStdout !== undefined) {
            commandOptions.onStdout = options.onStdout;
        }
        await runNativeCommand(command, args, commandOptions);
        return { success: true };
    } catch (error) {
        if (canceledProcessIds.has(processId)) {
            return {
                success: false,
                error: DJVU_CONVERSION_CANCELED_MESSAGE,
            };
        }
        return {
            success: false,
            error: getErrorMessage(error),
        };
    } finally {
        activeProcessIds.delete(processId);
        canceledProcessIds.delete(processId);
    }
}

function shouldSkipSingleProcessFallback(error: string | undefined) {
    if (!error) {
        return false;
    }
    return isDjvuConversionCancellationError(error) || error.includes('timed out after');
}

function isDjvuConversionCancellationError(error: string | undefined) {
    return error?.includes(DJVU_CONVERSION_CANCELED_MESSAGE) ?? false;
}

function _shouldUseParallelRangeConversion(options: IDjvuConversionOptions) {
    const totalPages = options.pageCount ?? 0;
    if (options.pages) {
        return false;
    }
    if (totalPages < MIN_PAGES_FOR_RANGE_PARALLELISM) {
        return false;
    }
    return getRangeWorkerCount(totalPages) > 1;
}

function createPageRangeChunks(
    totalPages: number,
    workerCount: number,
    tempDir: string,
) {
    const chunkCount = Math.min(totalPages, workerCount);
    const baseChunkSize = Math.floor(totalPages / chunkCount);
    const remainder = totalPages % chunkCount;
    const chunks: IDjvuPageRangeChunk[] = [];
    let startPage = 1;

    for (let index = 0; index < chunkCount; index += 1) {
        const pageCount = baseChunkSize + (index < remainder ? 1 : 0);
        const endPage = startPage + pageCount - 1;
        chunks.push({
            index,
            startPage,
            endPage,
            outputPath: join(tempDir, `pages-${startPage}-${endPage}.pdf`),
        });
        startPage = endPage + 1;
    }

    return chunks;
}

function getLogicalCpuCount() {
    if (typeof availableParallelism === 'function') {
        return availableParallelism();
    }
    return cpus().length;
}

function getRangeWorkerCount(pageCount: number) {
    const cpuBound = Math.max(1, getLogicalCpuCount() - 1);
    const desired = clamp(cpuBound, 2, MAX_RANGE_WORKERS);
    return Math.min(pageCount, desired);
}
