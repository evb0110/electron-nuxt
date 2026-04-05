import type { PDFPageProxy } from 'pdfjs-dist';
import {
    createPdfjsDocumentInitFromBrowserDocument,
    getPdfjsLib,
} from '@app/platform/browser-api/common';
import { yieldToBrowser } from '@app/platform/browser-api/browser-yield';

interface ILoadedBrowserSearchDocument {
    pdfDocument: {
        numPages: number;
        getPage: (pageNumber: number) => Promise<PDFPageProxy>;
        destroy: () => Promise<void>;
    };
    pageCount: number;
    destroy: () => Promise<void>;
}

interface IExtractBrowserSearchDocumentTextOptions {
    onPageExtracted?: (pageNumber: number, pageCount: number) => Promise<void> | void;
    shouldContinue?: () => Promise<boolean> | boolean;
}

interface IExtractedBrowserSearchDocumentText {
    pageCount: number;
    pageTexts: string[];
}

async function extractBrowserSearchPageText(page: {
    getTextContent: PDFPageProxy['getTextContent'];
    cleanup?: PDFPageProxy['cleanup'];
}) {
    const content = await page.getTextContent();
    const textChunks: string[] = [];

    for (let index = 0; index < content.items.length; index += 128) {
        const chunk = content.items.slice(index, index + 128);
        const normalizedChunk = chunk
            .map((item) => ('str' in item ? String(item.str ?? '') : ''))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (normalizedChunk) {
            textChunks.push(normalizedChunk);
        }

        if (index + 128 < content.items.length) {
            await yieldToBrowser();
        }
    }

    const text = textChunks.join(' ').trim();

    try {
        await Promise.resolve(page.cleanup?.());
    } catch {
        // Page cleanup is a best-effort memory hint.
    }

    return text;
}

async function loadBrowserSearchDocument(
    pdfPath: string,
): Promise<ILoadedBrowserSearchDocument> {
    const pdfjsLib = await getPdfjsLib();
    const loadingTask = pdfjsLib.getDocument(
        await createPdfjsDocumentInitFromBrowserDocument(pdfjsLib, pdfPath),
    );
    const pdfDocument = await loadingTask.promise;

    return {
        pdfDocument,
        pageCount: pdfDocument.numPages,
        destroy: async () => {
            await pdfDocument.destroy();
        },
    };
}

export async function extractBrowserSearchDocumentText(
    pdfPath: string,
    options: IExtractBrowserSearchDocumentTextOptions = {},
): Promise<IExtractedBrowserSearchDocumentText> {
    const document = await loadBrowserSearchDocument(pdfPath);
    const pageTexts = Array.from({ length: document.pageCount }, () => '');

    try {
        for (let pageNumber = 1; pageNumber <= document.pageCount; pageNumber += 1) {
            if (await options.shouldContinue?.() === false) {
                throw new Error('ERR_BROWSER_SEARCH_CANCELED');
            }
            const page = await document.pdfDocument.getPage(pageNumber);
            pageTexts[pageNumber - 1] = await extractBrowserSearchPageText(page);
            await options.onPageExtracted?.(pageNumber, document.pageCount);
            await yieldToBrowser();
        }

        return {
            pageCount: document.pageCount,
            pageTexts,
        };
    } finally {
        await document.destroy();
    }
}
