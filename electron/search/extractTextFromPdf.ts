import { existsSync } from 'fs';
import { createLogger } from '@electron/utils/createLogger';
import { runElectronCommand } from '@electron/utils/runElectronCommand';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { buildPopplerEnv } from '@electron/native-tools/buildPopplerEnv';
import {
    abortErrorFromSignal,
    isAbortError,
} from '@electron/utils/abort';
import { getErrorMessage } from '@electron/utils/error';
import { assembleSearchablePageText } from '@pdf-core';
import type { IPageText } from '@electron/search/pageText';

const log = createLogger('pdfTextExtractor');
const PDFTOTEXT_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_PDFTOTEXT_TIMEOUT_MS ?? `${2 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 5_000) {
        return 2 * 60 * 1000;
    }
    return parsed;
})();
const PDFTOTEXT_MAX_STDOUT_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_PDFTOTEXT_MAX_STDOUT_MB ?? '64', 10);
    if (!Number.isFinite(parsed) || parsed < 4) {
        return 64 * 1024 * 1024;
    }
    return parsed * 1024 * 1024;
})();

interface IExtractTextOptions {
    pageCount?: number;
    signal?: AbortSignal;
    pages?: readonly number[];
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

function normalizeRequestedPages(pages: readonly number[] | undefined, pageCount?: number) {
    if (!pages || pages.length === 0) {
        return [];
    }

    return Array.from(new Set(
        pages
            .map(page => Math.trunc(page))
            .filter(page => page >= 1 && (pageCount === undefined || page <= pageCount)),
    )).sort((left, right) => left - right);
}

function groupContiguousPages(pages: readonly number[]) {
    const ranges: Array<{
        firstPage: number;
        lastPage: number
    }> = [];
    for (const page of pages) {
        const lastRange = ranges.at(-1);
        if (lastRange && page === lastRange.lastPage + 1) {
            lastRange.lastPage = page;
            continue;
        }

        ranges.push({
            firstPage: page,
            lastPage: page,
        });
    }
    return ranges;
}

function splitPdfTextOutput(output: string, expectedCount?: number) {
    let pages = output.split('\f');
    if (typeof expectedCount === 'number' && expectedCount > 0) {
        if (pages.length < expectedCount) {
            pages = pages.concat(Array.from({ length: expectedCount - pages.length }, () => ''));
        } else if (pages.length > expectedCount) {
            pages = pages.slice(0, expectedCount);
        }
    } else if (pages.length > 1 && pages.at(-1)?.trim() === '') {
        pages = pages.slice(0, -1);
    }
    return pages;
}

/**
 * Extract all text from a PDF using pdftotext command
 * Returns text organized by page
 */
export async function extractTextFromPdf(
    pdfPath: string,
    options: IExtractTextOptions = {},
): Promise<IPageText[]> {
    log.debug(`Extracting text from PDF: ${pdfPath}`);
    const { signal } = options;
    throwIfAborted(signal);

    const paths = getPdfNativeToolPaths();
    const { pdftotext } = paths;
    const popplerEnv = buildPopplerEnv(paths);
    log.debug(`Using pdftotext at: ${pdftotext}`);

    // Check if the resolved path exists (if it's an absolute path)
    const isAbsolutePath = pdftotext.includes('/') || pdftotext.includes('\\');
    if (isAbsolutePath && !existsSync(pdftotext)) {
        throw new Error(
            `pdftotext binary not found at: ${pdftotext}. ` +
            'Ensure Poppler is bundled in resources/poppler/ or installed system-wide.',
        );
    }

    try {
        throwIfAborted(signal);
        // Use pdftotext -layout to preserve some structure
        // Each page is separated by form feed character (0x0C)
        const commandOptions: Parameters<typeof runElectronCommand>[2] = {
            timeoutMs: PDFTOTEXT_TIMEOUT_MS,
            maxStdoutBytes: PDFTOTEXT_MAX_STDOUT_BYTES,
            rejectOnStdoutTruncation: true,
        };
        if (popplerEnv !== undefined) {
            commandOptions.env = popplerEnv;
        }
        if (signal !== undefined) {
            commandOptions.signal = signal;
        }

        const requestedPages = normalizeRequestedPages(options.pages, options.pageCount);
        const argsForRange = (firstPage: number, lastPage: number) => [
            '-layout',
            '-f',
            String(firstPage),
            '-l',
            String(lastPage),
            pdfPath,
            '-',
        ];
        const allPagesArgs = [
            '-layout',
            pdfPath,
            '-',
        ];

        const rangeOutputs: Array<{
            firstPage: number;
            texts: string[]
        }> = [];
        if (requestedPages.length > 0) {
            for (const range of groupContiguousPages(requestedPages)) {
                const result = await runElectronCommand(pdftotext, argsForRange(range.firstPage, range.lastPage), commandOptions);
                rangeOutputs.push({
                    firstPage: range.firstPage,
                    texts: splitPdfTextOutput(result.stdout ?? '', range.lastPage - range.firstPage + 1),
                });
            }
        } else {
            const result = await runElectronCommand(pdftotext, allPagesArgs, commandOptions);
            rangeOutputs.push({
                firstPage: 1,
                texts: splitPdfTextOutput(result.stdout ?? '', options.pageCount),
            });
        }
        throwIfAborted(signal);

        const pageTexts: IPageText[] = rangeOutputs.flatMap(range => range.texts.map((text, index) => ({
            pageNumber: range.firstPage + index,
            text: assembleSearchablePageText([{text: text.trim()}]).text,
        })));

        log.debug(`Extracted ${pageTexts.length} page segments from PDF`);

        return pageTexts;
    } catch (err) {
        if (isAbortError(err)) {
            throw err;
        }

        const errMsg = getErrorMessage(err);
        log.debug(`Failed to extract text using ${pdftotext}: ${errMsg}`);

        // Provide actionable error message
        const isNotFound = errMsg.includes('ENOENT') || errMsg.includes('not found');
        if (isNotFound) {
            throw new Error(
                `pdftotext command failed - binary not found or not executable at: ${pdftotext}. ` +
                'Ensure Poppler is bundled in resources/poppler/ or installed system-wide.',
            );
        }

        throw new Error(`Failed to extract text from PDF: ${errMsg}`);
    }
}
