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
import { getErrorMessage } from '@app/utils/error';

type TAnyBrowserPageOpsWorkerRequest = {
    [K in TBrowserPageOpsWorkerRequestType]: TBrowserPageOpsWorkerRequest<K>;
}[TBrowserPageOpsWorkerRequestType];

const pendingWorkerRequests = new Map<number, TPendingBrowserWorkerRequest>();
const BROWSER_PAGE_OPS_WORKER_IDLE_TTL_MS = 15_000;

let browserPageOpsWorker: Worker | null = null;
let nextRequestId = 1;
let idleTerminateTimer: ReturnType<typeof setTimeout> | null = null;
let cleanupListenersRegistered = false;

export class BrowserPageOpsWorkerUnavailableError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'BrowserPageOpsWorkerUnavailableError';
    }
}

function clearIdleTerminateTimer() {
    if (!idleTerminateTimer) {
        return;
    }

    clearTimeout(idleTerminateTimer);
    idleTerminateTimer = null;
}

function scheduleIdleWorkerTermination() {
    clearIdleTerminateTimer();
    if (!browserPageOpsWorker || pendingWorkerRequests.size > 0) {
        return;
    }

    idleTerminateTimer = setTimeout(() => {
        idleTerminateTimer = null;
        if (!browserPageOpsWorker || pendingWorkerRequests.size > 0) {
            return;
        }

        resetWorker();
    }, BROWSER_PAGE_OPS_WORKER_IDLE_TTL_MS);
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

function resetWorker(error?: Error) {
    const pending = Array.from(pendingWorkerRequests.values());
    pendingWorkerRequests.clear();
    clearIdleTerminateTimer();

    if (browserPageOpsWorker) {
        browserPageOpsWorker.removeEventListener('message', handleWorkerMessage);
        browserPageOpsWorker.removeEventListener('error', handleWorkerError);
        browserPageOpsWorker.terminate();
        browserPageOpsWorker = null;
    }

    if (error) {
        pending.forEach((request) => request.reject(error));
    }
}

function handleWorkerMessage(
    event: MessageEvent<TBrowserPageOpsWorkerResponse>,
) {
    settleBrowserWorkerResult(pendingWorkerRequests, event.data, scheduleIdleWorkerTermination);
}

function handleWorkerError(event: ErrorEvent) {
    resetWorker(new BrowserPageOpsWorkerUnavailableError(
        event.error instanceof Error ? event.error.message : event.message,
    ));
}

export function canUseBrowserPageOpsWorker() {
    return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}

function registerCleanupListeners() {
    if (
        cleanupListenersRegistered
        || typeof window === 'undefined'
        || typeof window.addEventListener !== 'function'
    ) {
        return;
    }

    cleanupListenersRegistered = true;
    window.addEventListener('beforeunload', () => {
        resetWorker();
    });
}

function getBrowserPageOpsWorker() {
    if (browserPageOpsWorker) {
        clearIdleTerminateTimer();
        return browserPageOpsWorker;
    }

    let worker: Worker;
    try {
        worker = new Worker(
            new URL('./browser-page-ops.worker.ts', import.meta.url),
            { type: 'module' },
        );
    } catch (error) {
        throw new BrowserPageOpsWorkerUnavailableError(
            getErrorMessage(error),
        );
    }

    worker.addEventListener('message', handleWorkerMessage);
    worker.addEventListener('error', handleWorkerError);
    registerCleanupListeners();
    browserPageOpsWorker = worker;
    return worker;
}

export async function runBrowserPageOpsWorkerRequest<K extends TBrowserPageOpsWorkerRequestType>(
    type: K,
    payload: IBrowserPageOpsWorkerRequestMap[K],
): Promise<IBrowserPageOpsWorkerResultMap[K]> {
    const request: TBrowserPageOpsWorkerRequest<K> = {
        id: nextRequestId,
        type,
        payload,
    };
    nextRequestId += 1;

    const worker = getBrowserPageOpsWorker();

    return new Promise<IBrowserPageOpsWorkerResultMap[K]>((resolve, reject) => {
        clearIdleTerminateTimer();
        pendingWorkerRequests.set(request.id, {
            resolve: (value) => resolve(value as IBrowserPageOpsWorkerResultMap[K]),
            reject,
        });

        try {
            const workerRequest = buildWorkerRequestWithTransfers(request as TAnyBrowserPageOpsWorkerRequest);
            worker.postMessage(workerRequest.request, workerRequest.transfer);
        } catch (error) {
            pendingWorkerRequests.delete(request.id);
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });
}
