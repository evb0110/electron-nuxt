import * as pdfjsLib from 'pdfjs-dist';
import { createPdfjsDocumentInitFromBrowserDocument } from '@app/platform/browser-api/browserPdfjsDocumentInit';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import { extractBrowserSearchPageText } from '@app/platform/browser-api/extractBrowserSearchPageText';
import type {
    IBrowserSearchWorkerRequest,
    TBrowserSearchWorkerRequest,
    TBrowserSearchWorkerResponse,
} from '@app/platform/browser-api/browserSearchWorker.types';
import { getErrorMessage } from '@app/utils/error';

const canceledRequestIds = new Set<number>();

async function handleExtractDocumentTextRequest(
    request: IBrowserSearchWorkerRequest<'extractDocumentText'>,
) {
    let rejectRangeReadFailure: ((error: Error) => void) | null = null;
    const rangeReadFailure = new Promise<never>((_resolve, reject) => {
        rejectRangeReadFailure = reject;
    });
    const loadingTask = pdfjsLib.getDocument(await createPdfjsDocumentInitFromBrowserDocument(pdfjsLib, request.payload.pdfPath, {onRangeReadFailure: (error) => {
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
    const pageTexts = Array.from({ length: pdfDocument.numPages }, () => '');

    try {
        for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
            if (canceledRequestIds.has(request.id)) {
                throw new Error('ERR_BROWSER_SEARCH_CANCELED');
            }

            const page = await pdfDocument.getPage(pageNumber);
            pageTexts[pageNumber - 1] = await extractBrowserSearchPageText(page);
            const progress = {
                id: request.id,
                type: request.type,
                ok: true,
                progress: {
                    processed: pageNumber,
                    total: pdfDocument.numPages,
                },
            } satisfies TBrowserSearchWorkerResponse;
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

self.addEventListener('message', async (event: MessageEvent<TBrowserSearchWorkerRequest>) => {
    const request = event.data;

    try {
        if (request.type === 'cancel') {
            const data = handleCancelRequest(request);
            const response = {
                id: request.id,
                type: request.type,
                ok: true,
                data,
            } satisfies TBrowserSearchWorkerResponse;
            self.postMessage(response);
            return;
        }

        const data = await handleExtractDocumentTextRequest(request);
        const response = {
            id: request.id,
            type: request.type,
            ok: true,
            data,
        } satisfies TBrowserSearchWorkerResponse;
        self.postMessage(response);
    } catch (error) {
        const response = {
            id: request.id,
            ok: false,
            error: getErrorMessage(error),
        } satisfies TBrowserSearchWorkerResponse;
        self.postMessage(response);
    }
});
