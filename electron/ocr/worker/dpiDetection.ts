import type { TWorkerLog } from '@electron/ocr/worker/types';
import {
    runOcrCommand,
    type TOcrRunCommandOptions,
} from '@electron/ocr/worker/runOcrCommand';
import { compact } from 'es-toolkit/array';
import { clamp } from 'es-toolkit/math';
import { getErrorMessage } from '@electron/utils/error';

const PDFIMAGES_TIMEOUT_MS = 30 * 1000;

export interface ISourceDpiDetectionResult {
    documentDpi: number | null;
    pageDpiByNumber: Map<number, number>;
}

function getPageProbeRange(pages: readonly number[] | undefined) {
    const validPages = (pages ?? []).filter(pageNumber =>
        Number.isSafeInteger(pageNumber) && pageNumber > 0,
    );
    if (validPages.length === 0) {
        return null;
    }

    return {
        firstPage: Math.min(...validPages),
        lastPage: Math.max(...validPages),
    };
}

function buildPdfImagesListArgs(pdfPath: string, pages: readonly number[] | undefined) {
    const pageRange = getPageProbeRange(pages);
    if (!pageRange) {
        return [
            '-list',
            pdfPath,
        ];
    }

    return [
        '-f',
        String(pageRange.firstPage),
        '-l',
        String(pageRange.lastPage),
        '-list',
        pdfPath,
    ];
}

function createRecoverablePdfImagesLog(log: TWorkerLog): TWorkerLog {
    return (level, message) => {
        log(level === 'error' ? 'debug' : level, message);
    };
}

function parsePdfImagesListOutput(output: string): ISourceDpiDetectionResult {
    const pageDpiByNumber = new Map<number, number>();
    const lines = compact(output.split(/\r?\n/).map(line => line.trim()));
    let documentDpi = 0;

    for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length < 14) {
            continue;
        }
        const pageNumber = parseInt(parts[0] ?? '', 10);
        const xPpi = parseInt(parts[12] ?? '', 10);
        const yPpi = parseInt(parts[13] ?? '', 10);
        const dpi = Math.max(
            Number.isFinite(xPpi) ? xPpi : 0,
            Number.isFinite(yPpi) ? yPpi : 0,
        );
        if (!Number.isFinite(pageNumber) || pageNumber <= 0 || dpi <= 0) {
            continue;
        }

        documentDpi = Math.max(documentDpi, dpi);
        pageDpiByNumber.set(pageNumber, Math.max(pageDpiByNumber.get(pageNumber) ?? 0, dpi));
    }

    return {
        documentDpi: documentDpi > 0 ? documentDpi : null,
        pageDpiByNumber,
    };
}

export async function detectSourceDpiDetails(
    pdfPath: string,
    pdfimagesBinary: string | undefined,
    log: TWorkerLog,
    commandEnv?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
    pages?: readonly number[],
): Promise<ISourceDpiDetectionResult> {
    if (!pdfimagesBinary) {
        return {
            documentDpi: null,
            pageDpiByNumber: new Map(),
        };
    }
    if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('OCR job aborted');
    }

    try {
        const commandOptions: TOcrRunCommandOptions = {
            commandLabel: 'pdfimages(-list)',
            timeoutMs: PDFIMAGES_TIMEOUT_MS,
            log: createRecoverablePdfImagesLog(log),
        };
        if (commandEnv !== undefined) {
            commandOptions.env = commandEnv;
        }
        if (signal !== undefined) {
            commandOptions.signal = signal;
        }

        const result = await runOcrCommand(
            pdfimagesBinary,
            buildPdfImagesListArgs(pdfPath, pages),
            commandOptions,
        );
        return parsePdfImagesListOutput(result.stdout);
    } catch (err) {
        if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : err;
        }
        log('debug', `pdfimages detection failed: ${getErrorMessage(err)}`);
    }

    return {
        documentDpi: null,
        pageDpiByNumber: new Map(),
    };
}

export async function detectSourceDpi(
    pdfPath: string,
    pdfimagesBinary: string | undefined,
    log: TWorkerLog,
    commandEnv?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
    pages?: readonly number[],
) {
    return (await detectSourceDpiDetails(
        pdfPath,
        pdfimagesBinary,
        log,
        commandEnv,
        signal,
        pages,
    )).documentDpi;
}

export function clampDpi(value: number) {
    if (!Number.isFinite(value)) {
        return 300;
    }
    return clamp(Math.round(value), 72, 1200);
}
