import type {
    IBrowserPdfCombineInput,
    IBrowserPdfCombineWorkerRequestMap,
    IBrowserPdfCombineWorkerResultMap,
    IBrowserPdfCombineWorkerRequest,
    TBrowserPdfCombineWorkerRequestType,
    TBrowserPdfCombineWorkerResponse,
} from '@app/platform/browser-api/browserPdfCombineWorker.types';
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

type TAnyBrowserPdfCombineWorkerRequest = {
    [K in TBrowserPdfCombineWorkerRequestType]: IBrowserPdfCombineWorkerRequest<K>;
}[TBrowserPdfCombineWorkerRequestType];

const BROWSER_PDF_COMBINE_WORKER_IDLE_TTL_MS = 15_000;

export class BrowserPdfCombineWorkerUnavailableError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'BrowserPdfCombineWorkerUnavailableError';
    }
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

export function canUseBrowserPdfCombineWorker() {
    return canUseBrowserWorker();
}

const browserPdfCombineWorkerClient = new BrowserWorkerClient<
    TBrowserPdfCombineWorkerResponse,
    IPendingBrowserWorkerRequest
>({
    idleTtlMs: BROWSER_PDF_COMBINE_WORKER_IDLE_TTL_MS,
    createWorker: () => {
        try {
            return new Worker(
                new URL('./browserPdfCombine.worker.ts', import.meta.url),
                { type: 'module' },
            );
        } catch (error) {
            throw new BrowserPdfCombineWorkerUnavailableError(
                getErrorMessage(error),
            );
        }
    },
    createError: event => new BrowserPdfCombineWorkerUnavailableError(
        event.error instanceof Error ? event.error.message : event.message,
    ),
    handleMessage: settleBrowserWorkerResult,
});

export async function runBrowserPdfCombineWorkerRequest<K extends TBrowserPdfCombineWorkerRequestType>(
    type: K,
    payload: IBrowserPdfCombineWorkerRequestMap[K],
): Promise<IBrowserPdfCombineWorkerResultMap[K]> {
    const request: IBrowserPdfCombineWorkerRequest<K> = {
        id: browserPdfCombineWorkerClient.createRequestId(),
        type,
        payload,
    };

    const worker = browserPdfCombineWorkerClient.getWorker();

    return new Promise<IBrowserPdfCombineWorkerResultMap[K]>((resolve, reject) => {
        browserPdfCombineWorkerClient.clearIdleTerminateTimer();
        browserPdfCombineWorkerClient.pendingRequests.set(request.id, {
            resolve: (value) => resolve(value as IBrowserPdfCombineWorkerResultMap[K]),
            reject,
        });

        try {
            const workerRequest = buildWorkerRequestWithTransfers(
                request,
            );
            worker.postMessage(workerRequest.request, workerRequest.transfer);
        } catch (error) {
            browserPdfCombineWorkerClient.pendingRequests.delete(request.id);
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
