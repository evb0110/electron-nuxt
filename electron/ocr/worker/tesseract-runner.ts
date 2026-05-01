import { spawn } from 'child_process';
import {
    readFile,
    stat,
    unlink,
} from 'fs/promises';
import type { IOcrWord } from '@contracts/shared';
import type { IOcrFileResult } from '@electron/ocr/worker/types';
import { resolveTesseractLanguageConfig } from '@electron/ocr/tesseract-language-config';
import { terminateProcessTree } from '@electron/utils/process-tree';
import { getErrorMessage } from '@electron/utils/error';
import { appendTextChunkWithByteCap } from '@electron/native-tools/output-buffer';
import { parseIntegerEnv } from '@electron/utils/env';
import { buildTesseractEnv } from '@electron/ocr/tesseract-env';

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

export function getPngDimensions(imageBuffer: Buffer): {
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
): Promise<IOcrFileResult> {
    const outputBase = imagePath.replace(/\.png$/, '') + '-ocr';
    const languageConfig = resolveTesseractLanguageConfig(languages);
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

        const proc = spawn(tesseractBinary, args, {
            env: buildTesseractEnv(tessdataPath, threads),
            detached: process.platform !== 'win32',
        });

        let stderr = '';
        let stderrTruncated = false;
        let settled = false;
        let timedOut = false;
        let aborted = false;
        let timeoutHandle: NodeJS.Timeout | null = null;
        let killHandle: NodeJS.Timeout | null = null;
        let forceFinalizeHandle: NodeJS.Timeout | null = null;
        let abortHandler: (() => void) | null = null;

        const requestTermination = () => {
            const pid = proc.pid;
            if (typeof pid === 'number' && Number.isFinite(pid) && pid > 0) {
                void terminateProcessTree(pid, {
                    graceMs: FILE_BASED_OCR_KILL_GRACE_MS,
                    preferProcessGroup: process.platform !== 'win32',
                });
                return;
            }

            try {
                proc.kill('SIGTERM');
            } catch {
                // Process may have exited already.
            }
        };

        const finalize = (result: IOcrFileResult) => {
            if (settled) {
                return;
            }

            settled = true;
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            if (killHandle) {
                clearTimeout(killHandle);
                killHandle = null;
            }
            if (forceFinalizeHandle) {
                clearTimeout(forceFinalizeHandle);
                forceFinalizeHandle = null;
            }
            if (signal && abortHandler) {
                signal.removeEventListener('abort', abortHandler);
            }
            resolve(result);
        };

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
                const words = parseTsvOutput(tsvContent.trim());
                let pageText = parseTsvText(tsvContent.trim());

                if (languages.includes('ell')) {
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
                requestTermination();
            };
            signal.addEventListener('abort', abortHandler, { once: true });
        }

        timeoutHandle = setTimeout(() => {
            timedOut = true;
            requestTermination();

            killHandle = setTimeout(() => {
                try {
                    proc.kill('SIGKILL');
                } catch {
                    // Process may have exited already.
                }
            }, FILE_BASED_OCR_KILL_GRACE_MS);
            killHandle.unref?.();

            forceFinalizeHandle = setTimeout(async () => {
                await cleanupTempOutputs();
                finalize({
                    success: false,
                    pageData: null,
                    pdfPath: null,
                    error: `Tesseract timed out after ${FILE_BASED_OCR_TIMEOUT_MS}ms`,
                });
            }, FILE_BASED_OCR_KILL_GRACE_MS + 1_000);
            forceFinalizeHandle.unref?.();
        }, FILE_BASED_OCR_TIMEOUT_MS);
        timeoutHandle.unref?.();

        if (signal?.aborted) {
            abortHandler?.();
        }

        proc.stderr.on('data', (data: Buffer) => {
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

function parseTsvOutput(tsvContent: string): IOcrWord[] {
    const words: IOcrWord[] = [];

    for (const {
        parts,
        text,
    } of iterateTsvWordRows(tsvContent)) {
        const left = parseInt(parts[6]!, 10);
        const top = parseInt(parts[7]!, 10);
        const width = parseInt(parts[8]!, 10);
        const height = parseInt(parts[9]!, 10);
        const confidence = parseInt(parts[10]!, 10);

        if (confidence < 20) continue;
        if (width <= 0 || height <= 0) continue;

        words.push({
            text,
            x: left,
            y: top,
            width,
            height,
        });
    }

    return words;
}

function getTsvLineKey(parts: string[]) {
    const blockNum = parts[2] || '0';
    const parNum = parts[3] || '0';
    const lineNum = parts[4] || '0';
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

function parseTsvText(tsvContent: string): string {
    const state: ITsvTextState = {
        currentLineKey: null,
        currentWords: [],
        outputLines: [],
    };

    for (const row of iterateTsvWordRows(tsvContent)) {
        appendTsvTextRow(state, row);
    }

    flushTsvTextLine(state.outputLines, state.currentWords);

    return state.outputLines.join('\n').trim();
}

function* iterateTsvWordRows(tsvContent: string): Generator<{
    parts: string[];
    text: string;
}> {
    const lines = tsvContent.trim().split('\n');
    if (lines.length < 2) {
        return;
    }

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i]?.trim();
        if (!line) continue;

        const parts = line.split('\t');
        if (parts.length < 12) continue;

        const level = parseInt(parts[0]!, 10);
        if (level !== 5) continue;

        yield {
            parts,
            text: (parts[11] || '').trim(),
        };
    }
}
