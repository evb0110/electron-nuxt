import {
    createPdfjsDocumentInitFromBrowserDocument,
    getPdfjsLib,
} from '@app/platform/browser-api/browserPdfjsDocumentInit';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { TPdfjsTextOps } from '@pdf-core/pdfjsTextGeometry';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import { extractBrowserSearchPageData } from '@app/platform/browser-api/extractBrowserSearchPageText';
import type { IBrowserSearchPageData } from '@app/platform/browser-api/extractBrowserSearchPageText';

interface ILoadedBrowserSearchDocument {
    pdfDocument: {
        numPages: number;
        getPage: (pageNumber: number) => Promise<PDFPageProxy>;
        destroy: () => Promise<void>;
    };
    pdfjsOps: TPdfjsTextOps;
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

export interface IExtractedBrowserSearchPage extends IBrowserSearchPageData {pageNumber: number;}

async function throwIfBrowserSearchCanceled(shouldContinue?: IExtractBrowserSearchDocumentTextOptions['shouldContinue']) {
    if (await shouldContinue?.() === false) {
        throw new Error('ERR_BROWSER_SEARCH_CANCELED');
    }
}

async function loadBrowserSearchDocument(
    pdfPath: string,
): Promise<ILoadedBrowserSearchDocument> {
    const pdfjsLib = await getPdfjsLib();
    let rejectRangeReadFailure: ((error: Error) => void) | null = null;
    const rangeReadFailure = new Promise<never>((_resolve, reject) => {
        rejectRangeReadFailure = reject;
    });
    const loadingTask = pdfjsLib.getDocument(await createPdfjsDocumentInitFromBrowserDocument(pdfjsLib, pdfPath, {onRangeReadFailure: (error) => {
        const reject = rejectRangeReadFailure;
        rejectRangeReadFailure = null;
        reject?.(error);
    }}));
    let pdfDocument: Awaited<typeof loadingTask.promise>;
    try {
        pdfDocument = await Promise.race([
            loadingTask.promise,
            rangeReadFailure,
        ]);
    } catch (error) {
        await loadingTask.destroy();
        throw error;
    } finally {
        rejectRangeReadFailure = null;
    }

    return {
        pdfDocument,
        pdfjsOps: pdfjsLib.OPS,
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

async function iterateBrowserSearchDocumentText(
    pdfPath: string,
    onPage: (pageNumber: number, text: string, pageCount: number) => Promise<void> | void,
    options: Pick<IExtractBrowserSearchDocumentTextOptions, 'shouldContinue'> = {},
) {
    return iterateBrowserSearchDocumentPages(
        pdfPath,
        (page, pageCount) => onPage(page.pageNumber, page.text, pageCount),
        options,
    );
}

export async function iterateBrowserSearchDocumentPages(
    pdfPath: string,
    onPage: (page: IExtractedBrowserSearchPage, pageCount: number) => Promise<void> | void,
    options: Pick<IExtractBrowserSearchDocumentTextOptions, 'shouldContinue'> = {},
) {
    const document = await loadBrowserSearchDocument(pdfPath);
    try {
        for (let pageNumber = 1; pageNumber <= document.pageCount; pageNumber += 1) {
            await throwIfBrowserSearchCanceled(options.shouldContinue);
            const page = await document.pdfDocument.getPage(pageNumber);
            await throwIfBrowserSearchCanceled(options.shouldContinue);
            const pageData = await extractBrowserSearchPageData(
                page,
                document.pdfjsOps,
                options.shouldContinue ? { shouldContinue: options.shouldContinue } : {},
            );
            await throwIfBrowserSearchCanceled(options.shouldContinue);
            await onPage({
                pageNumber,
                ...pageData,
            }, document.pageCount);
            await yieldToBrowser();
            await throwIfBrowserSearchCanceled(options.shouldContinue);
        }

        return document.pageCount;
    } finally {
        await document.destroy();
    }
}
