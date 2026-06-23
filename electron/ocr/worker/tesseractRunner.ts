import { spawn } from 'child_process';
import {
    open,
    readFile,
    stat,
    unlink,
} from 'fs/promises';
import type { IOcrWord } from '@contracts/shared';
import type { IOcrSearchablePdfOptions } from '@contracts/electronApiOcr';
import { isGreekOcrLanguage } from '@contracts/ocrLanguages';
import type { IOcrFileResult } from '@electron/ocr/worker/types';
import { resolveTesseractLanguageConfig } from '@electron/ocr/resolveTesseractLanguageConfig';
import { getErrorMessage } from '@electron/utils/error';
import { appendTextChunkWithByteCap } from '@electron/native-tools/appendTextChunkWithByteCap';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import { buildTesseractEnv } from '@electron/ocr/buildTesseractEnv';
import { createTesseractFinalize } from '@electron/ocr/createTesseractFinalize';
import {
    createDetachedChildProcessSpawnOptions,
    terminateDetachedChildProcess,
} from '@electron/utils/nativeChildProcess';

const PNG_SIGNATURE = Buffer.from([
    0x89,
    0x50,
    0x4E,
    0x47,
    0x0D,
    0x0A,
    0x1A,
    0x0A,
]);

const FILE_BASED_OCR_TIMEOUT_MS = parseIntegerEnv('EVB_OCR_FILE_BASED_TIMEOUT_MS', 3 * 60 * 1000, 10_000);
const FILE_BASED_OCR_KILL_GRACE_MS = parseIntegerEnv('EVB_OCR_FILE_BASED_KILL_GRACE_MS', 2_000, 250);
const FILE_BASED_OCR_MAX_STDERR_BYTES = parseIntegerEnv('EVB_OCR_FILE_BASED_MAX_STDERR_BYTES', 262_144, 1_024);

function shouldPreserveDictionaries(options: IOcrSearchablePdfOptions | undefined) {
    return options?.qualityProfile === 'accurate';
}

export function shouldNormalizeGreekMicroSign(languages: readonly string[]) {
    return languages.some(isGreekOcrLanguage);
}

function buildTesseractProfileArgs(options: IOcrSearchablePdfOptions | undefined) {
    const args: string[] = [];
    if (typeof options?.pageSegmentationMode === 'number') {
        args.push('--psm', String(options.pageSegmentationMode));
    }
    if (options?.qualityProfile === 'poor-scan') {
        args.push('-c', 'thresholding_method=2');
    }
    return args;
}

function getPngDimensions(imageBuffer: Buffer): {
    width: number;
    height: number;
} | null {
    if (imageBuffer.length < 24) {
        return null;
    }
    if (!imageBuffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return null;
    }
    const width = imageBuffer.readUInt32BE(16);
    const height = imageBuffer.readUInt32BE(20);
    if (width <= 0 || height <= 0) {
        return null;
    }
    return {
        width,
        height,
    };
}

export async function getPngDimensionsFromFile(imagePath: string) {
    const file = await open(imagePath, 'r');
    try {
        const header = Buffer.alloc(24);
        const { bytesRead } = await file.read(header, 0, header.length, 0);
        if (bytesRead < header.length) {
            return null;
        }
        return getPngDimensions(header);
    } finally {
        await file.close();
    }
}

async function safeUnlink(path: string) {
    try {
        await unlink(path);
    } catch {
        // Ignore cleanup errors.
    }
}

