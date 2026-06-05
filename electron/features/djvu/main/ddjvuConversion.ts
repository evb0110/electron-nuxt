import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
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
import {
    clamp,
    range,
} from 'es-toolkit/math';
import {
    buildDjvuRuntimeEnv,
    getDjvuToolPaths,
} from '@electron/djvu/paths';
import { getNativeToolPaths } from '@electron/native-tools/paths';
import { createLogger } from '@electron/utils/logger';
import { describeProcessExitCode } from '@electron/utils/processExit';
import { getErrorMessage } from '@electron/utils/error';
import {
    createDetachedChildProcessSpawnOptions,
    terminateDetachedChildProcess,
} from '@electron/utils/nativeChildProcess';

interface IDjvuConvertOptions {
    subsample?: number;
    pages?: string;
    pageCount?: number;
    onProgress?: (percent: number) => void;
}

interface IDjvuConvertResult {
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

const activeProcesses = new Map<string, ChildProcess>();
const logger = createLogger('djvu-convert');

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
    options: IDjvuConvertOptions,
): Promise<IDjvuConvertResult> {
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
    const pageNumbers = range(1, totalPages + 1);
    const chunkPaths = pageNumbers.map(pageNumber => join(tempDir, `page-${pageNumber}.pdf`));
    let completedPageCount = 0;
    let firstError: string | null = null;

    try {
        const convertPageWithLimit = limitAsync(async (pageNum: number, index: number) => {
            if (firstError) {
                return firstError;
            }

            const pageOutputPath = chunkPaths[pageNum - 1]!;
            const pageResult = await convertPageToPdf(
                inputPath,
                pageOutputPath,
                `${jobId}-range-${index + 1}-page-${pageNum}`,
                pageNum,
                options.subsample,
            );

            if (!pageResult.success) {
                await cancelConversion(jobId);
                firstError = pageResult.error ?? `Failed to convert page ${pageNum}`;
                return firstError;
            }

            if (firstError) {
                return firstError;
            }

            completedPageCount += 1;
            if (options.onProgress) {
                const percent = Math.min(
                    PROGRESS_CAP,
                    Math.round((completedPageCount / totalPages) * PROGRESS_CAP),
                );
                options.onProgress(percent);
            }
            return null;
        }, workerCount);

        const conversionErrors = await Promise.all(pageNumbers.map(convertPageWithLimit));
        firstError = firstError ?? conversionErrors.find((error): error is string => error !== null) ?? null;

        if (firstError) {
            await cleanupPartialOutput(outputPath);
            return {
                success: false,
                outputPath,
                fileSize: 0,
                error: firstError,
            };
        }

        const mergeResult = await mergePdfChunks(chunkPaths, outputPath, `${jobId}-merge`);
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
    options: IDjvuConvertOptions,
    totalPages: number,
): Promise<IDjvuConvertResult> {
    const args = buildPdfArgs(inputPath, outputPath, options.subsample, options.pages);
    const pageProgressSeen = new Set<number>();
    const result = await runProcess(
        jobId,
        getDjvuToolPaths().ddjvu,
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
    options: IDjvuConvertOptions = {},
): Promise<IDjvuConvertResult> {
    const totalPages = options.pageCount ?? 0;
    return _convertDjvuToPdfSingleProcess(
        inputPath,
        outputPath,
        jobId,
        options,
        totalPages,
    );
}

async function convertPageToPdf(
    inputPath: string,
    outputPath: string,
    pageJobId: string,
    page: number,
    subsample: number | undefined,
) {
    const args = buildPdfArgs(
        inputPath,
        outputPath,
        subsample,
        String(page),
    );
    const result = await runProcess(
        pageJobId,
        getDjvuToolPaths().ddjvu,
        args,
        { env: buildDjvuRuntimeEnv() },
    );

    if (!result.success) {
        return {
            success: false,
            error: result.error ?? `Failed to convert page ${page}`,
        };
    }

    return { success: true };
}

async function mergePdfChunks(
    chunkPaths: string[],
    outputPath: string,
    mergeJobId: string,
) {
    const { qpdf } = getNativeToolPaths();
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

    logger.warn(`[${mergeJobId}] qpdf merge failed, falling back to pdf-lib merge: ${qpdfResult.error}`);
    if (chunkPaths.length > DJVU_PDFLIB_FALLBACK_MAX_PAGES) {
        return {
            success: false,
            error: `qpdf merge failed and fallback is disabled for large files (> ${DJVU_PDFLIB_FALLBACK_MAX_PAGES} pages)`,
        };
    }

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

type TImageFormat = 'pgm' | 'ppm';

export async function convertDjvuPageToImage(
    inputPath: string,
    outputPath: string,
    pageNum: number,
    jobId: string,
    options: {
        subsample?: number;
        format?: TImageFormat 
    } = {},
): Promise<IDjvuConvertResult> {
    const { ddjvu } = getDjvuToolPaths();
    const format = options.format ?? 'ppm';

    const args = [
        `-format=${format}`,
        `-page=${pageNum}`,
    ];

    if (options.subsample && options.subsample > 1) {
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

export async function cancelConversion(jobId: string) {
    let canceled = false;
    const terminations: Array<Promise<void>> = [];

    // Cancel the exact job ID
    const proc = activeProcesses.get(jobId);
    if (proc) {
        terminations.push(killProcess(proc));
        activeProcesses.delete(jobId);
        canceled = true;
    }

    // Cancel any child workers belonging to this job (range-N, pgm-N)
    for (const [
        id,
        childProc,
    ] of activeProcesses) {
        if (id.startsWith(`${jobId}-`)) {
            terminations.push(killProcess(childProc));
            activeProcesses.delete(id);
            canceled = true;
        }
    }

    await Promise.all(terminations);
    return canceled;
}

async function killProcess(proc: ChildProcess) {
    await terminateDetachedChildProcess(proc, DJVU_KILL_GRACE_MS);
}

interface IRunProcessOptions {
    env?: NodeJS.ProcessEnv;
    onStderr?: (chunk: string) => void;
    timeoutMs?: number;
    maxStderrBytes?: number;
}

function appendWithCap(current: string, chunk: Buffer, maxBytes: number) {
    if (maxBytes <= 0) {
        return {
            value: '',
            truncated: true,
        };
    }

    const nextValue = current + chunk.toString();
    if (Buffer.byteLength(nextValue, 'utf8') <= maxBytes) {
        return {
            value: nextValue,
            truncated: false,
        };
    }

    const keepBytes = Math.max(1, Math.floor(maxBytes * 0.9));
    let tail = nextValue;
    while (Buffer.byteLength(tail, 'utf8') > keepBytes && tail.length > 1) {
        tail = tail.slice(Math.floor(tail.length * 0.1));
    }

    return {
        value: tail,
        truncated: true,
    };
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
    return new Promise((resolve) => {
        const timeoutMs = options.timeoutMs ?? DJVU_PROCESS_TIMEOUT_MS;
        const maxStderrBytes = options.maxStderrBytes ?? DJVU_MAX_STDERR_BYTES;
        let proc: ChildProcess;
        try {
            proc = spawn(command, args, createDetachedChildProcessSpawnOptions({
                shell: false,
                stdio: [
                    'ignore',
                    'pipe',
                    'pipe',
                ],
                ...(options.env ? { env: options.env } : {}),
            }));
        } catch (error) {
            resolve({
                success: false,
                error: getErrorMessage(error),
            });
            return;
        }

        activeProcesses.set(processId, proc);
        let stderr = '';
        let stderrTruncated = false;
        let settled = false;
        let timeoutHandle: NodeJS.Timeout | null = null;
        let timedOut = false;
        let forceFinalizeHandle: NodeJS.Timeout | null = null;

        const finalize = (result: { success: true } | {
            success: false;
            error: string;
        }) => {
            if (settled) {
                return;
            }
            settled = true;
            activeProcesses.delete(processId);
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            if (forceFinalizeHandle) {
                clearTimeout(forceFinalizeHandle);
                forceFinalizeHandle = null;
            }
            resolve(result);
        };

        proc.stdout?.on('data', () => {
            // Drain stdout to avoid child process back-pressure stalls.
        });

        proc.stderr?.on('data', (data: Buffer) => {
            const chunk = data.toString();
            const appended = appendWithCap(stderr, data, maxStderrBytes);
            stderr = appended.value;
            stderrTruncated = stderrTruncated || appended.truncated;
            options.onStderr?.(chunk);
        });

        if (timeoutMs > 0) {
            timeoutHandle = setTimeout(() => {
                timedOut = true;
                const pid = proc.pid;
                if (typeof pid === 'number' && Number.isFinite(pid) && pid > 0) {
                    void terminateDetachedChildProcess(proc, DJVU_KILL_GRACE_MS).finally(() => {
                        finalize({
                            success: false,
                            error: `${command} timed out after ${timeoutMs}ms`,
                        });
                    });
                } else {
                    try {
                        proc.kill('SIGTERM');
                    } catch {
                        // Process may already be gone.
                    }
                }
                // Guarantee settlement even if the child never emits 'close'/'error'
                // after forced termination.
                forceFinalizeHandle = setTimeout(() => {
                    finalize({
                        success: false,
                        error: `${command} timed out after ${timeoutMs}ms`,
                    });
                }, DJVU_KILL_GRACE_MS + 1_000);
                forceFinalizeHandle.unref?.();
            }, timeoutMs);
            timeoutHandle.unref?.();
        }

        proc.on('error', (err) => {
            finalize({
                success: false,
                error: err.message,
            });
        });

        proc.on('close', (code) => {
            const exitCode = typeof code === 'number' ? code : -1;
            if (timedOut) {
                finalize({
                    success: false,
                    error: `${command} timed out after ${timeoutMs}ms`,
                });
                return;
            }
            if (exitCode !== 0) {
                const stderrSummary = stderrTruncated
                    ? `[stderr truncated to ${maxStderrBytes} bytes]\n${stderr}`
                    : stderr;
                finalize({
                    success: false,
                    error: `${command} exited with code ${describeProcessExitCode(exitCode)}: ${stderrSummary}`,
                });
                return;
            }
            finalize({ success: true });
        });
    });
}

function _shouldUseParallelRangeConversion(options: IDjvuConvertOptions) {
    const totalPages = options.pageCount ?? 0;
    if (options.pages) {
        return false;
    }
    if (totalPages < MIN_PAGES_FOR_RANGE_PARALLELISM) {
        return false;
    }
    return getRangeWorkerCount(totalPages) > 1;
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
