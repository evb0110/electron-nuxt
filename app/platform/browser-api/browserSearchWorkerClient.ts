import type {
    IBrowserSearchWorkerRequestMap,
    IBrowserSearchWorkerResultMap,
    IBrowserSearchWorkerRequest,
    TBrowserSearchWorkerRequestType,
    TBrowserSearchWorkerResponse,
} from '@app/platform/browser-api/browserSearchWorker.types';
import {
    BrowserWorkerClient,
    canUseBrowserWorker,
} from '@app/platform/browser-api/browserWorkerClient';
import { getErrorMessage } from '@app/utils/error';

interface IPendingWorkerRequest {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeoutTimer?: ReturnType<typeof setTimeout> | null;
    onProgress?: TBrowserSearchWorkerProgressHandler;
}

type TBrowserSearchWorkerProgressHandler = (progress: {
    processed: number;
    total: number;
}) => void;

const BROWSER_SEARCH_WORKER_IDLE_TTL_MS = 15_000;
const BROWSER_SEARCH_WORKER_REQUEST_TIMEOUT_MS = 60_000;

export class BrowserSearchWorkerUnavailableError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'BrowserSearchWorkerUnavailableError';
    }
}

class BrowserSearchWorkerRequestError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'BrowserSearchWorkerRequestError';
    }
}

function settleSearchWorkerResponse(
    pendingWorkerRequests: Map<number, IPendingWorkerRequest>,
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

    const timeoutTimer = pending.timeoutTimer;
    pendingWorkerRequests.delete(result.id);
    if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        pending.timeoutTimer = null;
    }
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
    IPendingWorkerRequest
>({
    idleTtlMs: BROWSER_SEARCH_WORKER_IDLE_TTL_MS,
    requestTimeoutMs: BROWSER_SEARCH_WORKER_REQUEST_TIMEOUT_MS,
    createWorker: () => {
        try {
            return new Worker(
                new URL('./browserSearch.worker.ts', import.meta.url),
                { type: 'module' },
            );
        } catch (error) {
            throw new BrowserSearchWorkerUnavailableError(
                getErrorMessage(error),
            );
        }
    },
    createError: event => new BrowserSearchWorkerRequestError(
        event.error instanceof Error ? event.error.message : event.message,
    ),
    handleMessage: settleSearchWorkerResponse,
});

function postBrowserSearchWorkerRequest<K extends TBrowserSearchWorkerRequestType>(
    type: K,
    payload: IBrowserSearchWorkerRequestMap[K],
    onProgress?: TBrowserSearchWorkerProgressHandler,
): {
    requestId: number;
    promise: Promise<IBrowserSearchWorkerResultMap[K]>;
} {
    const request: IBrowserSearchWorkerRequest<K> = {
        id: browserSearchWorkerClient.createRequestId(),
        type,
        payload,
    };

    const worker = browserSearchWorkerClient.getWorker();

    const promise: Promise<IBrowserSearchWorkerResultMap[K]> =
        new Promise<IBrowserSearchWorkerResultMap[K]>((resolve, reject) => {
            browserSearchWorkerClient.registerPendingRequest(request.id, {
                resolve: (value) => resolve(value as IBrowserSearchWorkerResultMap[K]),
                reject,
                ...(onProgress ? { onProgress } : {}),
            }, () => new BrowserSearchWorkerRequestError(
                `Browser search worker request timed out after ${BROWSER_SEARCH_WORKER_REQUEST_TIMEOUT_MS}ms`,
            ));

            try {
                worker.postMessage(request);
            } catch (error) {
                browserSearchWorkerClient.cancelPendingRequest(
                    request.id,
                    new BrowserSearchWorkerRequestError(getErrorMessage(error)),
                );
            }
        });

    return {
        requestId: request.id,
        promise,
    };
}

export function runBrowserSearchWorkerRequest<K extends TBrowserSearchWorkerRequestType>(
    type: K,
    payload: IBrowserSearchWorkerRequestMap[K],
    options: {onProgress?: TBrowserSearchWorkerProgressHandler} = {},
): Promise<IBrowserSearchWorkerResultMap[K]> {
    return postBrowserSearchWorkerRequest(type, payload, options.onProgress).promise;
}

export function createBrowserSearchWorkerRequest<K extends TBrowserSearchWorkerRequestType>(
    type: K,
    payload: IBrowserSearchWorkerRequestMap[K],
    options: {onProgress?: TBrowserSearchWorkerProgressHandler} = {},
) {
    return postBrowserSearchWorkerRequest(type, payload, options.onProgress);
}

export function cancelBrowserSearchWorkerRequest(requestId: number) {
    if (!browserSearchWorkerClient.hasWorker()) {
        return;
    }

    browserSearchWorkerClient.cancelPendingRequest(
        requestId,
        new Error('ERR_BROWSER_SEARCH_CANCELED'),
        { resetWorker: true },
    );
}
