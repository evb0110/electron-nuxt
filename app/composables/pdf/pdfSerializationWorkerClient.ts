import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IPdfSerializationSavePayload } from '@app/composables/pdf/pdfSerializationOperations';
import {
    deleteEmbeddedAnnotation,
    serializePdfEdits,
    updateEmbeddedAnnotationText,
} from '@app/composables/pdf/pdfSerializationOperations';

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

let serializationWorker: Worker | null = null;
let nextRequestId = 1;

function resetWorker(error?: Error) {
    const pending = Array.from(pendingWorkerRequests.values());
    pendingWorkerRequests.clear();

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
        return;
    }

    pending.reject(new Error(result.error));
}

function handleWorkerError(event: ErrorEvent) {
    resetWorker(event.error instanceof Error ? event.error : new Error(event.message));
}

function canUseSerializationWorker() {
    return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}

function getSerializationWorker() {
    if (serializationWorker) {
        return serializationWorker;
    }

    const worker = new Worker(
        new URL('./pdfSerialization.worker.ts', import.meta.url),
        { type: 'module' },
    );
    worker.addEventListener('message', handleWorkerMessage);
    worker.addEventListener('error', handleWorkerError);
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
        return runDirect(request);
    }

    let worker: Worker;
    try {
        worker = getSerializationWorker();
    } catch {
        return runDirect(request);
    }

    return new Promise<Uint8Array | null>((resolve, reject) => {
        pendingWorkerRequests.set(request.id, {
            resolve,
            reject,
        });

        try {
            worker.postMessage(request);
        } catch (error) {
            pendingWorkerRequests.delete(request.id);
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    }).catch(async (error) => {
        if (serializationWorker === worker) {
            resetWorker();
        }
        return runDirect(request).catch(() => {
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
