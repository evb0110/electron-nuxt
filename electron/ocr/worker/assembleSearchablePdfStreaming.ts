import {
    stat,
    writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { runOcrCommand } from '@electron/ocr/worker/runOcrCommand';

const QPDF_TIMEOUT_MS = 10 * 60 * 1000;

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
    const replacements = new Map<number, string>();
    for (const [
        pageNumber,
        ocrPagePath,
    ] of options.ocrPageEntries) {
        throwIfAborted(options.signal);
        const extractedPath = options.trackTempFile(join(
            options.tempDir,
            `${options.sessionId}-source-page-${pageNumber}.pdf`,
        ));
        const replacementPath = options.trackTempFile(join(
            options.tempDir,
            `${options.sessionId}-ocr-page-${pageNumber}.pdf`,
        ));
        await runQpdf(options.qpdfBinary, [
            options.originalPdfPath,
            '--pages',
            options.originalPdfPath,
            String(pageNumber),
            '--',
            extractedPath,
        ], options.signal);
        await options.mutatePage(extractedPath, ocrPagePath, replacementPath);
        replacements.set(pageNumber, replacementPath);
    }

    const outputPath = options.trackTempFile(join(options.tempDir, `${options.sessionId}-merged.pdf`));
    const argsPath = options.trackTempFile(join(options.tempDir, `${options.sessionId}-qpdf-args.txt`));
    const args = [
        options.originalPdfPath,
        '--pages',
        ...buildPageSelectionArgs(options.originalPdfPath, replacements, options.pageCount),
        '--',
        outputPath,
    ];
    await writeFile(argsPath, args.map(arg => arg.replace(/\r?\n/gu, ' ')).join('\n'));
    throwIfAborted(options.signal);
    await runQpdf(options.qpdfBinary, [`@${argsPath}`], options.signal);
    if ((await stat(outputPath)).size <= 0) {
        throw new Error('Streaming OCR assembly produced an empty PDF');
    }
    return outputPath;
}
