import {
    mkdir,
    readdir,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { runOcrCommand } from '@electron/ocr/worker/runOcrCommand';
import {
    forEachConcurrent,
    getOcrConcurrency,
} from '@electron/utils/concurrency';

const QPDF_TIMEOUT_MS = 10 * 60 * 1000;
const SPLIT_PAGE_FILE_RE = /^page-(\d+)\.pdf$/u;

interface IStreamingPdfAssemblerOptions {
    qpdfBinary: string;
    originalPdfPath: string;
    ocrPageEntries: ReadonlyArray<readonly [number, string]>;
    pageCount: number;
    tempDir: string;
    sessionId: string;
    trackTempFile: (path: string) => string;
    signal?: AbortSignal;
    mutatePage: (originalPagePath: string, ocrPagePath: string, outputPath: string) => Promise<void>;
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new DOMException('OCR assembly canceled', 'AbortError');
    }
}

async function runQpdf(binary: string, args: string[], signal?: AbortSignal) {
    await runOcrCommand(binary, args, {
        allowedExitCodes: [
            0,
            3,
        ],
        commandLabel: 'qpdf(streaming-ocr-assembly)',
        timeoutMs: QPDF_TIMEOUT_MS,
        ...(signal ? {signal} : {}),
    });
}

async function writeQpdfArgsFile(path: string, args: readonly string[]) {
    await writeFile(path, args.map(arg => arg.replace(/\r?\n/gu, ' ')).join('\n'));
}

async function extractSourcePages(
    options: IStreamingPdfAssemblerOptions,
    pageNumbers: readonly number[],
) {
    const splitDir = options.trackTempFile(join(options.tempDir, `${options.sessionId}-source-pages`));
    await mkdir(splitDir, {recursive: true});
    const argsPath = options.trackTempFile(join(
        options.tempDir,
        `${options.sessionId}-qpdf-extract-args.txt`,
    ));
    await writeQpdfArgsFile(argsPath, [
        options.originalPdfPath,
        '--pages',
        options.originalPdfPath,
        pageNumbers.join(','),
        '--',
        '--split-pages=1',
        join(splitDir, 'page.pdf'),
    ]);
    await runQpdf(options.qpdfBinary, [`@${argsPath}`], options.signal);

    const produced = (await readdir(splitDir))
        .map(name => ({
            name,
            index: Number(SPLIT_PAGE_FILE_RE.exec(name)?.[1] ?? Number.NaN),
        }))
        .filter(entry => Number.isSafeInteger(entry.index))
        .sort((left, right) => left.index - right.index);
    if (produced.length !== pageNumbers.length) {
        throw new Error(
            `qpdf extracted ${produced.length} source page(s) for ${pageNumbers.length} OCR page(s)`,
        );
    }
    const pathByPage = new Map<number, string>();
    produced.forEach((entry, index) => {
        const pageNumber = pageNumbers[index];
        if (pageNumber !== undefined) {
            pathByPage.set(pageNumber, options.trackTempFile(join(splitDir, entry.name)));
        }
    });
    return {
        splitDir,
        pathByPage,
    };
}

function buildPageSelectionArgs(
    originalPdfPath: string,
    replacementByPage: ReadonlyMap<number, string>,
    pageCount: number,
) {
    const args: string[] = [];
    let page = 1;
    while (page <= pageCount) {
        const replacement = replacementByPage.get(page);
        if (replacement) {
            args.push(replacement, '1');
            page += 1;
            continue;
        }
        const start = page;
        while (page <= pageCount && !replacementByPage.has(page)) {
            page += 1;
        }
        const end = page - 1;
        args.push(originalPdfPath, start === end ? String(start) : `${start}-${end}`);
    }
    return args;
}

export async function assembleSearchablePdfStreaming(options: IStreamingPdfAssemblerOptions) {
    throwIfAborted(options.signal);
    const entries = [...options.ocrPageEntries];
    const pageNumbers = Array.from(new Set(entries.map(([pageNumber]) => pageNumber)))
        .sort((left, right) => left - right);
    const extracted = await extractSourcePages(options, pageNumbers);

    const replacements = new Map<number, string>();
    try {
        await forEachConcurrent(entries, getOcrConcurrency(entries.length), async ([
            pageNumber,
            ocrPagePath,
        ]) => {
            throwIfAborted(options.signal);
            const extractedPath = extracted.pathByPage.get(pageNumber);
            if (extractedPath === undefined) {
                throw new Error(`Missing extracted source page ${pageNumber} for OCR assembly`);
            }
            const replacementPath = options.trackTempFile(join(
                options.tempDir,
                `${options.sessionId}-ocr-page-${pageNumber}.pdf`,
            ));
            await options.mutatePage(extractedPath, ocrPagePath, replacementPath);
            replacements.set(pageNumber, replacementPath);
        });
    } finally {
        await rm(extracted.splitDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
    }

    const outputPath = options.trackTempFile(join(options.tempDir, `${options.sessionId}-merged.pdf`));
    const argsPath = options.trackTempFile(join(options.tempDir, `${options.sessionId}-qpdf-args.txt`));
    await writeQpdfArgsFile(argsPath, [
        options.originalPdfPath,
        '--pages',
        ...buildPageSelectionArgs(options.originalPdfPath, replacements, options.pageCount),
        '--',
        outputPath,
    ]);
    throwIfAborted(options.signal);
    await runQpdf(options.qpdfBinary, [`@${argsPath}`], options.signal);
    if ((await stat(outputPath)).size <= 0) {
        throw new Error('Streaming OCR assembly produced an empty PDF');
    }
    return outputPath;
}
