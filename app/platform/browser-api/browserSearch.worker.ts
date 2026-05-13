import * as pdfjsLib from 'pdfjs-dist';
import { createPdfjsDocumentInitFromBrowserDocument } from '@app/platform/browser-api/common';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import { extractBrowserSearchPageText } from '@app/platform/browser-api/browserSearchText';
import type {
    IBrowserSearchWorkerRequest,
    TBrowserSearchWorkerResponse,
} from '@app/platform/browser-api/browserSearchWorker.types';
import { getErrorMessage } from '@app/utils/error';

const canceledRequestIds = new Set<number>();


async function handleExtractDocumentTextRequest(
    request: IBrowserSearchWorkerRequest<'extractDocumentText'>,
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
    request: IBrowserSearchWorkerRequest<'cancel'>,
) {
    canceledRequestIds.add(request.payload.requestId);
    return { canceled: true };
}

self.addEventListener('message', async (event: MessageEvent<IBrowserSearchWorkerRequest>) => {
    const request = event.data;

    try {
        if (request.type === 'cancel') {
            const data = handleCancelRequest(
                request as IBrowserSearchWorkerRequest<'cancel'>,
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
            request as IBrowserSearchWorkerRequest<'extractDocumentText'>,
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
