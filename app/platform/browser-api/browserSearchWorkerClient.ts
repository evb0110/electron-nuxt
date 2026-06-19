import type {
    IBrowserSearchWorkerRequest,
    IBrowserSearchWorkerRequestMap,
    IBrowserSearchWorkerResultMap,
    TBrowserSearchWorkerRequestType,
} from '@app/platform/browser-api/browserSearchWorker.types';
import { isRecord } from '@contracts/runtimeGuards';
import {
    BrowserWorkerClient,
    canUseBrowserWorker,
} from '@app/platform/browser-api/browserWorkerClient';
import { getErrorMessage } from '@app/utils/error';

interface IPendingWorkerRequest {
    requestType: TBrowserSearchWorkerRequestType;
    resolveData: (data: unknown) => boolean;
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

function getSearchWorkerResponseId(response: unknown) {
    return isRecord(response) && typeof response.id === 'number'
        ? response.id
        : null;
}

function isFiniteProgressNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function parseSearchWorkerProgress(
    response: unknown,
    expectedType: TBrowserSearchWorkerRequestType,
): Parameters<TBrowserSearchWorkerProgressHandler>[0] | null {
    if (
        !isRecord(response)
        || response.ok !== true
        || response.type !== expectedType
        || !isRecord(response.progress)
    ) {
        return null;
    }

    if (
        !isFiniteProgressNumber(response.progress.processed)
        || !isFiniteProgressNumber(response.progress.total)
    ) {
        return null;
    }

    return {
        processed: response.progress.processed,
        total: response.progress.total,
    };
}

function decodeExtractDocumentTextResult(data: unknown): IBrowserSearchWorkerResultMap['extractDocumentText'] | null {
    if (!isRecord(data) || typeof data.pageCount !== 'number' || !Array.isArray(data.pageTexts)) {
        return null;
    }

    const pageTexts = data.pageTexts;
    if (
        !Number.isInteger(data.pageCount)
        || data.pageCount < 0
        || !pageTexts.every((pageText): pageText is string => typeof pageText === 'string')
    ) {
        return null;
    }

    return {
        pageCount: data.pageCount,
        pageTexts: [...pageTexts],
    };
}

function decodeCancelResult(data: unknown): IBrowserSearchWorkerResultMap['cancel'] | null {
    if (!isRecord(data) || typeof data.canceled !== 'boolean') {
        return null;
    }

    return {canceled: data.canceled};
}

function decodeSearchWorkerResult<K extends TBrowserSearchWorkerRequestType>(
    type: K,
    data: unknown,
): IBrowserSearchWorkerResultMap[K] | null {
    if (type === 'extractDocumentText') {
        return decodeExtractDocumentTextResult(data) as IBrowserSearchWorkerResultMap[K] | null;
    }

    return decodeCancelResult(data) as IBrowserSearchWorkerResultMap[K] | null;
}

function settleSearchWorkerResponse(
    pendingWorkerRequests: Map<number, IPendingWorkerRequest>,
    response: unknown,
    scheduleIdleWorkerTermination: () => void,
) {
    const responseId = getSearchWorkerResponseId(response);
    if (responseId === null) {
        return;
    }

    const pending = pendingWorkerRequests.get(responseId);
    if (!pending) {
        return;
    }

    const progress = parseSearchWorkerProgress(response, pending.requestType);
    if (progress) {
        pending.onProgress?.(progress);
        return;
    }

    const timeoutTimer = pending.timeoutTimer;
    pendingWorkerRequests.delete(responseId);
    if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        pending.timeoutTimer = null;
    }

    if (!isRecord(response) || typeof response.ok !== 'boolean') {
        pending.reject(new Error('Browser search worker returned an invalid response'));
        scheduleIdleWorkerTermination();
        return;
    }

    if (response.ok === true) {
        if (response.type !== pending.requestType || !('data' in response) || !pending.resolveData(response.data)) {
            pending.reject(new Error('Browser search worker returned an invalid result'));
            scheduleIdleWorkerTermination();
            return;
        }
        scheduleIdleWorkerTermination();
        return;
    }

    pending.reject(new Error(typeof response.error === 'string'
        ? response.error
        : 'Browser search worker returned an invalid error response'));
    scheduleIdleWorkerTermination();
}

export function canUseBrowserSearchWorker() {
    return canUseBrowserWorker();
}

const browserSearchWorkerClient = new BrowserWorkerClient<IPendingWorkerRequest>({
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

    const promise =
        new Promise<IBrowserSearchWorkerResultMap[K]>((resolve, reject) => {
            browserSearchWorkerClient.registerPendingRequest(request.id, {
                requestType: type,
                resolveData: (value) => {
                    const decoded = decodeSearchWorkerResult(type, value);
                    if (!decoded) {
                        return false;
                    }
                    resolve(decoded);
                    return true;
                },
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
    if (!browserSearchWorkerClient.hasPendingRequest(requestId)) {
        return;
    }

    const cancelError = new Error('ERR_BROWSER_SEARCH_CANCELED');
    if (!browserSearchWorkerClient.hasWorker()) {
        browserSearchWorkerClient.cancelPendingRequest(requestId, cancelError);
        return;
    }

    try {
        const cancelRequest: IBrowserSearchWorkerRequest<'cancel'> = {
            id: browserSearchWorkerClient.createRequestId(),
            type: 'cancel',
            payload: { requestId },
        };
        browserSearchWorkerClient.getWorker().postMessage(cancelRequest);
    } catch (error) {
        browserSearchWorkerClient.cancelPendingRequest(
            requestId,
            cancelError,
            {
                resetWorker: true,
                resetError: new BrowserSearchWorkerRequestError(getErrorMessage(error)),
            },
        );
        return;
    }

    browserSearchWorkerClient.cancelPendingRequest(requestId, cancelError);
}
