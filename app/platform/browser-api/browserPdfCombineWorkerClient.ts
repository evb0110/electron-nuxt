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
    const transfer: Transferable[] = [];
    const transferredBuffers = new Set<ArrayBuffer>();
    const cloneInput = (input: IBrowserPdfCombineInput) => {
        let data = toTransferableUint8Array(input.data);
        if (transferredBuffers.has(data.buffer)) {
            data = data.slice();
        }
        transferredBuffers.add(data.buffer);
        const cloned = {
            ...input,
            data,
        };
        transfer.push(cloned.data.buffer);
        return cloned;
    };
    const inputs = request.payload.inputs.map((input) => ({...cloneInput(input)}));
    const preprocessing = request.payload.wasmImagePreprocessing;
    const wasmImagePreprocessing = preprocessing?.pageSpecs
        ? {
            ...preprocessing,
            pageSpecs: preprocessing.pageSpecs.map(spec => ({
                ...spec,
                ...(spec.image ? {image: cloneInput(spec.image)} : {}),
                ...(spec.background ? {background: cloneInput(spec.background)} : {}),
                ...(spec.mask ? {mask: cloneInput(spec.mask)} : {}),
            })),
        }
        : preprocessing;

    return {
        request: {
            ...request,
            payload: {
                ...request.payload,
                inputs,
                ...(wasmImagePreprocessing ? {wasmImagePreprocessing} : {}),
            },
        },
        transfer,
    };
}

function decodePdfCombineWorkerResult<K extends TBrowserPdfCombineWorkerRequestType>(
    _type: K,
    data: unknown,
): IBrowserPdfCombineWorkerResultMap[K] | null {
    if (
        !isRecord(data)
        || !(data.data instanceof Uint8Array)
        || data.data.byteLength < 8
        || new TextDecoder().decode(data.data.subarray(0, 5)) !== '%PDF-'
    ) {
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
    signal?: AbortSignal,
): Promise<IBrowserPdfCombineWorkerResultMap[K]> {
    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException('PDF combine was canceled.', 'AbortError');
    }
    const request: IBrowserPdfCombineWorkerRequest<K> = {
        id: browserPdfCombineWorkerClient.createRequestId(),
        type,
        payload,
    };

    const worker = browserPdfCombineWorkerClient.getWorker();

    return new Promise<IBrowserPdfCombineWorkerResultMap[K]>((resolve, reject) => {
        const abort = () => {
            const error = signal?.reason instanceof Error
                ? signal.reason
                : new DOMException('PDF combine was canceled.', 'AbortError');
            browserPdfCombineWorkerClient.cancelPendingRequest(request.id, error, {
                resetWorker: true,
                resetError: error,
            });
        };
        browserPdfCombineWorkerClient.registerPendingRequest(request.id, {
            requestType: type,
            resolveData: (value) => {
                const decoded = decodePdfCombineWorkerResult(type, value);
                if (!decoded) {
                    return false;
                }
                signal?.removeEventListener('abort', abort);
                resolve(decoded);
                return true;
            },
            reject: (error) => {
                signal?.removeEventListener('abort', abort);
                reject(error);
            },
        }, () => new BrowserPdfCombineWorkerUnavailableError(
            `Browser PDF combine worker request timed out after ${BROWSER_PDF_COMBINE_WORKER_REQUEST_TIMEOUT_MS}ms`,
        ));
        signal?.addEventListener('abort', abort, {once: true});

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
