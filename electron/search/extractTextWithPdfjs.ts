import {
    readFile,
    stat,
} from 'fs/promises';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { dirname } from 'path';
import {
    fileURLToPath,
    pathToFileURL,
} from 'url';
// Must set up DOM stubs before importing pdfjs — the legacy build still
// references DOMMatrix at module evaluation time (canvas rendering code).
import '@electron/search/domPolyfill';
// Must use the legacy build — the default build uses DOMMatrix and other
// browser-only APIs that don't exist in Node.js worker threads.
import {
    getDocument,
    GlobalWorkerOptions,
    OPS,
    VerbosityLevel,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import { abortErrorFromSignal } from '@electron/utils/abort';
import { createLogger } from '@electron/utils/createLogger';
import { resolveUnpackedWorkerPath } from '@electron/utils/workerTask';
import { buildOcrTextLayerIndexText } from '@contracts/ocrText';
import type { IPageText } from '@electron/search/pageText';
import type { IOcrWord } from '@contracts/shared';
import {
    collapseRepeatedPdfSearchPageText,
    extractPdfjsWordBoxesFromOperatorList,
    getPdfjsPageViewBox,
} from '@pdf-core';
import { createPdfjsNodeDocumentOptions } from '@electron/search/createPdfjsNodeDocumentOptions';

function resolvePdfjsFakeWorkerSrc() {
    // pdfjs's Node fallback dynamically imports workerSrc; the default
    // "./pdf.worker.mjs" resolves relative to the importing bundle, which
    // breaks for asar-unpacked workers. Resolve an absolute path instead.
    const bundleDir = dirname(fileURLToPath(import.meta.url));
    const siblingWorkerPath = resolveUnpackedWorkerPath(bundleDir, 'pdf.worker.mjs');
    if (existsSync(siblingWorkerPath)) {
        return pathToFileURL(siblingWorkerPath).href;
    }

    // Source-context execution (unit tests, tsx) has no sibling copy; fall
    // back to the package's own worker module.
    const requireFromHere = createRequire(import.meta.url);
    return pathToFileURL(requireFromHere.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
}

GlobalWorkerOptions.workerSrc = resolvePdfjsFakeWorkerSrc();

const log = createLogger('pdfjsTextExtractor');
const PDFJS_MAX_INPUT_BYTES = (() => {
    const parsed = Number.parseInt(process.env.EVB_PDFJS_MAX_INPUT_MB ?? '256', 10);
    if (!Number.isFinite(parsed) || parsed < 16) {
        return 256 * 1024 * 1024;
    }
    return parsed * 1024 * 1024;
})();

interface IExtractPdfjsTextOptions {
    signal?: AbortSignal;
    onPageText?: (page: IPageText) => void;
    collectPages?: boolean;
}

export interface IPageTextWithWordBoxes extends IPageText {
    words: IOcrWord[];
    pageWidth: number;
    pageHeight: number;
}

interface IExtractPdfjsWordBoxOptions {
    signal?: AbortSignal;
    onPageText?: (page: IPageTextWithWordBoxes) => void;
    collectPages?: boolean;
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

async function withAbortSignal<T>(
    promise: Promise<T>,
    signal: AbortSignal | undefined,
    onAbort: () => void,
): Promise<T> {
    if (!signal) {
        return promise;
    }

    if (signal.aborted) {
        onAbort();
        throw abortErrorFromSignal(signal);
    }

    return new Promise<T>((resolve, reject) => {
        const handleAbort = () => {
            onAbort();
            reject(abortErrorFromSignal(signal));
        };

        signal.addEventListener('abort', handleAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener('abort', handleAbort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener('abort', handleAbort);
                reject(error);
            },
        );
    });
}

export async function extractTextWithPdfjsWordBoxes(
    pdfPath: string,
    options: IExtractPdfjsWordBoxOptions = {},
): Promise<IPageTextWithWordBoxes[]> {
    const {
        signal,
        onPageText,
        collectPages = !onPageText,
    } = options;
    log.debug(`Extracting pdfjs-dist text geometry: ${pdfPath}`);
    throwIfAborted(signal);

    const fileStat = await stat(pdfPath);
    if (fileStat.size > PDFJS_MAX_INPUT_BYTES) {
        throw new Error(`PDF is too large for pdfjs text geometry extraction (${fileStat.size} bytes)`);
    }

    const data = new Uint8Array(await readFile(pdfPath, signal ? {signal} : undefined));
    throwIfAborted(signal);
    const loadingTask = getDocument({
        data,
        ...createPdfjsNodeDocumentOptions({VerbosityLevel}),
    });
    const doc = await withAbortSignal(loadingTask.promise, signal, () => {
        void loadingTask.destroy();
    });

    try {
        const pages: IPageTextWithWordBoxes[] = [];
        let extractedPageCount = 0;

        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
            throwIfAborted(signal);
            const page = await withAbortSignal(doc.getPage(pageNumber), signal, () => {
                void doc.destroy();
            });
            const pageBox = getPdfjsPageViewBox(page);
            const operatorList = await withAbortSignal(page.getOperatorList(), signal, () => {
                void doc.destroy();
            });
            throwIfAborted(signal);

            const words = extractPdfjsWordBoxesFromOperatorList(
                operatorList,
                pageBox,
                OPS,
                {throwIfAborted: () => throwIfAborted(signal)},
            );
            const pageText = buildOcrTextLayerIndexText(words);
            const pageWithGeometry: IPageTextWithWordBoxes = {
                pageNumber,
                text: pageText,
                words,
                pageWidth: pageBox.pageWidth,
                pageHeight: pageBox.pageHeight,
            };

            extractedPageCount += 1;
            if (collectPages) {
                pages.push(pageWithGeometry);
            }
            onPageText?.(pageWithGeometry);
        }

        log.debug(`Extracted ${extractedPageCount} pages with pdfjs-dist geometry`);
        return pages;
    } finally {
        await doc.destroy();
    }
}

export async function extractTextWithPdfjs(
    pdfPath: string,
    options: IExtractPdfjsTextOptions = {},
): Promise<IPageText[]> {
    const {
        signal,
        onPageText,
        collectPages = !onPageText,
    } = options;
    log.debug(`Extracting text with pdfjs-dist: ${pdfPath}`);
    throwIfAborted(signal);

    const fileStat = await stat(pdfPath);
    if (fileStat.size > PDFJS_MAX_INPUT_BYTES) {
        throw new Error(`PDF is too large for pdfjs text extraction (${fileStat.size} bytes)`);
    }

    const data = new Uint8Array(await readFile(pdfPath, signal ? {signal} : undefined));
    throwIfAborted(signal);
    const loadingTask = getDocument({
        data,
        ...createPdfjsNodeDocumentOptions({VerbosityLevel}),
    });
    const doc = await withAbortSignal(loadingTask.promise, signal, () => {
        void loadingTask.destroy();
    });

    try {
        const pages: IPageText[] = [];
        let extractedPageCount = 0;

        for (let i = 1; i <= doc.numPages; i++) {
            throwIfAborted(signal);
            const page = await withAbortSignal(doc.getPage(i), signal, () => {
                void doc.destroy();
            });
            const content = await withAbortSignal(
                page.getTextContent({
                    includeMarkedContent: true,
                    disableNormalization: true,
                }),
                signal,
                () => {
                    void doc.destroy();
                },
            );
            throwIfAborted(signal);

            const parts: string[] = [];
            for (const item of content.items) {
                throwIfAborted(signal);
                if ('str' in item) {
                    const textItem = item;
                    parts.push(textItem.str);
                    if (textItem.hasEOL) {
                        parts.push('\n');
                    }
                }
            }

            const pageText = {
                pageNumber: i,
                text: collapseRepeatedPdfSearchPageText(parts.join('')),
            };
            extractedPageCount += 1;
            if (collectPages) {
                pages.push(pageText);
            }
            onPageText?.(pageText);
        }

        log.debug(`Extracted ${extractedPageCount} pages with pdfjs-dist`);
        return pages;
    } finally {
        await doc.destroy();
    }
}
