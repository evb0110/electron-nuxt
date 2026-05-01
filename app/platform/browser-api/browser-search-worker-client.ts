import type {
    IBrowserSearchWorkerRequestMap,
    IBrowserSearchWorkerResultMap,
    TBrowserSearchWorkerRequest,
    TBrowserSearchWorkerRequestType,
    TBrowserSearchWorkerResponse,
} from '@app/platform/browser-api/browser-search-worker.types';
import {
    BrowserWorkerClient,
    canUseBrowserWorker,
} from '@app/platform/browser-api/browser-worker-client';
import { getErrorMessage } from '@app/utils/error';

type TPendingWorkerRequest = {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    onProgress?: (progress: {
        processed: number;
        total: number; 
    }) => void;
};

const BROWSER_SEARCH_WORKER_IDLE_TTL_MS = 15_000;

export class BrowserSearchWorkerUnavailableError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'BrowserSearchWorkerUnavailableError';
    }
}

function settleSearchWorkerResponse(
    pendingWorkerRequests: Map<number, TPendingWorkerRequest>,
    result: TBrowserSearchWorkerResponse,
    scheduleIdleWorkerTermination: () => void,
) {
    const pending = pendingWorkerRequests.get(result.id);
    if (!pending) {
        return;
    }

    if ('progress' in result) {
        pending.onProgress?.(result.progress);
        return;
    }

    pendingWorkerRequests.delete(result.id);
    if (result.ok) {
        pending.resolve(result.data);
        scheduleIdleWorkerTermination();
        return;
    }

    pending.reject(new Error(result.error));
    scheduleIdleWorkerTermination();
}

export function canUseBrowserSearchWorker() {
    return canUseBrowserWorker();
}

const browserSearchWorkerClient = new BrowserWorkerClient<
    TBrowserSearchWorkerResponse,
    TPendingWorkerRequest
>({
    idleTtlMs: BROWSER_SEARCH_WORKER_IDLE_TTL_MS,
    createWorker: () => {
        try {
            return new Worker(
                new URL('./browser-search.worker.ts', import.meta.url),
                { type: 'module' },
            );
        } catch (error) {
            throw new BrowserSearchWorkerUnavailableError(
                getErrorMessage(error),
            );
        }
    },
    createError: event => new BrowserSearchWorkerUnavailableError(
        event.error instanceof Error ? event.error.message : event.message,
    ),
    handleMessage: settleSearchWorkerResponse,
});

export async function runBrowserSearchWorkerRequest<K extends TBrowserSearchWorkerRequestType>(
    type: K,
    payload: IBrowserSearchWorkerRequestMap[K],
    options: {onProgress?: (progress: {
        processed: number;
        total: number; 
    }) => void;} = {},
): Promise<IBrowserSearchWorkerResultMap[K]> {
    const request: TBrowserSearchWorkerRequest<K> = {
        id: browserSearchWorkerClient.createRequestId(),
        type,
        payload,
    };

    const worker = browserSearchWorkerClient.getWorker();

    return new Promise<IBrowserSearchWorkerResultMap[K]>((resolve, reject) => {
        browserSearchWorkerClient.clearIdleTerminateTimer();
        browserSearchWorkerClient.pendingRequests.set(request.id, {
            resolve: (value) => resolve(value as IBrowserSearchWorkerResultMap[K]),
            reject,
            onProgress: options.onProgress,
        });

        try {
            worker.postMessage(request);
        } catch (error) {
            browserSearchWorkerClient.pendingRequests.delete(request.id);
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });
}

export function createBrowserSearchWorkerRequest<K extends TBrowserSearchWorkerRequestType>(
    type: K,
    payload: IBrowserSearchWorkerRequestMap[K],
    options: {onProgress?: (progress: {
        processed: number;
        total: number; 
    }) => void;} = {},
) {
    const request: TBrowserSearchWorkerRequest<K> = {
        id: browserSearchWorkerClient.createRequestId(),
        type,
        payload,
    };

    const worker = browserSearchWorkerClient.getWorker();

    const promise = new Promise<IBrowserSearchWorkerResultMap[K]>((resolve, reject) => {
        browserSearchWorkerClient.clearIdleTerminateTimer();
        browserSearchWorkerClient.pendingRequests.set(request.id, {
            resolve: (value) => resolve(value as IBrowserSearchWorkerResultMap[K]),
            reject,
            onProgress: options.onProgress,
        });

        try {
            worker.postMessage(request);
        } catch (error) {
            browserSearchWorkerClient.pendingRequests.delete(request.id);
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });

    return {
        requestId: request.id,
        promise,
    };
}

export async function cancelBrowserSearchWorkerRequest(requestId: number) {
    if (!browserSearchWorkerClient.hasWorker()) {
        return;
    }

    await runBrowserSearchWorkerRequest('cancel', { requestId });
}
