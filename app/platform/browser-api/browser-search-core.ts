import {
    createPdfjsDocumentInitFromBrowserDocument,
    getPdfjsLib,
} from '@app/platform/browser-api/common';
import type { PDFPageProxy } from 'pdfjs-dist';
import { yieldToBrowser } from '@app/platform/browser-api/browser-yield';
import { extractBrowserSearchPageText } from '@app/platform/browser-api/browser-search-text';

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