export async function runOcrFileBased(
    imagePath: string,
    languages: string[],
    imageWidth: number,
    imageHeight: number,
    extractionDpi: number,
    tesseractBinary: string,
    tessdataPath: string,
    threads?: number,
    signal?: AbortSignal,
    options?: IOcrSearchablePdfOptions,
): Promise<IOcrFileResult> {
    const outputBase = imagePath.replace(/\.png$/, '') + '-ocr';
    const languageConfig = resolveTesseractLanguageConfig(languages, {preserveDictionaries: shouldPreserveDictionaries(options)});
    const tsvPath = `${outputBase}.tsv`;
    const pdfPath = `${outputBase}.pdf`;

    const args = [
        imagePath,
        outputBase,
        '-l',
        languageConfig.orderedLanguages.join('+'),
        '--tessdata-dir',
        tessdataPath,
        '--dpi',
        String(extractionDpi),
        ...languageConfig.extraConfigArgs,
        ...buildTesseractProfileArgs(options),
        '-c',
        'tessedit_create_tsv=1',
        '-c',
        'tessedit_create_pdf=1',
        '-c',
        'textonly_pdf=1',
    ];

    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve({
                success: false,
                pageData: null,
                pdfPath: null,
                error: 'Tesseract aborted',
            });
            return;
        }

        const proc = spawn(tesseractBinary, args, createDetachedChildProcessSpawnOptions({ env: buildTesseractEnv(tessdataPath, threads) }));

        let stderr = '';
        let stderrTruncated = false;
        let timedOut = false;
        let aborted = false;
        const handles = {
            timeoutHandle: null as NodeJS.Timeout | null,
            killHandle: null as NodeJS.Timeout | null,
            forceFinalizeHandle: null as NodeJS.Timeout | null,
        };
        let abortHandler: (() => void) | null = null;

        const requestTermination = async () => {
            await terminateDetachedChildProcess(proc, FILE_BASED_OCR_KILL_GRACE_MS);
        };

        const finalize = createTesseractFinalize<IOcrFileResult>(handles, resolve, () => {
            if (signal && abortHandler) {
                signal.removeEventListener('abort', abortHandler);
            }
        });

        const cleanupTempOutputs = async () => {
            await Promise.all([
                safeUnlink(tsvPath),
                safeUnlink(pdfPath),
            ]);
        };

        const finalizeFailureAfterCleanup = async (error: string) => {
            await cleanupTempOutputs();
            finalize({
                success: false,
                pageData: null,
                pdfPath: null,
                error,
            });
        };

        const scheduleForceFinalizeAfterTermination = (error: string) => {
            if (handles.forceFinalizeHandle) {
                return;
            }
            handles.forceFinalizeHandle = setTimeout(async () => {
                await cleanupTempOutputs();
                finalize({
                    success: false,
                    pageData: null,
                    pdfPath: null,
                    error,
                });
            }, FILE_BASED_OCR_KILL_GRACE_MS + 1_000);
            handles.forceFinalizeHandle.unref?.();
        };

        const getCloseFailureMessage = (code: number | null, stderrSummary: string) => {
            if (aborted) {
                return 'Tesseract aborted';
            }
            if (timedOut) {
                return `Tesseract timed out after ${FILE_BASED_OCR_TIMEOUT_MS}ms`;
            }
            if (code !== 0) {
                return stderrSummary || `Tesseract exited with code ${code}`;
            }
            return null;
        };

        const handleSuccessfulClose = async () => {
            try {
                const tsvContent = await readFile(tsvPath, 'utf-8');
                const parsedTsv = parseTsvOcrData(tsvContent.trim());
                const { words } = parsedTsv;
                let pageText = parsedTsv.text;

                if (shouldNormalizeGreekMicroSign(languages)) {
                    for (const word of words) {
                        word.text = word.text.replace(/\u00B5/g, '\u03BC');
                    }
                    pageText = pageText.replace(/\u00B5/g, '\u03BC');
                }

                try {
                    await stat(pdfPath);
                } catch {
                    await finalizeFailureAfterCleanup('Tesseract did not produce PDF output');
                    return;
                }

                await safeUnlink(tsvPath);

                finalize({
                    success: true,
                    pageData: {
                        pageNumber: 0,
                        words,
                        text: pageText,
                        imageWidth,
                        imageHeight,
                    },
                    pdfPath,
                });
            } catch (parseErr) {
                const parseMsg = getErrorMessage(parseErr);
                await finalizeFailureAfterCleanup(parseMsg);
            }
        };

        if (signal) {
            abortHandler = () => {
                aborted = true;
                void requestTermination();
                scheduleForceFinalizeAfterTermination('Tesseract aborted');
            };
            signal.addEventListener('abort', abortHandler, { once: true });
        }

        handles.timeoutHandle = setTimeout(() => {
            timedOut = true;
            void requestTermination();

            handles.killHandle = setTimeout(() => {
                try {
                    proc.kill('SIGKILL');
                } catch {
                    // Process may have exited already.
                }
            }, FILE_BASED_OCR_KILL_GRACE_MS);
            handles.killHandle.unref?.();

            scheduleForceFinalizeAfterTermination(`Tesseract timed out after ${FILE_BASED_OCR_TIMEOUT_MS}ms`);
        }, FILE_BASED_OCR_TIMEOUT_MS);
        handles.timeoutHandle.unref?.();

        if (signal?.aborted) {
            abortHandler?.();
        }

        // File-output Tesseract jobs should not produce meaningful stdout, but
        // some builds still write progress text there. Drain it so the child
        // cannot block on a full pipe while stderr is the only captured stream.
        proc.stdout?.resume();

        proc.stderr?.on('data', (data: Buffer) => {
            const appended = appendTextChunkWithByteCap(stderr, data, FILE_BASED_OCR_MAX_STDERR_BYTES);
            stderr = appended.text;
            stderrTruncated = stderrTruncated || appended.truncated;
        });

        proc.on('close', async (code) => {
            const stderrSummary = stderrTruncated
                ? `[stderr truncated to ${FILE_BASED_OCR_MAX_STDERR_BYTES} bytes]\n${stderr}`
                : stderr;
            const closeFailureMessage = getCloseFailureMessage(code, stderrSummary);
            if (closeFailureMessage) {
                await finalizeFailureAfterCleanup(closeFailureMessage);
                return;
            }

            await handleSuccessfulClose();
        });

        proc.on('error', async (err) => {
            await finalizeFailureAfterCleanup(err.message);
        });
    });
}

