import type {
    IBrowserSearchWorkerRequestMap,
    IBrowserSearchWorkerResultMap,
    TBrowserSearchWorkerRequest,
    TBrowserSearchWorkerRequestType,
    TBrowserSearchWorkerResponse,
} from '@app/platform/browser-api/browser-search-worker.types';

type TPendingWorkerRequest = {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    onProgress?: (progress: {
        processed: number;
        total: number; 
    }) => void;
};

const pendingWorkerRequests = new Map<number, TPendingWorkerRequest>();
const BROWSER_SEARCH_WORKER_IDLE_TTL_MS = 15_000;

let browserSearchWorker: Worker | null = null;
let nextRequestId = 1;
let idleTerminateTimer: ReturnType<typeof setTimeout> | null = null;
let cleanupListenersRegistered = false;

export class BrowserSearchWorkerUnavailableError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'BrowserSearchWorkerUnavailableError';
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
    if (!browserSearchWorker || pendingWorkerRequests.size > 0) {
        return;
    }

    idleTerminateTimer = setTimeout(() => {
        idleTerminateTimer = null;
        if (!browserSearchWorker || pendingWorkerRequests.size > 0) {
            return;
        }

        resetWorker();
    }, BROWSER_SEARCH_WORKER_IDLE_TTL_MS);
}

function resetWorker(error?: Error) {
    const pending = Array.from(pendingWorkerRequests.values());
    pendingWorkerRequests.clear();
    clearIdleTerminateTimer();

    if (browserSearchWorker) {
        browserSearchWorker.removeEventListener('message', handleWorkerMessage);
        browserSearchWorker.removeEventListener('error', handleWorkerError);
        browserSearchWorker.terminate();
        browserSearchWorker = null;
    }

    if (error) {
        pending.forEach((request) => request.reject(error));
    }
}

function handleWorkerMessage(
    event: MessageEvent<TBrowserSearchWorkerResponse>,
) {
    const result = event.data;
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

function handleWorkerError(event: ErrorEvent) {
    resetWorker(new BrowserSearchWorkerUnavailableError(
        event.error instanceof Error ? event.error.message : event.message,
    ));
}

export function canUseBrowserSearchWorker() {
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

function getBrowserSearchWorker() {
    if (browserSearchWorker) {
        clearIdleTerminateTimer();
        return browserSearchWorker;
    }

    let worker: Worker;
    try {
        worker = new Worker(
            new URL('./browser-search.worker.ts', import.meta.url),
            { type: 'module' },
        );
    } catch (error) {
        throw new BrowserSearchWorkerUnavailableError(
            error instanceof Error ? error.message : String(error),
        );
    }

    worker.addEventListener('message', handleWorkerMessage);
    worker.addEventListener('error', handleWorkerError);
    registerCleanupListeners();
    browserSearchWorker = worker;
    return worker;
}

export async function runBrowserSearchWorkerRequest<K extends TBrowserSearchWorkerRequestType>(
    type: K,
    payload: IBrowserSearchWorkerRequestMap[K],
    options: {onProgress?: (progress: {
        processed: number;
        total: number; 
    }) => void;} = {},
): Promise<IBrowserSearchWorkerResultMap[K]> {
    const request: TBrowserSearchWorkerRequest<K> = {
        id: nextRequestId,
        type,
        payload,
    };
    nextRequestId += 1;

    const worker = getBrowserSearchWorker();

    return new Promise<IBrowserSearchWorkerResultMap[K]>((resolve, reject) => {
        clearIdleTerminateTimer();
        pendingWorkerRequests.set(request.id, {
            resolve: (value) => resolve(value as IBrowserSearchWorkerResultMap[K]),
            reject,
            onProgress: options.onProgress,
        });

        try {
            worker.postMessage(request);
        } catch (error) {
            pendingWorkerRequests.delete(request.id);
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
        id: nextRequestId,
        type,
        payload,
    };
    nextRequestId += 1;

    const worker = getBrowserSearchWorker();

    const promise = new Promise<IBrowserSearchWorkerResultMap[K]>((resolve, reject) => {
        clearIdleTerminateTimer();
        pendingWorkerRequests.set(request.id, {
            resolve: (value) => resolve(value as IBrowserSearchWorkerResultMap[K]),
            reject,
            onProgress: options.onProgress,
        });

        try {
            worker.postMessage(request);
        } catch (error) {
            pendingWorkerRequests.delete(request.id);
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });

    return {
        requestId: request.id,
        promise,
    };
}

export async function cancelBrowserSearchWorkerRequest(requestId: number) {
    if (!browserSearchWorker) {
        return;
    }

    await runBrowserSearchWorkerRequest('cancel', { requestId });
}
