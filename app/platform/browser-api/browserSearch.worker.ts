import * as pdfjsLib from 'pdfjs-dist';
import { createPdfjsDocumentInitFromBrowserDocument } from '@app/platform/browser-api/browserPdfjsDocumentInit';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import { extractBrowserSearchPageText } from '@app/platform/browser-api/extractBrowserSearchPageText';
import type {
    IBrowserSearchWorkerRequest,
    TBrowserSearchWorkerResponse,
} from '@app/platform/browser-api/browserSearchWorker.types';
import {
    getBrowserSearchWorkerRequestId,
    parseBrowserSearchWorkerRequest,
} from '@app/platform/browser-api/browserSearchWorker.types';
import { getErrorMessage } from '@app/utils/error';

const canceledRequestIds = new Set<number>();
const activeLoadCancellers = new Map<number, (error: Error) => void>();

async function handleExtractDocumentTextRequest(
    request: IBrowserSearchWorkerRequest<'extractDocumentText'>,
) {
    let rejectRangeReadFailure: ((error: Error) => void) | null = null;
    const rangeReadFailure = new Promise<never>((_resolve, reject) => {
        rejectRangeReadFailure = reject;
    });
    let cancelLoad: ((error: Error) => void) | null = null;
    const loadCancellation = new Promise<never>((_resolve, reject) => {
        cancelLoad = reject;
    });
    // A cancel that arrives while the document is still loading must abort the
    // load itself; the page loop below only observes cancellation once loading
    // has resolved, which for a large ranged PDF can keep range reads alive.
    activeLoadCancellers.set(request.id, (error) => cancelLoad?.(error));
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
            loadCancellation,
        ]);
    } catch (error) {
        await loadingTask.destroy();
        canceledRequestIds.delete(request.id);
        throw error;
    } finally {
        rejectRangeReadFailure = null;
        cancelLoad = null;
        activeLoadCancellers.delete(request.id);
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
    const { requestId } = request.payload;
    canceledRequestIds.add(requestId);
    activeLoadCancellers.get(requestId)?.(new Error('ERR_BROWSER_SEARCH_CANCELED'));
    return { canceled: true };
}

self.addEventListener('message', async (event: MessageEvent<unknown>) => {
    const request = parseBrowserSearchWorkerRequest(event.data);
    if (request === null) {
        const id = getBrowserSearchWorkerRequestId(event.data);
        if (id !== null) {
            self.postMessage({
                id,
                ok: false,
                error: 'Invalid browser search worker request',
            } satisfies TBrowserSearchWorkerResponse);
        }
        return;
    }

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
