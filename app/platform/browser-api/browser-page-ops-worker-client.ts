import type {
    IBrowserPageOpsWorkerRequestMap,
    IBrowserPageOpsWorkerResultMap,
    TBrowserPageOpsWorkerRequest,
    TBrowserPageOpsWorkerRequestType,
    TBrowserPageOpsWorkerResponse,
} from '@app/platform/browser-api/browser-page-ops-worker.types';
import { toTransferableUint8Array } from '@app/platform/browser-api/browser-worker-transfer';
import {
    settleBrowserWorkerResult,
    type TPendingBrowserWorkerRequest,
} from '@app/platform/browser-api/browser-worker-requests';
import {
    BrowserWorkerClient,
    canUseBrowserWorker,
} from '@app/platform/browser-api/browser-worker-client';
import { getErrorMessage } from '@app/utils/error';

type TAnyBrowserPageOpsWorkerRequest = {
    [K in TBrowserPageOpsWorkerRequestType]: TBrowserPageOpsWorkerRequest<K>;
}[TBrowserPageOpsWorkerRequestType];

const BROWSER_PAGE_OPS_WORKER_IDLE_TTL_MS = 15_000;

export class BrowserPageOpsWorkerUnavailableError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'BrowserPageOpsWorkerUnavailableError';
    }
}

function buildWorkerRequestWithTransfers(
    request: TAnyBrowserPageOpsWorkerRequest,
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
    TPendingBrowserWorkerRequest
>({
    idleTtlMs: BROWSER_PAGE_OPS_WORKER_IDLE_TTL_MS,
    createWorker: () => {
        try {
            return new Worker(
                new URL('./browser-page-ops.worker.ts', import.meta.url),
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
    const request: TBrowserPageOpsWorkerRequest<K> = {
        id: browserPageOpsWorkerClient.createRequestId(),
        type,
        payload,
    };

    const worker = browserPageOpsWorkerClient.getWorker();

    return new Promise<IBrowserPageOpsWorkerResultMap[K]>((resolve, reject) => {
        browserPageOpsWorkerClient.clearIdleTerminateTimer();
        browserPageOpsWorkerClient.pendingRequests.set(request.id, {
            resolve: (value) => resolve(value as IBrowserPageOpsWorkerResultMap[K]),
            reject,
        });

        try {
            const workerRequest = buildWorkerRequestWithTransfers(request as TAnyBrowserPageOpsWorkerRequest);
            worker.postMessage(workerRequest.request, workerRequest.transfer);
        } catch (error) {
            browserPageOpsWorkerClient.pendingRequests.delete(request.id);
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });
}
