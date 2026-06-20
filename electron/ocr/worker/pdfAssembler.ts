import {
    stat,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import { sortBy } from 'es-toolkit/array';
import type { TWorkerLog } from '@electron/ocr/worker/types';
import {
    runOcrCommand,
    type TOcrRunCommandOptions,
} from '@electron/ocr/worker/runOcrCommand';
import { abortErrorFromSignal } from '@electron/utils/abort';

const QPDF_TIMEOUT_MS = 2 * 60 * 1000;
const QPDF_OUTPUT_SUCCESS_EXIT_CODES = [
    0,
    3,
];
const TESSERACT_IMAGE_PAINT_RE = /^q\s+[\d.]+\s+0\s+0\s+[\d.]+\s+0\s+0\s+cm\s+\/Im\d+\s+Do\s+Q\r?\n/gm;
const TESSERACT_IMAGE_XOBJECT_RE = /\n\s*\/XObject\s*<<\s*\n(?:\s*\/Im\d+\s+\d+\s+\d+\s+R\s*\n)+\s*>>/g;

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

async function assertNonEmptyFile(path: string, label: string) {
    const fileStat = await stat(path);
    if (fileStat.size <= 0) {
        throw new Error(`${label} is empty: ${path}`);
    }
}

export async function getPageCount(
    qpdfBinary: string,
    pdfPath: string,
    fallback: number,
    signal?: AbortSignal,
) {
    try {
        const commandOptions: TOcrRunCommandOptions = {
            timeoutMs: QPDF_TIMEOUT_MS,
            commandLabel: 'qpdf(show-npages)',
        };
        if (signal !== undefined) {
            commandOptions.signal = signal;
        }

        const result = await runOcrCommand(qpdfBinary, [
            '--show-npages',
            pdfPath,
        ], commandOptions);
        const parsed = parseInt((result.stdout ?? '').trim(), 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    } catch {
        // Use fallback
    }
    return fallback;
}

async function writeQpdfArgFile(path: string, args: string[]) {
    await writeFile(path, `${args.join('\n')}\n`, 'utf8');
}

function buildValidOcrPageEntries(ocrPdfMap: Map<number, string>, pageCount: number) {
    return sortBy(
        Array.from(ocrPdfMap.entries())
            .filter(([pageNumber]) => pageNumber >= 1 && pageNumber <= pageCount),
        [([pageNumber]) => pageNumber],
    );
}

export function stripTesseractImageLayer(qdfSource: string) {
    const withoutImagePaint = qdfSource.replace(TESSERACT_IMAGE_PAINT_RE, '');
    return withoutImagePaint.replace(TESSERACT_IMAGE_XOBJECT_RE, '');
}

async function runQpdf(
    qpdfBinary: string,
    args: string[],
    commandLabel: string,
    log: TWorkerLog,
    signal?: AbortSignal,
) {
    const commandOptions: TOcrRunCommandOptions = {
        timeoutMs: QPDF_TIMEOUT_MS,
        allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
        commandLabel,
        log,
    };
    if (signal !== undefined) {
        commandOptions.signal = signal;
    }
    await runOcrCommand(qpdfBinary, args, commandOptions);
}

function formatPageRange(startPage: number, endPage: number) {
    return startPage === endPage
        ? String(startPage)
        : `${startPage}-${endPage}`;
}

function buildReplacementPageSelectionArgs(
    ocrPageEntries: Array<[number, string]>,
    pageCount: number,
) {
    const args: string[] = [];
    let nextOriginalPage = 1;

    for (const [
        pageNumber,
        ocrPdfPath,
    ] of ocrPageEntries) {
        if (nextOriginalPage < pageNumber) {
            args.push('.', formatPageRange(nextOriginalPage, pageNumber - 1));
        }

        args.push(ocrPdfPath, '1');
        nextOriginalPage = pageNumber + 1;
    }

    if (nextOriginalPage <= pageCount) {
        args.push('.', formatPageRange(nextOriginalPage, pageCount));
    }

    return args;
}

export async function assembleSearchablePdf(
    qpdfBinary: string,
    originalPdfPath: string,
    ocrPdfMap: Map<number, string>,
    pageCount: number,
    tempDir: string,
    sessionId: string,
    log: TWorkerLog,
    trackTempFile: (path: string) => string,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    log('debug', `Replacing OCR text layer for ${ocrPdfMap.size} page(s) with qpdf`);
    await assertNonEmptyFile(originalPdfPath, 'Original PDF');
    await Promise.all(Array.from(ocrPdfMap.entries()).map(
        ([
            pageNumber,
            ocrPath,
        ]) => assertNonEmptyFile(ocrPath, `OCR PDF page ${pageNumber}`),
    ));

    const ocrPageEntries = buildValidOcrPageEntries(ocrPdfMap, pageCount);
    if (ocrPageEntries.length === 0) {
        throw new Error('No valid OCR pages were available to assemble');
    }

    const replacementPdfPath = trackTempFile(join(tempDir, `${sessionId}-merged.pdf`));
    const argFilePath = trackTempFile(join(tempDir, `${sessionId}-qpdf-replace.args`));
    const args = [
        originalPdfPath,
        '--stream-data=compress',
        '--object-streams=generate',
        '--compression-level=9',
        '--pages',
        ...buildReplacementPageSelectionArgs(ocrPageEntries, pageCount),
        '--',
        replacementPdfPath,
    ];
    await writeQpdfArgFile(argFilePath, args);
    throwIfAborted(signal);

    await runQpdf(qpdfBinary, [`@${argFilePath}`], 'qpdf(ocr-replace)', log, signal);
    await assertNonEmptyFile(replacementPdfPath, 'Assembled OCR PDF');
    throwIfAborted(signal);

    return replacementPdfPath;
}
