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

function buildOriginalPageRange(start: number, end: number) {
    if (start > end) {
        return null;
    }
    if (start === end) {
        return String(start);
    }
    return `${start}-${end}`;
}

function buildReplacementPageArgs(
    originalPdfPath: string,
    ocrPdfMap: Map<number, string>,
    pageCount: number,
) {
    const args: string[] = [];
    let nextOriginalPage = 1;
    const replacementPages = sortBy(
        Array.from(ocrPdfMap.entries())
            .filter(([pageNumber]) => pageNumber >= 1 && pageNumber <= pageCount),
        [([pageNumber]) => pageNumber],
    );

    for (const [
        pageNumber,
        ocrPdfPath,
    ] of replacementPages) {
        const originalRange = buildOriginalPageRange(nextOriginalPage, pageNumber - 1);
        if (originalRange) {
            args.push(originalPdfPath, originalRange);
        }
        args.push(ocrPdfPath, '1');
        nextOriginalPage = pageNumber + 1;
    }

    const tailRange = buildOriginalPageRange(nextOriginalPage, pageCount);
    if (tailRange) {
        args.push(originalPdfPath, tailRange);
    }

    return args;
}

async function writeQpdfArgFile(path: string, args: string[]) {
    await writeFile(path, `${args.join('\n')}\n`, 'utf8');
}

export async function assembleSearchablePdf(
    qpdfBinary: string,
    originalPdfPath: string,
    ocrPdfMap: Map<number, string>,
    pageImageMap: Map<number, string>,
    pageCount: number,
    tempDir: string,
    sessionId: string,
    log: TWorkerLog,
    trackTempFile: (path: string) => string,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    log('debug', `Replacing ${ocrPdfMap.size} page(s) with qpdf page splicing (${pageImageMap.size} rendered image(s) produced)`);
    await assertNonEmptyFile(originalPdfPath, 'Original PDF');
    await Promise.all(Array.from(ocrPdfMap.entries()).map(
        ([
            pageNumber,
            ocrPath,
        ]) => assertNonEmptyFile(ocrPath, `OCR PDF page ${pageNumber}`),
    ));

    const replacementPdfPath = trackTempFile(join(tempDir, `${sessionId}-merged.pdf`));
    const argFilePath = trackTempFile(join(tempDir, `${sessionId}-qpdf-pages.args`));
    const args = [
        originalPdfPath,
        '--pages',
        ...buildReplacementPageArgs(originalPdfPath, ocrPdfMap, pageCount),
        '--',
        replacementPdfPath,
    ];
    await writeQpdfArgFile(argFilePath, args);
    throwIfAborted(signal);

    const commandOptions: TOcrRunCommandOptions = {
        timeoutMs: QPDF_TIMEOUT_MS,
        allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
        commandLabel: 'qpdf(ocr-assemble)',
        log,
    };
    if (signal !== undefined) {
        commandOptions.signal = signal;
    }
    await runOcrCommand(qpdfBinary, [`@${argFilePath}`], commandOptions);
    await assertNonEmptyFile(replacementPdfPath, 'Assembled OCR PDF');
    throwIfAborted(signal);

    return replacementPdfPath;
}
