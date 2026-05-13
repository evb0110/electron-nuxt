import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IPdfSerializationSavePayload } from '@app/composables/pdf/pdfSerializationOperations';
import {
    deleteEmbeddedAnnotation,
    serializePdfEdits,
    updateEmbeddedAnnotationText,
} from '@app/composables/pdf/pdfSerializationOperations';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import {
    settleBrowserWorkerResult,
    type TBrowserWorkerResult,
    type IPendingBrowserWorkerRequest,
} from '@app/platform/browser-api/browserWorkerRequests';
import {
    BrowserWorkerClient,
    canUseBrowserWorker,
} from '@app/platform/browser-api/browserWorkerClient';

interface ISerializationWorkerRequestMap {
    save: {
        data: Uint8Array;
        payload: IPdfSerializationSavePayload;
    };
    updateEmbeddedText: {
        data: Uint8Array;
        comment: IAnnotationCommentSummary;
        text: string;
    };
    deleteEmbeddedAnnotation: {
        data: Uint8Array;
        comment: IAnnotationCommentSummary;
    };
}

type TSerializationWorkerRequestType = keyof ISerializationWorkerRequestMap;

interface ISerializationWorkerRequest<K extends TSerializationWorkerRequestType = TSerializationWorkerRequestType> {
    id: number;
    type: K;
    payload: ISerializationWorkerRequestMap[K];
}

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
    request: ISerializationWorkerRequest,
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
                } as ISerializationWorkerRequest<'save'>,
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
                } as ISerializationWorkerRequest<'updateEmbeddedText'>,
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
                } as ISerializationWorkerRequest<'deleteEmbeddedAnnotation'>,
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

function canUseSerializationWorker() {
    return canUseBrowserWorker();
}

const serializationWorkerClient = new BrowserWorkerClient<
    TSerializationWorkerResult,
    IPendingBrowserWorkerRequest<Uint8Array | null>
>({
    idleTtlMs: SERIALIZATION_WORKER_IDLE_TTL_MS,
    createWorker: () => new Worker(
        new URL('./pdfSerialization.worker.ts', import.meta.url),
        { type: 'module' },
    ),
    createError: event => (event.error instanceof Error ? event.error : new Error(event.message)),
    handleMessage: settleBrowserWorkerResult,
});

async function runDirect(
    request: ISerializationWorkerRequest,
) {
    switch (request.type) {
        case 'save': {
            const payload = request.payload as ISerializationWorkerRequestMap['save'];
            return serializePdfEdits(payload.data, payload.payload);
        }
        case 'updateEmbeddedText': {
            const payload = request.payload as ISerializationWorkerRequestMap['updateEmbeddedText'];
            return updateEmbeddedAnnotationText(
                payload.data,
                payload.comment,
                payload.text,
            );
        }
        case 'deleteEmbeddedAnnotation': {
            const payload = request.payload as ISerializationWorkerRequestMap['deleteEmbeddedAnnotation'];
            return deleteEmbeddedAnnotation(payload.data, payload.comment);
        }
        default:
            throw new Error(`Unsupported PDF serialization request: ${String(request.type)}`);
    }
}

async function runDirectWithYield(
    request: ISerializationWorkerRequest,
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

    if (!canUseSerializationWorker()) {
        return runDirectWithYield(request);
    }

    let worker: Worker;
    try {
        worker = serializationWorkerClient.getWorker();
    } catch {
        return runDirectWithYield(request);
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
            const workerRequest = buildWorkerRequestWithTransfers(request);
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
        return runDirectWithYield(request).catch(() => {
            throw error;
        });
    });
}

export async function serializePdfEditsOffThread(
    data: Uint8Array,
    payload: IPdfSerializationSavePayload,
) {
    return runSerializationWorkerRequest('save', {
        data,
        payload,
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

export async function deleteEmbeddedAnnotationOffThread(
    data: Uint8Array,
    comment: IAnnotationCommentSummary,
) {
    return runSerializationWorkerRequest('deleteEmbeddedAnnotation', {
        data,
        comment,
    });
}