interface ITsvLineBox {
    top: number;
    height: number;
}

interface IParsedTsvWordRow {
    parts: string[];
    text: string;
    left: number;
    top: number;
    width: number;
    height: number;
}

const TESSERACT_TSV_HEADER = [
    'level',
    'page_num',
    'block_num',
    'par_num',
    'line_num',
    'word_num',
    'left',
    'top',
    'width',
    'height',
    'conf',
    'text',
] as const;

function parsePositiveTsvInt(value: string | undefined) {
    const parsed = parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeTsvInt(value: string | undefined) {
    const parsed = parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function parseTsvOcrData(tsvContent: string): {
    words: IOcrWord[];
    text: string;
} {
    const acceptedWordRows: IParsedTsvWordRow[] = [];
    const lineBoxes = new Map<string, ITsvLineBox>();
    const textState: ITsvTextState = {
        currentLineKey: null,
        currentWords: [],
        outputLines: [],
    };

    for (const row of iterateTsvRows(tsvContent)) {
        const level = parseInt(row.parts[0]!, 10);
        if (level === 4) {
            const top = parseNonNegativeTsvInt(row.parts[7]);
            const height = parsePositiveTsvInt(row.parts[9]);
            if (top !== null && height !== null) {
                lineBoxes.set(getTsvLineKey(row.parts), {
                    top,
                    height,
                });
            }
            continue;
        }
        if (level !== 5) continue;

        const left = parseInt(row.parts[6]!, 10);
        const top = parseInt(row.parts[7]!, 10);
        const width = parseInt(row.parts[8]!, 10);
        const height = parseInt(row.parts[9]!, 10);
        const confidence = parseInt(row.parts[10]!, 10);
        if (confidence < 20) continue;
        if (width <= 0 || height <= 0) continue;

        appendTsvTextRow(textState, row);
        acceptedWordRows.push({
            parts: row.parts,
            text: row.text,
            left,
            top,
            width,
            height,
        });
    }

    flushTsvTextLine(textState.outputLines, textState.currentWords);

    return {
        words: acceptedWordRows.map((row) => {
            const lineBox = lineBoxes.get(getTsvLineKey(row.parts));
            return {
                text: row.text,
                x: row.left,
                y: lineBox?.top ?? row.top,
                width: row.width,
                height: lineBox?.height ?? row.height,
            };
        }),
        text: textState.outputLines.join('\n').trim(),
    };
}

export function parseTsvOutput(tsvContent: string): IOcrWord[] {
    return parseTsvOcrData(tsvContent).words;
}

function getTsvLineKey(parts: string[]) {
    const blockNum = parts[2]?.length ? parts[2] : '0';
    const parNum = parts[3]?.length ? parts[3] : '0';
    const lineNum = parts[4]?.length ? parts[4] : '0';
    return `${blockNum}-${parNum}-${lineNum}`;
}

function flushTsvTextLine(outputLines: string[], currentWords: string[]) {
    if (currentWords.length > 0) {
        outputLines.push(currentWords.join(' '));
    }
}

interface ITsvTextState {
    currentLineKey: string | null;
    currentWords: string[];
    outputLines: string[];
}

function appendTsvTextRow(
    state: ITsvTextState,
    row: {
        parts: string[];
        text: string;
    },
) {
    if (!row.text) {
        return;
    }

    const lineKey = getTsvLineKey(row.parts);
    if (state.currentLineKey !== null && lineKey !== state.currentLineKey) {
        flushTsvTextLine(state.outputLines, state.currentWords);
        state.currentWords = [];
    }

    state.currentLineKey = lineKey;
    state.currentWords.push(row.text);
}

function* iterateTsvRows(tsvContent: string): Generator<{
    parts: string[];
    text: string;
}> {
    const lines = tsvContent.trim().split(/\r?\n/);
    const header = lines[0]?.split('\t') ?? [];
    const hasValidHeader = TESSERACT_TSV_HEADER.every((column, index) => header[index] === column);
    if (!hasValidHeader) {
        throw new Error('Invalid Tesseract TSV output');
    }
    if (lines.length < 2) {
        return;
    }

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line?.trim()) continue;

        const parts = line.split('\t');
        if (parts.length < 12) continue;

        yield {
            parts,
            text: (parts[11] ?? '').trim(),
        };
    }
}
