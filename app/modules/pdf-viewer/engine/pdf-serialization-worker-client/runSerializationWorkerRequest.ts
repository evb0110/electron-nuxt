import type {
    ISerializationWorkerRequest,
    ISerializationWorkerRequestMap,
    TSerializationWorkerRequest,
    TSerializationWorkerRequestType,
} from '@app/modules/pdf-viewer/engine/pdfSerializationWorker.types';
import { isRecord } from '@contracts/runtimeGuards';
import { yieldToBrowser } from '@app/utils/yieldToBrowser';
import type { IPendingBrowserWorkerRequest } from '@app/platform/browser-api/public';
import {
    BrowserWorkerClient,
    canUseBrowserWorker,
} from '@app/platform/browser-api/public';

const SERIALIZATION_WORKER_IDLE_TTL_MS = 15_000;

// Hard ceiling for any single serialization request. If the worker does not
// reply within this window we assume it is wedged (silent throw, lost
// postMessage, deadlock) and reject the renderer's await so the save flow
// surfaces an error instead of an indefinite spinner.
const SERIALIZATION_WORKER_REQUEST_TIMEOUT_MS = 30_000;

class PdfSerializationWorkerOperationError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'PdfSerializationWorkerOperationError';
    }
}

class PdfSerializationWorkerTimeoutError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'PdfSerializationWorkerTimeoutError';
    }
}

function isPdfSerializationWorkerOperationError(error: unknown) {
    return error instanceof PdfSerializationWorkerOperationError;
}

function isPdfSerializationWorkerTimeoutError(error: unknown) {
    return error instanceof PdfSerializationWorkerTimeoutError;
}

function settleSerializationWorkerResult(
    pendingRequests: Map<number, IPendingBrowserWorkerRequest>,
    response: unknown,
    onSettled: () => void,
) {
    if (!isRecord(response) || typeof response.id !== 'number') {
        return;
    }

    const pending = pendingRequests.get(response.id);
    if (!pending) {
        return;
    }

    pendingRequests.delete(response.id);
    if (pending.timeoutTimer) {
        clearTimeout(pending.timeoutTimer);
        pending.timeoutTimer = null;
    }
    if (response.ok === true) {
        if (
            !('data' in response)
            || !pending.resolveData(response.data)
        ) {
            pending.reject(new PdfSerializationWorkerOperationError(
                'PDF serialization worker returned an invalid result',
            ));
            onSettled();
            return;
        }
        onSettled();
        return;
    }

    pending.reject(new PdfSerializationWorkerOperationError(
        response.ok === false && typeof response.error === 'string'
            ? response.error
            : 'PDF serialization worker returned an invalid response',
    ));
    onSettled();
}

function decodeSerializationWorkerResult(data: unknown): Uint8Array | null | undefined {
    if (data === null || data instanceof Uint8Array) {
        return data;
    }
    return undefined;
}

function toTransferableUint8Array(data: Uint8Array): Uint8Array<ArrayBuffer> {
    // Never transfer the caller's live buffer into the worker. The save path
    // can pass reactive PDF state here, and transferring that buffer would
    // detach it on the main thread before the save completes.
    return data.slice();
}

function buildWorkerRequestWithTransfers(
    request: TSerializationWorkerRequest,
) {
    switch (request.type) {
        case 'save': {
            const payload = request.payload;
            const transferableData = toTransferableUint8Array(payload.data);
            return {
                request: {
                    ...request,
                    payload: {
                        ...payload,
                        data: transferableData,
                    },
                } satisfies ISerializationWorkerRequest<'save'>,
                transfer: [transferableData.buffer] satisfies Transferable[],
            };
        }
        case 'updateEmbeddedText': {
            const payload = request.payload;
            const transferableData = toTransferableUint8Array(payload.data);
            return {
                request: {
                    ...request,
                    payload: {
                        ...payload,
                        data: transferableData,
                    },
                } satisfies ISerializationWorkerRequest<'updateEmbeddedText'>,
                transfer: [transferableData.buffer] satisfies Transferable[],
            };
        }
        case 'deleteEmbeddedAnnotation': {
            const payload = request.payload;
            const transferableData = toTransferableUint8Array(payload.data);
            return {
                request: {
                    ...request,
                    payload: {
                        ...payload,
                        data: transferableData,
                    },
                } satisfies ISerializationWorkerRequest<'deleteEmbeddedAnnotation'>,
                transfer: [transferableData.buffer] satisfies Transferable[],
            };
        }
        default:
            return {
                request,
                transfer: [] satisfies Transferable[],
            };
    }
}

