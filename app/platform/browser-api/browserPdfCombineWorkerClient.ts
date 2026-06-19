import type {
    IBrowserPdfCombineInput,
    IBrowserPdfCombineWorkerRequest,
    IBrowserPdfCombineWorkerRequestMap,
    IBrowserPdfCombineWorkerResultMap,
    TBrowserPdfCombineWorkerRequest,
    TBrowserPdfCombineWorkerRequestType,
} from '@app/platform/browser-api/browserPdfCombineWorker.types';
import { isRecord } from '@contracts/runtimeGuards';
import { toTransferableUint8Array } from '@app/platform/browser-api/toTransferableUint8Array';
import { settleBrowserWorkerResult } from '@app/platform/browser-api/settleBrowserWorkerResult';
import type { IPendingBrowserWorkerRequest } from '@app/platform/browser-api/settleBrowserWorkerResult';
import {
    BrowserWorkerClient,
    canUseBrowserWorker,
} from '@app/platform/browser-api/browserWorkerClient';
import { getErrorMessage } from '@app/utils/error';

const BROWSER_PDF_COMBINE_WORKER_IDLE_TTL_MS = 15_000;
const BROWSER_PDF_COMBINE_WORKER_REQUEST_TIMEOUT_MS = 120_000;

export class BrowserPdfCombineWorkerUnavailableError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'BrowserPdfCombineWorkerUnavailableError';
    }
}

function buildWorkerRequestWithTransfers(
    request: TBrowserPdfCombineWorkerRequest,
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

function decodePdfCombineWorkerResult<K extends TBrowserPdfCombineWorkerRequestType>(
    _type: K,
    data: unknown,
): IBrowserPdfCombineWorkerResultMap[K] | null {
    if (!isRecord(data) || !(data.data instanceof Uint8Array)) {
        return null;
    }

    return {data: data.data};
}

export function canUseBrowserPdfCombineWorker() {
    return canUseBrowserWorker();
}

const browserPdfCombineWorkerClient = new BrowserWorkerClient<IPendingBrowserWorkerRequest>({
    idleTtlMs: BROWSER_PDF_COMBINE_WORKER_IDLE_TTL_MS,
    requestTimeoutMs: BROWSER_PDF_COMBINE_WORKER_REQUEST_TIMEOUT_MS,
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
        browserPdfCombineWorkerClient.registerPendingRequest(request.id, {
            requestType: type,
            resolveData: (value) => {
                const decoded = decodePdfCombineWorkerResult(type, value);
                if (!decoded) {
                    return false;
                }
                resolve(decoded);
                return true;
            },
            reject,
        }, () => new BrowserPdfCombineWorkerUnavailableError(
            `Browser PDF combine worker request timed out after ${BROWSER_PDF_COMBINE_WORKER_REQUEST_TIMEOUT_MS}ms`,
        ));

        try {
            const workerRequest = buildWorkerRequestWithTransfers(
                request,
            );
            worker.postMessage(workerRequest.request, workerRequest.transfer);
        } catch (error) {
            browserPdfCombineWorkerClient.cancelPendingRequest(
                request.id,
                error instanceof Error ? error : new Error(String(error)),
            );
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
