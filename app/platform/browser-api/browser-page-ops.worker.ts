import {
    cropPdfBytes,
    deletePdfPages,
    extractPdfPages,
    getPageGeometryFromPdfBytes,
    insertPdfPages,
    removeCropPdfBytes,
    reorderPdfPages,
    rotatePdfBytes,
} from '@app/platform/browser-api/browser-page-ops-core';
import type {
    IBrowserPageOpsWorkerResultMap,
    TBrowserPageOpsWorkerRequest,
    TBrowserPageOpsWorkerResponse,
} from '@app/platform/browser-api/browser-page-ops-worker.types';
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
    request: TBrowserPageOpsWorkerRequest<'deletePages'>,
) {
    return deletePdfPages(
        request.payload.data,
        request.payload.pages,
    );
}

async function handleExtractRequest(
    request: TBrowserPageOpsWorkerRequest<'extractPages'>,
) {
    return extractPdfPages(
        request.payload.data,
        request.payload.pages,
    );
}

async function handleReorderRequest(
    request: TBrowserPageOpsWorkerRequest<'reorderPages'>,
) {
    return reorderPdfPages(
        request.payload.data,
        request.payload.newOrder,
    );
}

async function handleInsertRequest(
    request: TBrowserPageOpsWorkerRequest<'insertPages'>,
) {
    return insertPdfPages(
        request.payload.data,
        request.payload.insertionData,
        request.payload.afterPage,
    );
}

async function handleRotateRequest(
    request: TBrowserPageOpsWorkerRequest<'rotate'>,
) {
    return rotatePdfBytes(
        request.payload.data,
        request.payload.pages,
        request.payload.angle,
    );
}

async function handleCropRequest(
    request: TBrowserPageOpsWorkerRequest<'crop'>,
) {
    return cropPdfBytes(
        request.payload.data,
        request.payload.pages,
        request.payload.margins,
    );
}

async function handleRemoveCropRequest(
    request: TBrowserPageOpsWorkerRequest<'removeCrop'>,
) {
    return removeCropPdfBytes(
        request.payload.data,
        request.payload.pages,
    );
}

async function handleGetPageGeometryRequest(
    request: TBrowserPageOpsWorkerRequest<'getPageGeometry'>,
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
            return handleDeleteRequest(request as TBrowserPageOpsWorkerRequest<'deletePages'>);
        case 'extractPages':
            return handleExtractRequest(request as TBrowserPageOpsWorkerRequest<'extractPages'>);
        case 'reorderPages':
            return handleReorderRequest(request as TBrowserPageOpsWorkerRequest<'reorderPages'>);
        case 'insertPages':
            return handleInsertRequest(request as TBrowserPageOpsWorkerRequest<'insertPages'>);
        case 'rotate':
            return handleRotateRequest(request as TBrowserPageOpsWorkerRequest<'rotate'>);
        case 'crop':
            return handleCropRequest(request as TBrowserPageOpsWorkerRequest<'crop'>);
        case 'removeCrop':
            return handleRemoveCropRequest(request as TBrowserPageOpsWorkerRequest<'removeCrop'>);
        case 'getPageGeometry':
            return handleGetPageGeometryRequest(request as TBrowserPageOpsWorkerRequest<'getPageGeometry'>);
        default:
            throw new Error(`Unsupported browser page-op worker request: ${String(request.type)}`);
    }
}

self.addEventListener('message', async (event: MessageEvent<TBrowserPageOpsWorkerRequest>) => {
    const request = event.data;

    try {
        const data = await handleRequest(request);
        if (request.type === 'getPageGeometry') {
            const response: TBrowserPageOpsWorkerResponse = {
                id: request.id,
                type: request.type,
                ok: true,
                data: data as IBrowserPageOpsWorkerResultMap['getPageGeometry'],
            };
            self.postMessage(response);
            return;
        }

        const mutationResult = data as IBrowserPageOpsWorkerResultMap['rotate'];
        const transferableData = toTransferableUint8Array(mutationResult.data);
        const response: TBrowserPageOpsWorkerResponse = {
            id: request.id,
            type: request.type,
            ok: true,
            data: {
                ...mutationResult,
                data: transferableData,
            },
        };
        self.postMessage(response, [transferableData.buffer]);
    } catch (error) {
        const response: TBrowserPageOpsWorkerResponse = {
            id: request.id,
            ok: false,
            error: getErrorMessage(error),
        };
        self.postMessage(response);
    }
});