const serializationWorkerClient = new BrowserWorkerClient<IPendingBrowserWorkerRequest>({
    idleTtlMs: SERIALIZATION_WORKER_IDLE_TTL_MS,
    requestTimeoutMs: SERIALIZATION_WORKER_REQUEST_TIMEOUT_MS,
    createWorker: () => new Worker(
        new URL('../pdfSerialization.worker.ts', import.meta.url),
        { type: 'module' },
    ),
    createError: event => (event.error instanceof Error ? event.error : new Error(event.message)),
    handleMessage: settleSerializationWorkerResult,
});

async function runDirect(
    request: TSerializationWorkerRequest,
) {
    switch (request.type) {
        case 'save': {
            const { payload } = request;
            const { serializePdfEdits } = await import(
                '@app/modules/pdf-viewer/engine/pdf-serialization-operations/serializePdfEdits'
            );
            return serializePdfEdits(payload.data, payload.payload);
        }
        case 'updateEmbeddedText': {
            const { payload } = request;
            const { updateEmbeddedAnnotationText } = await import(
                '@app/modules/pdf-viewer/engine/pdf-serialization-operations/updateEmbeddedAnnotationText'
            );
            return updateEmbeddedAnnotationText(
                payload.data,
                payload.comment,
                payload.text,
            );
        }
        case 'deleteEmbeddedAnnotation': {
            const { payload } = request;
            const { deleteEmbeddedAnnotation } = await import(
                '@app/modules/pdf-viewer/engine/pdf-serialization-operations/deleteEmbeddedAnnotation'
            );
            return deleteEmbeddedAnnotation(payload.data, payload.comment);
        }
        default:
            throw new Error('Unsupported PDF serialization request');
    }
}

async function runDirectWithYield(
    request: TSerializationWorkerRequest,
) {
    await yieldToBrowser();
    const result = await runDirect(request);
    await yieldToBrowser();
    return result;
}

export async function runSerializationWorkerRequest<K extends TSerializationWorkerRequestType>(
    type: K,
    payload: ISerializationWorkerRequestMap[K],
) {
    const request: ISerializationWorkerRequest<K> = {
        id: serializationWorkerClient.createRequestId(),
        type,
        payload,
    };
    const typedRequest = request as TSerializationWorkerRequest;

    if (!canUseBrowserWorker()) {
        return runDirectWithYield(typedRequest);
    }

    let worker: Worker;
    try {
        worker = serializationWorkerClient.getWorker();
    } catch {
        return runDirectWithYield(typedRequest);
    }

    return new Promise<Uint8Array | null>((resolve, reject) => {
        serializationWorkerClient.clearIdleTerminateTimer();

        serializationWorkerClient.registerPendingRequest(request.id, {
            requestType: type,
            resolveData: (data) => {
                const decoded = decodeSerializationWorkerResult(data);
                if (decoded === undefined) {
                    return false;
                }
                resolve(decoded);
                return true;
            },
            reject,
        }, () => new PdfSerializationWorkerTimeoutError(
            `PDF serialization worker did not reply within ${SERIALIZATION_WORKER_REQUEST_TIMEOUT_MS}ms (type=${request.type})`,
        ));

        try {
            const workerRequest = buildWorkerRequestWithTransfers(typedRequest);
            worker.postMessage(workerRequest.request, workerRequest.transfer);
        } catch (error) {
            serializationWorkerClient.cancelPendingRequest(
                request.id,
                error instanceof Error ? error : new Error(String(error)),
            );
        }
    }).catch(async (error: unknown) => {
        if (isPdfSerializationWorkerOperationError(error)) {
            throw error;
        }

        if (isPdfSerializationWorkerTimeoutError(error)) {
            if (serializationWorkerClient.isActiveWorker(worker)) {
                serializationWorkerClient.resetWorker(error);
            }
            return runDirectWithYield(typedRequest);
        }

        if (serializationWorkerClient.isActiveWorker(worker)) {
            serializationWorkerClient.resetWorker();
        }
        return runDirectWithYield(typedRequest).catch(() => {
            throw error;
        });
    });
}
