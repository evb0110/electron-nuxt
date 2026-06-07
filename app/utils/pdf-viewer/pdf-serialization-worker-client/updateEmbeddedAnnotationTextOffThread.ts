import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type {
    ISerializationWorkerRequest,
    ISerializationWorkerRequestMap,
    TSerializationWorkerRequest,
    TSerializationWorkerRequestType,
} from '@app/utils/pdf-viewer/pdfSerializationWorker.types';
import { deleteEmbeddedAnnotation } from '@app/utils/pdf-viewer/pdf-serialization-operations/deleteEmbeddedAnnotation';
import { serializePdfEdits } from '@app/utils/pdf-viewer/pdf-serialization-operations/serializePdfEdits';
import { updateEmbeddedAnnotationText } from '@app/utils/pdf-viewer/pdf-serialization-operations/updateEmbeddedAnnotationText';
import { yieldToBrowser } from '@app/utils/yieldToBrowser';
import type {
    IPendingBrowserWorkerRequest,
    TBrowserWorkerResult,
} from '@app/platform/browser-api/public';
import {
    BrowserWorkerClient,
    canUseBrowserWorker,
    settleBrowserWorkerResult,
} from '@app/platform/browser-api/public';

type TSerializationWorkerResult = TBrowserWorkerResult<Uint8Array | null>;

const SERIALIZATION_WORKER_IDLE_TTL_MS = 15_000;

// Hard ceiling for any single serialization request. If the worker does not
// reply within this window we assume it is wedged (silent throw, lost
// postMessage, deadlock) and reject the renderer's await so the save flow
// surfaces an error instead of an indefinite spinner.
const SERIALIZATION_WORKER_REQUEST_TIMEOUT_MS = 30_000;

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

const serializationWorkerClient = new BrowserWorkerClient<
    TSerializationWorkerResult,
    IPendingBrowserWorkerRequest<Uint8Array | null>
>({
    idleTtlMs: SERIALIZATION_WORKER_IDLE_TTL_MS,
    createWorker: () => new Worker(
        new URL('../pdfSerialization.worker.ts', import.meta.url),
        { type: 'module' },
    ),
    createError: event => (event.error instanceof Error ? event.error : new Error(event.message)),
    handleMessage: settleBrowserWorkerResult,
});

async function runDirect(
    request: TSerializationWorkerRequest,
) {
    switch (request.type) {
        case 'save': {
            const { payload } = request;
            return serializePdfEdits(payload.data, payload.payload);
        }
        case 'updateEmbeddedText': {
            const { payload } = request;
            return updateEmbeddedAnnotationText(
                payload.data,
                payload.comment,
                payload.text,
            );
        }
        case 'deleteEmbeddedAnnotation': {
            const { payload } = request;
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

async function runSerializationWorkerRequest<K extends TSerializationWorkerRequestType>(
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

        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const clearRequestTimeout = () => {
            if (timeoutHandle !== null) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
        };

        serializationWorkerClient.pendingRequests.set(request.id, {
            resolve: (value) => {
                clearRequestTimeout();
                resolve(value);
            },
            reject: (reason) => {
                clearRequestTimeout();
                reject(reason);
            },
        });

        timeoutHandle = setTimeout(() => {
            timeoutHandle = null;
            if (!serializationWorkerClient.pendingRequests.delete(request.id)) {
                return;
            }
            if (serializationWorkerClient.isActiveWorker(worker)) {
                serializationWorkerClient.resetWorker();
            }
            reject(new Error(
                `PDF serialization worker did not reply within ${SERIALIZATION_WORKER_REQUEST_TIMEOUT_MS}ms (type=${request.type})`,
            ));
        }, SERIALIZATION_WORKER_REQUEST_TIMEOUT_MS);

        try {
            const workerRequest = buildWorkerRequestWithTransfers(typedRequest);
            worker.postMessage(workerRequest.request, workerRequest.transfer);
        } catch (error) {
            clearRequestTimeout();
            serializationWorkerClient.pendingRequests.delete(request.id);
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    }).catch(async (error) => {
        if (serializationWorkerClient.isActiveWorker(worker)) {
            serializationWorkerClient.resetWorker();
        }
        return runDirectWithYield(typedRequest).catch(() => {
            throw error;
        });
    });
}

export async function updateEmbeddedAnnotationTextOffThread(
    data: Uint8Array,
    comment: IAnnotationCommentSummary,
    text: string,
) {
    return runSerializationWorkerRequest('updateEmbeddedText', {
        data,
        comment,
        text,
    });
}
