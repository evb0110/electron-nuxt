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
import type { IOcrPdfPageRequest } from '@electron/ocr/worker/types';
import {
    classifyOcrPageText,
    type IOcrPdfTextVisibility,
    inspectPdfPageTextVisibility,
    shouldOcrClassifiedPage,
} from '@electron/ocr/worker/pageTextClassifier';
import { runOcrCommand } from '@electron/ocr/worker/runOcrCommand';

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

export async function selectOcrPagesForSupersession(input: {
    sourcePdfPath: string;
    documentRevisionToken: TDocumentRevisionToken;
    pages: readonly IOcrPdfPageRequest[];
    supersessionPolicy: TOcrTextSupersessionPolicy;
    pdftotextBinary?: string;
    signal: AbortSignal;
}) {
    const generations = await readCurrentEvbGenerations(
        input.sourcePdfPath,
        input.documentRevisionToken,
    );
    const visibility = await inspectPdfPageTextVisibility(
        input.sourcePdfPath,
        input.pages.map(page => page.pageNumber),
        input.signal,
    ).catch(() => new Map<number, IOcrPdfTextVisibility>());
    const pages: IOcrPdfPageRequest[] = [];
    const warnings: string[] = [];
    const diagnostics: IOcrDiagnostic[] = [];

    for (const page of input.pages) {
        const textProbe = input.pdftotextBinary
            ? await runOcrCommand(input.pdftotextBinary, [
                '-f',
                String(page.pageNumber),
                '-l',
                String(page.pageNumber),
                input.sourcePdfPath,
                '-',
            ], {
                timeoutMs: 30_000,
                signal: input.signal,
            })
            : {
                exitCode: 1,
                stdout: '',
            };
        const pageVisibility = visibility.get(page.pageNumber);
        const evbGeneration = generations.get(page.pageNumber);
        const evidence = classifyOcrPageText({
            // Probe failures fail closed so OCR cannot be appended beside
            // text that the worker was unable to inspect.
            extractedText: textProbe.exitCode === 0 ? textProbe.stdout : '[text-probe-unavailable]',
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
