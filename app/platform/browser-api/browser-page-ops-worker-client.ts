import type {
    IBrowserPageOpsWorkerRequestMap,
    IBrowserPageOpsWorkerResultMap,
    TBrowserPageOpsWorkerRequest,
    TBrowserPageOpsWorkerRequestType,
    TBrowserPageOpsWorkerResponse,
} from '@app/platform/browser-api/browser-page-ops-worker.types';

type TPendingWorkerRequest = {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
};

const pendingWorkerRequests = new Map<number, TPendingWorkerRequest>();

let browserPageOpsWorker: Worker | null = null;
let nextRequestId = 1;

export class BrowserPageOpsWorkerUnavailableError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'BrowserPageOpsWorkerUnavailableError';
    }
}

function toTransferableUint8Array(data: Uint8Array): Uint8Array<ArrayBuffer> {
    if (
        data.buffer instanceof ArrayBuffer
        && data.byteOffset === 0
        && data.byteLength === data.buffer.byteLength
    ) {
        return data as Uint8Array<ArrayBuffer>;
    }

    if (
        data.byteOffset === 0
        && data.byteLength === data.buffer.byteLength
    ) {
        return new Uint8Array(data);
    }

    return data.slice();
}

function buildWorkerRequestWithTransfers<K extends TBrowserPageOpsWorkerRequestType>(
    request: TBrowserPageOpsWorkerRequest<K>,
) {
    const transferableData = toTransferableUint8Array(request.payload.data);
    return {
        request: {
            ...request,
            payload: {
                ...request.payload,
                data: transferableData,
            },
        } as TBrowserPageOpsWorkerRequest<K>,
        transfer: [transferableData.buffer] satisfies Transferable[],
    };
}

function resetWorker(error?: Error) {
    const pending = Array.from(pendingWorkerRequests.values());
    pendingWorkerRequests.clear();

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
    const result = event.data;
    const pending = pendingWorkerRequests.get(result.id);
    if (!pending) {
        return;
    }

    pendingWorkerRequests.delete(result.id);
    if (result.ok) {
        pending.resolve(result.data);
        return;
    }

    pending.reject(new Error(result.error));
}

function handleWorkerError(event: ErrorEvent) {
    resetWorker(new BrowserPageOpsWorkerUnavailableError(
        event.error instanceof Error ? event.error.message : event.message,
    ));
}

export function canUseBrowserPageOpsWorker() {
    return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}

function getBrowserPageOpsWorker() {
    if (browserPageOpsWorker) {
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
            error instanceof Error ? error.message : String(error),
        );
    }

    worker.addEventListener('message', handleWorkerMessage);
    worker.addEventListener('error', handleWorkerError);
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
        pendingWorkerRequests.set(request.id, {
            resolve: (value) => resolve(value as IBrowserPageOpsWorkerResultMap[K]),
            reject,
        });

        try {
            const workerRequest = buildWorkerRequestWithTransfers(request);
            worker.postMessage(workerRequest.request, workerRequest.transfer);
        } catch (error) {
            pendingWorkerRequests.delete(request.id);
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });
}
