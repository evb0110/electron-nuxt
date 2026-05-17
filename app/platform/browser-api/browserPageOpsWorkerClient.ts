import type {
    IBrowserPageOpsWorkerRequestMap,
    IBrowserPageOpsWorkerResultMap,
    IBrowserPageOpsWorkerRequest,
    TBrowserPageOpsWorkerRequest,
    TBrowserPageOpsWorkerRequestType,
    TBrowserPageOpsWorkerResponse,
} from '@app/platform/browser-api/browserPageOpsWorker.types';
import { toTransferableUint8Array } from '@app/platform/browser-api/browserWorkerTransfer';
import {
    settleBrowserWorkerResult,
    type IPendingBrowserWorkerRequest,
} from '@app/platform/browser-api/browserWorkerRequests';
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

export function canUseBrowserPageOpsWorker() {
    return canUseBrowserWorker();
}

const browserPageOpsWorkerClient = new BrowserWorkerClient<
    TBrowserPageOpsWorkerResponse,
    IPendingBrowserWorkerRequest
>({
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
            resolve: (value) => resolve(value as IBrowserPageOpsWorkerResultMap[K]),
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
