import { readFile } from 'node:fs/promises';
import {
    basename,
    join,
} from 'node:path';
import { parseOcrIndexV3Manifest } from '@contracts/ocrIndex';
import type {
    IOcrDiagnostic,
    TOcrTextSupersessionPolicy,
} from '@contracts/electronApiOcr';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    IOcrPdfPageRequest,
    TWorkerLog,
} from '@electron/ocr/worker/types';
import {
    classifyOcrPageText,
    type IOcrPdfTextVisibility,
    inspectPdfPageTextVisibility,
    shouldOcrClassifiedPage,
} from '@electron/ocr/worker/pageTextClassifier';
import { runOcrCommand } from '@electron/ocr/worker/runOcrCommand';
import {
    groupContiguousPages,
    splitPdfTextOutput,
} from '@electron/pdf/pdfTextPageBatching';
import { isAbortError } from '@electron/utils/abort';
import { getErrorMessage } from '@electron/utils/error';

const TEXT_PROBE_TIMEOUT_MS = 2 * 60 * 1000;
const TEXT_PROBE_MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const TEXT_PROBE_UNAVAILABLE = '[text-probe-unavailable]';

async function readCurrentEvbGenerations(
    sourcePdfPath: string,
    documentRevisionToken: TDocumentRevisionToken,
) {
    const generations = new Map<number, string>();
    const manifest = await readFile(`${sourcePdfPath}.ocr/manifest.json`, 'utf8')
        .then(raw => parseOcrIndexV3Manifest(JSON.parse(raw), 'strict'))
        .catch(() => null);
    if (manifest?.documentRevision.token !== documentRevisionToken) {
        return generations;
    }

    for (const [
        rawPageNumber,
        mapping,
    ] of Object.entries(manifest.pages)) {
        const generation = basename(mapping.path) === mapping.path
            ? await readFile(join(`${sourcePdfPath}.ocr`, mapping.path), 'utf8')
                .then((raw) => {
                    const parsed: unknown = JSON.parse(raw);
                    if (!parsed || typeof parsed !== 'object' || !('canonicalText' in parsed)) {
                        return null;
                    }
                    const canonicalText: unknown = parsed.canonicalText;
                    if (!canonicalText || typeof canonicalText !== 'object' || !('generation' in canonicalText)) {
                        return null;
                    }
                    return typeof canonicalText.generation === 'string' ? canonicalText.generation : null;
                })
                .catch(() => null)
            : null;
        generations.set(Number(rawPageNumber), generation ?? `manifest-${manifest.createdAt}`);
    }
    return generations;
}

async function extractPageTextForClassification(input: {
    sourcePdfPath: string;
    pageNumbers: readonly number[];
    pdftotextBinary: string | undefined;
    log: TWorkerLog;
    signal: AbortSignal;
}) {
    const texts = new Map<number, string>();
    const warnings: string[] = [];
    // Probe failures fail closed so OCR cannot be appended beside text that
    // the worker was unable to inspect.
    const failClosed = (firstPage: number, lastPage: number, reason: string) => {
        for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
            texts.set(pageNumber, TEXT_PROBE_UNAVAILABLE);
        }
        const message = `Existing-text probe failed for pages ${firstPage}-${lastPage}; they were left untouched: ${reason}`;
        input.log('warn', message);
        warnings.push(message);
    };

    const orderedPages = Array.from(new Set(input.pageNumbers)).sort((left, right) => left - right);
    if (input.pdftotextBinary === undefined) {
        for (const range of groupContiguousPages(orderedPages)) {
            failClosed(range.firstPage, range.lastPage, 'pdftotext is unavailable');
        }
        return {
            texts,
            warnings,
        };
    }

    for (const range of groupContiguousPages(orderedPages)) {
        const rangeLength = range.lastPage - range.firstPage + 1;
        try {
            const probe = await runOcrCommand(input.pdftotextBinary, [
                '-f',
                String(range.firstPage),
                '-l',
                String(range.lastPage),
                input.sourcePdfPath,
                '-',
            ], {
                commandLabel: 'pdftotext(ocr-supersession-probe)',
                timeoutMs: TEXT_PROBE_TIMEOUT_MS,
                maxStdoutBytes: TEXT_PROBE_MAX_STDOUT_BYTES,
                rejectOnStdoutTruncation: true,
                signal: input.signal,
            });
            const rangeTexts = splitPdfTextOutput(probe.stdout, rangeLength);
            for (let index = 0; index < rangeLength; index += 1) {
                texts.set(range.firstPage + index, rangeTexts[index] ?? '');
            }
        } catch (err) {
            if (isAbortError(err)) {
                throw err;
            }
            failClosed(range.firstPage, range.lastPage, getErrorMessage(err));
        }
    }
    return {
        texts,
        warnings,
    };
}

export async function selectOcrPagesForSupersession(input: {
    sourcePdfPath: string;
    documentRevisionToken: TDocumentRevisionToken;
    pages: readonly IOcrPdfPageRequest[];
    supersessionPolicy: TOcrTextSupersessionPolicy;
    pdftotextBinary?: string;
    log: TWorkerLog;
    signal: AbortSignal;
}) {
    const pages: IOcrPdfPageRequest[] = [];
    const warnings: string[] = [];
    const diagnostics: IOcrDiagnostic[] = [];
    const generations = await readCurrentEvbGenerations(
        input.sourcePdfPath,
        input.documentRevisionToken,
    );
    const requestedPageNumbers = input.pages.map(page => page.pageNumber);
    const visibility = await inspectPdfPageTextVisibility(
        input.sourcePdfPath,
        requestedPageNumbers,
        input.signal,
    ).catch((err: unknown) => {
        if (isAbortError(err)) {
            throw err;
        }
        const message = `Text-visibility inspection failed; hidden OCR layers could not be detected and pages carrying text were kept as-is: ${getErrorMessage(err)}`;
        input.log('warn', message);
        warnings.push(message);
        return new Map<number, IOcrPdfTextVisibility>();
    });
    const textProbe = await extractPageTextForClassification({
        sourcePdfPath: input.sourcePdfPath,
        pageNumbers: requestedPageNumbers,
        pdftotextBinary: input.pdftotextBinary,
        log: input.log,
        signal: input.signal,
    });
    warnings.push(...textProbe.warnings);

    for (const page of input.pages) {
        const pageVisibility = visibility.get(page.pageNumber);
        const evbGeneration = generations.get(page.pageNumber);
        const evidence = classifyOcrPageText({
            extractedText: textProbe.texts.get(page.pageNumber) ?? TEXT_PROBE_UNAVAILABLE,
            ...(pageVisibility === undefined ? {} : {visibility: pageVisibility}),
            ...(evbGeneration === undefined ? {} : {evbGeneration}),
        });
        if (shouldOcrClassifiedPage(evidence.classification, input.supersessionPolicy)) {
            pages.push(page);
            continue;
        }
        const message = `Skipped page ${page.pageNumber}: classified ${evidence.classification} under ${input.supersessionPolicy} policy`;
        warnings.push(message);
        diagnostics.push({
            code: 'OCR_EXISTING_TEXT_SKIPPED',
            severity: 'info',
            pageNumber: page.pageNumber,
            message,
        });
    }
    return {
        pages,
        warnings,
        diagnostics,
    };
}
