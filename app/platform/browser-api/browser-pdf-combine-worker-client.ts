import type {
    IBrowserPdfCombineInput,
    IBrowserPdfCombineWorkerRequestMap,
    IBrowserPdfCombineWorkerResultMap,
    TBrowserPdfCombineWorkerRequest,
    TBrowserPdfCombineWorkerRequestType,
    TBrowserPdfCombineWorkerResponse,
} from '@app/platform/browser-api/browser-pdf-combine-worker.types';
import { getErrorMessage } from '@app/utils/error';

type TPendingWorkerRequest = {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
};

type TAnyBrowserPdfCombineWorkerRequest = {
    [K in TBrowserPdfCombineWorkerRequestType]: TBrowserPdfCombineWorkerRequest<K>;
}[TBrowserPdfCombineWorkerRequestType];

const pendingWorkerRequests = new Map<number, TPendingWorkerRequest>();
const BROWSER_PDF_COMBINE_WORKER_IDLE_TTL_MS = 15_000;

let browserPdfCombineWorker: Worker | null = null;
let nextRequestId = 1;
let idleTerminateTimer: ReturnType<typeof setTimeout> | null = null;
let cleanupListenersRegistered = false;

export class BrowserPdfCombineWorkerUnavailableError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'BrowserPdfCombineWorkerUnavailableError';
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
    if (!browserPdfCombineWorker || pendingWorkerRequests.size > 0) {
        return;
    }

    idleTerminateTimer = setTimeout(() => {
        idleTerminateTimer = null;
        if (!browserPdfCombineWorker || pendingWorkerRequests.size > 0) {
            return;
        }

        resetWorker();
    }, BROWSER_PDF_COMBINE_WORKER_IDLE_TTL_MS);
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

function buildWorkerRequestWithTransfers(
    request: TAnyBrowserPdfCombineWorkerRequest,
) {
    const inputs = request.payload.inputs.map((input) => ({
        ...input,
        data: toTransferableUint8Array(input.data),
    }));

    return {
        request: {
            ...request,
            payload: {
                ...request.payload,
                inputs,
            },
        },
        transfer: inputs.map((input) => input.data.buffer) satisfies Transferable[],
    };
}

function resetWorker(error?: Error) {
    const pending = Array.from(pendingWorkerRequests.values());
    pendingWorkerRequests.clear();
    clearIdleTerminateTimer();

    if (browserPdfCombineWorker) {
        browserPdfCombineWorker.removeEventListener('message', handleWorkerMessage);
        browserPdfCombineWorker.removeEventListener('error', handleWorkerError);
        browserPdfCombineWorker.terminate();
        browserPdfCombineWorker = null;
    }

    if (error) {
        pending.forEach((request) => request.reject(error));
    }
}

function handleWorkerMessage(
    event: MessageEvent<TBrowserPdfCombineWorkerResponse>,
) {
    const result = event.data;
    const pending = pendingWorkerRequests.get(result.id);
    if (!pending) {
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
    resetWorker(new BrowserPdfCombineWorkerUnavailableError(
        event.error instanceof Error ? event.error.message : event.message,
    ));
}

export function canUseBrowserPdfCombineWorker() {
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

function getBrowserPdfCombineWorker() {
    if (browserPdfCombineWorker) {
        clearIdleTerminateTimer();
        return browserPdfCombineWorker;
    }

    let worker: Worker;
    try {
        worker = new Worker(
            new URL('./browser-pdf-combine.worker.ts', import.meta.url),
            { type: 'module' },
        );
    } catch (error) {
        throw new BrowserPdfCombineWorkerUnavailableError(
            getErrorMessage(error),
        );
    }

    worker.addEventListener('message', handleWorkerMessage);
    worker.addEventListener('error', handleWorkerError);
    registerCleanupListeners();
    browserPdfCombineWorker = worker;
    return worker;
}

export async function runBrowserPdfCombineWorkerRequest<K extends TBrowserPdfCombineWorkerRequestType>(
    type: K,
    payload: IBrowserPdfCombineWorkerRequestMap[K],
): Promise<IBrowserPdfCombineWorkerResultMap[K]> {
    const request: TBrowserPdfCombineWorkerRequest<K> = {
        id: nextRequestId,
        type,
        payload,
    };
    nextRequestId += 1;

    const worker = getBrowserPdfCombineWorker();

    return new Promise<IBrowserPdfCombineWorkerResultMap[K]>((resolve, reject) => {
        clearIdleTerminateTimer();
        pendingWorkerRequests.set(request.id, {
            resolve: (value) => resolve(value as IBrowserPdfCombineWorkerResultMap[K]),
            reject,
        });

        try {
            const workerRequest = buildWorkerRequestWithTransfers(
                request,
            );
            worker.postMessage(workerRequest.request, workerRequest.transfer);
        } catch (error) {
            pendingWorkerRequests.delete(request.id);
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });
}

export function cloneCombineWorkerInput(
    fileName: string,
    data: Uint8Array,
): IBrowserPdfCombineInput {
    return {
        fileName,
        data: toTransferableUint8Array(data),
    };
}
