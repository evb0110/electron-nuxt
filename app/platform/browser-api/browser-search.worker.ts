import type { PDFPageProxy } from 'pdfjs-dist';
import * as pdfjsLib from 'pdfjs-dist';
import { createPdfjsDocumentInitFromBrowserDocument } from '@app/platform/browser-api/common';
import { yieldToBrowser } from '@app/platform/browser-api/browser-yield';
import type {
    TBrowserSearchWorkerRequest,
    TBrowserSearchWorkerResponse,
} from '@app/platform/browser-api/browser-search-worker.types';
import { getErrorMessage } from '@app/utils/error';

const canceledRequestIds = new Set<number>();

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

async function handleExtractDocumentTextRequest(
    request: TBrowserSearchWorkerRequest<'extractDocumentText'>,
) {
    const loadingTask = pdfjsLib.getDocument(
        await createPdfjsDocumentInitFromBrowserDocument(pdfjsLib, request.payload.pdfPath),
    );
    const pdfDocument = await loadingTask.promise;
    const pageTexts = Array.from({ length: pdfDocument.numPages }, () => '');

    try {
        for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
            if (canceledRequestIds.has(request.id)) {
                throw new Error('ERR_BROWSER_SEARCH_CANCELED');
            }

            const page = await pdfDocument.getPage(pageNumber);
            pageTexts[pageNumber - 1] = await extractBrowserSearchPageText(page);
            const progress: TBrowserSearchWorkerResponse = {
                id: request.id,
                type: request.type,
                ok: true,
                progress: {
                    processed: pageNumber,
                    total: pdfDocument.numPages,
                },
            };
            self.postMessage(progress);
            await yieldToBrowser();
        }

        return {
            pageCount: pdfDocument.numPages,
            pageTexts,
        };
    } finally {
        canceledRequestIds.delete(request.id);
        await pdfDocument.destroy();
    }
}

function handleCancelRequest(
    request: TBrowserSearchWorkerRequest<'cancel'>,
) {
    canceledRequestIds.add(request.payload.requestId);
    return { canceled: true };
}

self.addEventListener('message', async (event: MessageEvent<TBrowserSearchWorkerRequest>) => {
    const request = event.data;

    try {
        if (request.type === 'cancel') {
            const data = handleCancelRequest(
                request as TBrowserSearchWorkerRequest<'cancel'>,
            );
            const response: TBrowserSearchWorkerResponse = {
                id: request.id,
                type: request.type,
                ok: true,
                data,
            };
            self.postMessage(response);
            return;
        }

        const data = await handleExtractDocumentTextRequest(
            request as TBrowserSearchWorkerRequest<'extractDocumentText'>,
        );
        const response: TBrowserSearchWorkerResponse = {
            id: request.id,
            type: request.type,
            ok: true,
            data,
        };
        self.postMessage(response);
    } catch (error) {
        const response: TBrowserSearchWorkerResponse = {
            id: request.id,
            ok: false,
            error: getErrorMessage(error),
        };
        self.postMessage(response);
    }
});
