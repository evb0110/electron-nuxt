import type {
    IBrowserPageOpsWorkerRequest,
    IBrowserPageOpsWorkerRequestMap,
    IBrowserPageOpsWorkerResultMap,
    IPageMutationWorkerResult,
    TBrowserPageOpsWorkerRequest,
    TBrowserPageOpsWorkerRequestType,
} from '@app/platform/browser-api/browserPageOpsWorker.types';
import type {
    IPageGeometry,
    IPdfBox,
} from '@contracts/shared';
import {
    isFiniteNumber,
    isRecord,
} from '@contracts/runtimeGuards';
import { toTransferableUint8Array } from '@app/platform/browser-api/toTransferableUint8Array';
import { settleBrowserWorkerResult } from '@app/platform/browser-api/settleBrowserWorkerResult';
import type { IPendingBrowserWorkerRequest } from '@app/platform/browser-api/settleBrowserWorkerResult';
import {
    BrowserWorkerClient,
    canUseBrowserWorker,
} from '@app/platform/browser-api/browserWorkerClient';
import { getErrorMessage } from '@app/utils/error';

const BROWSER_PAGE_OPS_WORKER_IDLE_TTL_MS = 15_000;
const BROWSER_PAGE_OPS_WORKER_REQUEST_TIMEOUT_MS = 90_000;

export class BrowserPageOpsWorkerUnavailableError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'BrowserPageOpsWorkerUnavailableError';
    }
}

function buildWorkerRequestWithTransfers(
    request: TBrowserPageOpsWorkerRequest,
) {
    if (request.type === 'insertPages') {
        const transferableData = toTransferableUint8Array(request.payload.data);
        const transferableInsertionData = toTransferableUint8Array(request.payload.insertionData);
        return {
            request: {
                ...request,
                payload: {
                    ...request.payload,
                    data: transferableData,
                    insertionData: transferableInsertionData,
                },
            },
            transfer: [
                transferableData.buffer,
                transferableInsertionData.buffer,
            ] satisfies Transferable[],
        };
    }

    const transferableData = toTransferableUint8Array(request.payload.data);
    return {
        request: {
            ...request,
            payload: {
                ...request.payload,
                data: transferableData,
            },
        },
        transfer: [transferableData.buffer] satisfies Transferable[],
    };
}


function decodePageMutationWorkerResult(data: unknown): IPageMutationWorkerResult | null {
    if (
        !isRecord(data)
        || !(data.data instanceof Uint8Array)
        || typeof data.pageCount !== 'number'
        || !Number.isInteger(data.pageCount)
        || data.pageCount < 1
    ) {
        return null;
    }

    return {
        data: data.data,
        pageCount: data.pageCount,
    };
}

function decodePdfBox(value: unknown): IPdfBox | null {
    if (!isRecord(value)) {
        return null;
    }
    if (
        !isFiniteNumber(value.x)
        || !isFiniteNumber(value.y)
        || !isFiniteNumber(value.width)
        || !isFiniteNumber(value.height)
    ) {
        return null;
    }
    return {
        x: value.x,
        y: value.y,
        width: value.width,
        height: value.height,
    };
}

function decodePageGeometry(data: unknown): IPageGeometry | null {
    if (!isRecord(data) || !isFiniteNumber(data.rotation)) {
        return null;
    }

    const mediaBox = decodePdfBox(data.mediaBox);
    if (!mediaBox) {
        return null;
    }

    const cropBox = data.cropBox === null
        ? null
        : decodePdfBox(data.cropBox);
    if (cropBox === null && data.cropBox !== null) {
        return null;
    }

    return {
        mediaBox,
        cropBox,
        rotation: data.rotation,
    };
}

function decodePageOpsWorkerResult<K extends TBrowserPageOpsWorkerRequestType>(
    type: K,
    data: unknown,
): IBrowserPageOpsWorkerResultMap[K] | null {
    if (type === 'getPageGeometry') {
        return decodePageGeometry(data) as IBrowserPageOpsWorkerResultMap[K] | null;
    }

    return decodePageMutationWorkerResult(data) as IBrowserPageOpsWorkerResultMap[K] | null;
}

export function canUseBrowserPageOpsWorker() {
    return canUseBrowserWorker();
}

const browserPageOpsWorkerClient = new BrowserWorkerClient<IPendingBrowserWorkerRequest>({
    idleTtlMs: BROWSER_PAGE_OPS_WORKER_IDLE_TTL_MS,
    requestTimeoutMs: BROWSER_PAGE_OPS_WORKER_REQUEST_TIMEOUT_MS,
    createWorker: () => {
        try {
            return new Worker(
                new URL('./browserPageOps.worker.ts', import.meta.url),
                { type: 'module' },
            );
        } catch (error) {
            throw new BrowserPageOpsWorkerUnavailableError(
                getErrorMessage(error),
            );
        }
    },
    createError: event => new BrowserPageOpsWorkerUnavailableError(
        event.error instanceof Error ? event.error.message : event.message,
    ),
    handleMessage: settleBrowserWorkerResult,
});

export async function runBrowserPageOpsWorkerRequest<K extends TBrowserPageOpsWorkerRequestType>(
    type: K,
    payload: IBrowserPageOpsWorkerRequestMap[K],
): Promise<IBrowserPageOpsWorkerResultMap[K]> {
    const request: IBrowserPageOpsWorkerRequest<K> = {
        id: browserPageOpsWorkerClient.createRequestId(),
        type,
        payload,
    };

    const worker = browserPageOpsWorkerClient.getWorker();

    return new Promise<IBrowserPageOpsWorkerResultMap[K]>((resolve, reject) => {
        browserPageOpsWorkerClient.registerPendingRequest(request.id, {
            requestType: type,
            resolveData: (value) => {
                const decoded = decodePageOpsWorkerResult(type, value);
                if (!decoded) {
                    return false;
                }
                resolve(decoded);
                return true;
            },
            reject,
        }, () => new BrowserPageOpsWorkerUnavailableError(
            `Browser page operation worker request timed out after ${BROWSER_PAGE_OPS_WORKER_REQUEST_TIMEOUT_MS}ms`,
        ));

        try {
            const workerRequest = buildWorkerRequestWithTransfers(request as TBrowserPageOpsWorkerRequest);
            worker.postMessage(workerRequest.request, workerRequest.transfer);
        } catch (error) {
            browserPageOpsWorkerClient.cancelPendingRequest(
                request.id,
                error instanceof Error ? error : new Error(String(error)),
            );
        }
    });
}
