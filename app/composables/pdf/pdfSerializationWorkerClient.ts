import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IPdfSerializationSavePayload } from '@app/composables/pdf/pdfSerializationOperations';
import {
    deleteEmbeddedAnnotation,
    serializePdfEdits,
    updateEmbeddedAnnotationText,
} from '@app/composables/pdf/pdfSerializationOperations';
import { yieldToBrowser } from '@app/platform/browser-api/browser-yield';

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

type TSerializationWorkerRequest<K extends TSerializationWorkerRequestType = TSerializationWorkerRequestType> = {
    id: number;
    type: K;
    payload: ISerializationWorkerRequestMap[K];
};

type TSerializationWorkerResult =
    | {
        id: number;
        ok: true;
        data: Uint8Array | null;
    }
    | {
        id: number;
        ok: false;
        error: string;
    };

type TPendingWorkerRequest = {
    resolve: (value: Uint8Array | null) => void;
    reject: (error: Error) => void;
};

const pendingWorkerRequests = new Map<number, TPendingWorkerRequest>();
const SERIALIZATION_WORKER_IDLE_TTL_MS = 15_000;

let serializationWorker: Worker | null = null;
let nextRequestId = 1;
let idleTerminateTimer: ReturnType<typeof setTimeout> | null = null;
let cleanupListenersRegistered = false;

function clearIdleTerminateTimer() {
    if (!idleTerminateTimer) {
        return;
    }

    clearTimeout(idleTerminateTimer);
    idleTerminateTimer = null;
}

function scheduleIdleWorkerTermination() {
    clearIdleTerminateTimer();
    if (!serializationWorker || pendingWorkerRequests.size > 0) {
        return;
    }

    idleTerminateTimer = setTimeout(() => {
        idleTerminateTimer = null;
        if (!serializationWorker || pendingWorkerRequests.size > 0) {
            return;
        }

        resetWorker();
    }, SERIALIZATION_WORKER_IDLE_TTL_MS);
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
                } as TSerializationWorkerRequest<'save'>,
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
                } as TSerializationWorkerRequest<'updateEmbeddedText'>,
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
                } as TSerializationWorkerRequest<'deleteEmbeddedAnnotation'>,
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

function resetWorker(error?: Error) {
    const pending = Array.from(pendingWorkerRequests.values());
    pendingWorkerRequests.clear();
    clearIdleTerminateTimer();

    if (serializationWorker) {
        serializationWorker.removeEventListener('message', handleWorkerMessage);
        serializationWorker.removeEventListener('error', handleWorkerError);
        serializationWorker.terminate();
        serializationWorker = null;
    }

    if (error) {
        pending.forEach(request => request.reject(error));
    }
}

function handleWorkerMessage(
    event: MessageEvent<TSerializationWorkerResult>,
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
    resetWorker(event.error instanceof Error ? event.error : new Error(event.message));
}

function canUseSerializationWorker() {
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

function getSerializationWorker() {
    if (serializationWorker) {
        clearIdleTerminateTimer();
        return serializationWorker;
    }

    const worker = new Worker(
        new URL('./pdfSerialization.worker.ts', import.meta.url),
        { type: 'module' },
    );
    worker.addEventListener('message', handleWorkerMessage);
    worker.addEventListener('error', handleWorkerError);
    registerCleanupListeners();
    serializationWorker = worker;
    return worker;
}

async function runDirect(
    request: TSerializationWorkerRequest,
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
    const request: TSerializationWorkerRequest<K> = {
        id: nextRequestId,
        type,
        payload,
    };
    nextRequestId += 1;

    if (!canUseSerializationWorker()) {
        return runDirectWithYield(request);
    }

    let worker: Worker;
    try {
        worker = getSerializationWorker();
    } catch {
        return runDirectWithYield(request);
    }

    return new Promise<Uint8Array | null>((resolve, reject) => {
        clearIdleTerminateTimer();
        pendingWorkerRequests.set(request.id, {
            resolve,
            reject,
        });

        try {
            const workerRequest = buildWorkerRequestWithTransfers(request);
            worker.postMessage(workerRequest.request, workerRequest.transfer);
        } catch (error) {
            pendingWorkerRequests.delete(request.id);
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    }).catch(async (error) => {
        if (serializationWorker === worker) {
            resetWorker();
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
