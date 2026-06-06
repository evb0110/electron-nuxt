import {
    createPdfjsDocumentInitFromBrowserDocument,
    getPdfjsLib,
} from '@app/platform/browser-api/browserPdfjsDocumentInit';
import type { PDFPageProxy } from 'pdfjs-dist';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import { extractBrowserSearchPageText } from '@app/platform/browser-api/extractBrowserSearchPageText';

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
    const pageTexts: string[] = [];
    const pageCount = await iterateBrowserSearchDocumentText(
        pdfPath,
        (pageNumber, text, totalPages) => {
            pageTexts[pageNumber - 1] = text;
            return options.onPageExtracted?.(pageNumber, totalPages);
        },
        options.shouldContinue ? { shouldContinue: options.shouldContinue } : {},
    );

    return {
        pageCount,
        pageTexts,
    };
}

export async function iterateBrowserSearchDocumentText(
    pdfPath: string,
    onPage: (pageNumber: number, text: string, pageCount: number) => Promise<void> | void,
    options: Pick<IExtractBrowserSearchDocumentTextOptions, 'shouldContinue'> = {},
) {
    const document = await loadBrowserSearchDocument(pdfPath);
    try {
        for (let pageNumber = 1; pageNumber <= document.pageCount; pageNumber += 1) {
            if (await options.shouldContinue?.() === false) {
                throw new Error('ERR_BROWSER_SEARCH_CANCELED');
            }
            const page = await document.pdfDocument.getPage(pageNumber);
            const text = await extractBrowserSearchPageText(page);
            await onPage(pageNumber, text, document.pageCount);
            await yieldToBrowser();
        }

        return document.pageCount;
    } finally {
        await document.destroy();
    }
}
