import {
    cropPdfBytes,
    deletePdfPages,
    extractPdfPages,
    getPageGeometryFromPdfBytes,
    insertPdfPages,
    removeCropPdfBytes,
    reorderPdfPages,
    rotatePdfBytes,
} from '@app/platform/browser-api/browserPageOpsCore';
import type {
    IBrowserPageOpsWorkerRequest,
    IBrowserPageOpsWorkerResultMap,
    TBrowserPageOpsWorkerRequest,
    TBrowserPageOpsWorkerResponse,
} from '@app/platform/browser-api/browserPageOpsWorker.types';
import {
    getBrowserPageOpsWorkerRequestId,
    parseBrowserPageOpsWorkerRequest,
} from '@app/platform/browser-api/browserPageOpsWorker.types';
import { getErrorMessage } from '@app/utils/error';

function toTransferableUint8Array(data: Uint8Array) {
    if (
        data.byteOffset === 0
        && data.byteLength === data.buffer.byteLength
    ) {
        return data;
    }

    return data.slice();
}

async function handleDeleteRequest(
    request: IBrowserPageOpsWorkerRequest<'deletePages'>,
) {
    return deletePdfPages(
        request.payload.data,
        request.payload.pages,
    );
}

async function handleExtractRequest(
    request: IBrowserPageOpsWorkerRequest<'extractPages'>,
) {
    return extractPdfPages(
        request.payload.data,
        request.payload.pages,
    );
}

async function handleReorderRequest(
    request: IBrowserPageOpsWorkerRequest<'reorderPages'>,
) {
    return reorderPdfPages(
        request.payload.data,
        request.payload.newOrder,
    );
}

async function handleInsertRequest(
    request: IBrowserPageOpsWorkerRequest<'insertPages'>,
) {
    return insertPdfPages(
        request.payload.data,
        request.payload.insertionData,
        request.payload.afterPage,
    );
}

async function handleRotateRequest(
    request: IBrowserPageOpsWorkerRequest<'rotate'>,
) {
    return rotatePdfBytes(
        request.payload.data,
        request.payload.pages,
        request.payload.angle,
    );
}

async function handleCropRequest(
    request: IBrowserPageOpsWorkerRequest<'crop'>,
) {
    return cropPdfBytes(
        request.payload.data,
        request.payload.pages,
        request.payload.margins,
    );
}

async function handleRemoveCropRequest(
    request: IBrowserPageOpsWorkerRequest<'removeCrop'>,
) {
    return removeCropPdfBytes(
        request.payload.data,
        request.payload.pages,
    );
}

async function handleGetPageGeometryRequest(
    request: IBrowserPageOpsWorkerRequest<'getPageGeometry'>,
) {
    return getPageGeometryFromPdfBytes(
        request.payload.data,
        request.payload.pageNumber,
    );
}

async function handleRequest(
    request: TBrowserPageOpsWorkerRequest,
) {
    switch (request.type) {
        case 'deletePages':
            return handleDeleteRequest(request);
        case 'extractPages':
            return handleExtractRequest(request);
        case 'reorderPages':
            return handleReorderRequest(request);
        case 'insertPages':
            return handleInsertRequest(request);
        case 'rotate':
            return handleRotateRequest(request);
        case 'crop':
            return handleCropRequest(request);
        case 'removeCrop':
            return handleRemoveCropRequest(request);
        case 'getPageGeometry':
            return handleGetPageGeometryRequest(request);
        default:
            throw new Error(`Unsupported browser page operation request: ${(request as {type: string}).type}`);
    }
}

self.addEventListener('message', async (event: MessageEvent<unknown>) => {
    const request = parseBrowserPageOpsWorkerRequest(event.data);
    if (request === null) {
        const id = getBrowserPageOpsWorkerRequestId(event.data);
        if (id !== null) {
            self.postMessage({
                id,
                ok: false,
                error: 'Invalid browser page operation worker request',
            } satisfies TBrowserPageOpsWorkerResponse);
        }
        return;
    }

    try {
        const data = await handleRequest(request);
        if (request.type === 'getPageGeometry') {
            const response = {
                id: request.id,
                type: request.type,
                ok: true,
                data: data as IBrowserPageOpsWorkerResultMap['getPageGeometry'],
            } satisfies TBrowserPageOpsWorkerResponse;
            self.postMessage(response);
            return;
        }

        const mutationResult = data as IBrowserPageOpsWorkerResultMap['rotate'];
        const transferableData = toTransferableUint8Array(mutationResult.data);
        const response = {
            id: request.id,
            type: request.type,
            ok: true,
            data: {
                ...mutationResult,
                data: transferableData,
            },
        } satisfies TBrowserPageOpsWorkerResponse;
        self.postMessage(response, [transferableData.buffer]);
    } catch (error) {
        const response = {
            id: request.id,
            ok: false,
            error: getErrorMessage(error),
        } satisfies TBrowserPageOpsWorkerResponse;
        self.postMessage(response);
    }
});
