import { readFile } from 'fs/promises';
// Must set up DOM stubs before importing pdfjs — the legacy build still
// references DOMMatrix at module evaluation time (canvas rendering code).
import '@electron/search/dom-polyfill';
// Must use the legacy build — the default build uses DOMMatrix and other
// browser-only APIs that don't exist in Node.js worker threads.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createLogger } from '@electron/utils/logger';

const log = createLogger('pdfjs-text-extractor');

interface IPageText {
    pageNumber: number;
    text: string;
}

interface IExtractPdfjsTextOptions {signal?: AbortSignal;}

function createAbortError() {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw createAbortError();
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
        throw createAbortError();
    }

    return new Promise<T>((resolve, reject) => {
        const handleAbort = () => {
            onAbort();
            reject(createAbortError());
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

export async function extractTextWithPdfjs(
    pdfPath: string,
    options: IExtractPdfjsTextOptions = {},
): Promise<IPageText[]> {
    const { signal } = options;
    log.debug(`Extracting text with pdfjs-dist: ${pdfPath}`);
    throwIfAborted(signal);

    const data = new Uint8Array(await readFile(pdfPath));
    throwIfAborted(signal);
    const loadingTask = getDocument({
        data,
        isEvalSupported: false,
    });
    const doc = await withAbortSignal(loadingTask.promise, signal, () => {
        void loadingTask.destroy();
    });

    try {
        const pages: IPageText[] = [];

        for (let i = 1; i <= doc.numPages; i++) {
            throwIfAborted(signal);
            const page = await withAbortSignal(doc.getPage(i), signal, () => {
                void doc.destroy();
            });
            const content = await withAbortSignal(
                page.getTextContent({disableNormalization: true}),
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

            pages.push({
                pageNumber: i,
                text: parts.join(''),
            });
        }

        log.debug(`Extracted ${pages.length} pages with pdfjs-dist`);
        return pages;
    } finally {
        await doc.destroy();
    }
}
