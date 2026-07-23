import type {
    ISerializationWorkerBinaryInput,
    ISerializationWorkerRequest,
    ISerializationWorkerRequestMap,
    ISerializationWorkerResultMap,
    TSerializationWorkerRequest,
    TSerializationWorkerRequestType,
} from '@app/modules/pdf-viewer/engine/canonicalAnnotationIdentityBindingWorkerResult.types';
import { isRecord } from '@contracts/runtimeGuards';
import { yieldToBrowser } from '@app/utils/yieldToBrowser';
import { readDocumentBytes } from '@app/utils/documentBytes';
import { getDocumentFilesCapability } from '@app/utils/platformDocuments';
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
const SERIALIZATION_WORKER_BASE_REQUEST_TIMEOUT_MS = 30_000;
const SERIALIZATION_WORKER_MAX_REQUEST_TIMEOUT_MS = 10 * 60_000;
const SERIALIZATION_WORKER_TIMEOUT_BYTES_PER_STEP = 8 * 1024 * 1024;
const SERIALIZATION_WORKER_TIMEOUT_STEP_MS = 5_000;
const SERIALIZATION_WORKER_COPY_CHUNK_BYTES = 8 * 1024 * 1024;
const SERIALIZATION_WORKER_MAX_INPUT_BYTES = 512 * 1024 * 1024;
const SERIALIZATION_WORKER_MAX_QUEUED_REQUESTS = 4;
let serializationRequestTail = Promise.resolve();
let serializationRequestCount = 0;

function resolveSerializationWorkerRequestTimeoutMs(request: TSerializationWorkerRequest) {
    const payload = isRecord(request.payload) ? request.payload : null;
    const inputBytes = payload?.data instanceof Uint8Array ? payload.data.byteLength : 0;
    const extraSteps = Math.max(
        0,
        Math.ceil(inputBytes / SERIALIZATION_WORKER_TIMEOUT_BYTES_PER_STEP) - 1,
    );
    return Math.min(
        SERIALIZATION_WORKER_MAX_REQUEST_TIMEOUT_MS,
        SERIALIZATION_WORKER_BASE_REQUEST_TIMEOUT_MS + extraSteps * SERIALIZATION_WORKER_TIMEOUT_STEP_MS,
    );
}

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

function decodeCanonicalIdentityBindingWorkerResult(
    data: unknown,
): ISerializationWorkerResultMap['bindCanonicalAnnotationIdentities'] | undefined {
    if (
        !isRecord(data)
        || !(data.data instanceof Uint8Array)
        || !Array.isArray(data.identityBindings)
    ) {
        return undefined;
    }
    const identityBindings = Array.from<unknown>(data.identityBindings);
    if (
        !identityBindings.every((binding): binding is {
            annotationId: string;
            pdfRef: string;
        } => (
            isRecord(binding)
            && typeof binding.annotationId === 'string'
            && typeof binding.pdfRef === 'string'
        ))
    ) {
        return undefined;
    }
    return {
        data: data.data,
        identityBindings,
    };
}

async function toTransferableUint8Array(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    // Never transfer the caller's live buffer into the worker. The save path
    // can pass reactive PDF state here, and transferring that buffer would
    // detach it on the main thread before the save completes.
    if (data.byteLength > SERIALIZATION_WORKER_MAX_INPUT_BYTES) {
        throw new RangeError('PDF serialization input exceeds the 512 MiB worker limit');
    }
    const copy = new Uint8Array(data.byteLength);
    for (let offset = 0; offset < data.byteLength; offset += SERIALIZATION_WORKER_COPY_CHUNK_BYTES) {
        copy.set(
            data.subarray(offset, Math.min(data.byteLength, offset + SERIALIZATION_WORKER_COPY_CHUNK_BYTES)),
            offset,
        );
        if (offset > 0) await yieldToBrowser();
    }
    return copy;
}

function canTransferOwnedInput(input: ISerializationWorkerBinaryInput | undefined) {
    const bytes = input?.bytes;
    return input?.ownership === 'disposable'
        && input.revision !== undefined
        && input.reloadPath !== undefined
        && bytes?.buffer instanceof ArrayBuffer
        && bytes.byteOffset === 0
        && bytes.byteLength === bytes.buffer.byteLength;
}

async function resolveTransferableData(
    data: Uint8Array,
    input: ISerializationWorkerBinaryInput | undefined,
) {
    if (input?.bytes === data && canTransferOwnedInput(input)) {
        if (data.byteLength > SERIALIZATION_WORKER_MAX_INPUT_BYTES) {
            throw new RangeError('PDF serialization input exceeds the 512 MiB worker limit');
        }
        return data as Uint8Array<ArrayBuffer>;
    }
    return toTransferableUint8Array(data);
}

async function buildWorkerRequestWithTransfers(
    request: TSerializationWorkerRequest,
    binaryInput: ISerializationWorkerBinaryInput | undefined,
) {
    switch (request.type) {
        case 'save': {
            const payload = request.payload;
            const transferableData = await resolveTransferableData(payload.data, binaryInput);
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
            const transferableData = await toTransferableUint8Array(payload.data);
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
            const transferableData = await toTransferableUint8Array(payload.data);
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
        case 'bindCanonicalAnnotationIdentities': {
            const payload = request.payload;
            const transferableData = await toTransferableUint8Array(payload.data);
            return {
                request: {
                    ...request,
                    payload: {
                        ...payload,
                        data: transferableData,
                    },
                } satisfies ISerializationWorkerRequest<'bindCanonicalAnnotationIdentities'>,
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

async function reloadDisposableInput(input: ISerializationWorkerBinaryInput) {
    const path = input.reloadPath;
    const revision = input.revision;
    if (path === undefined || revision === undefined) {
        throw new Error('Detached serialization input cannot be reloaded without an exact working-copy revision');
    }
    const documentFiles = getDocumentFilesCapability();
    const before = await documentFiles.getDocumentRevision(path);
    if (before.token !== revision) {
        throw new Error('Serialization fallback working-copy revision changed before reload');
    }
    const bytes = await readDocumentBytes(path);
    const after = await documentFiles.getDocumentRevision(path);
    if (after.token !== revision) {
        throw new Error('Serialization fallback working-copy revision changed during reload');
    }
    return bytes;
}

async function prepareDirectFallbackRequest(
    request: TSerializationWorkerRequest,
    binaryInput: ISerializationWorkerBinaryInput | undefined,
) {
    if (
        !binaryInput
        || binaryInput.ownership !== 'disposable'
        || binaryInput.bytes.byteLength > 0
    ) {
        return request;
    }
    if (request.type !== 'save') {
        throw new Error('Disposable serialization input is only supported for full save requests');
    }
    const data = await reloadDisposableInput(binaryInput);
    return {
        ...request,
        payload: {
            ...request.payload,
            data,
        },
    } satisfies ISerializationWorkerRequest<'save'>;
}

const serializationWorkerClient = new BrowserWorkerClient<IPendingBrowserWorkerRequest>({
    idleTtlMs: SERIALIZATION_WORKER_IDLE_TTL_MS,
    requestTimeoutMs: SERIALIZATION_WORKER_BASE_REQUEST_TIMEOUT_MS,
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
            return await serializePdfEdits(payload.data, payload.payload)
                ?? payload.data;
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
        case 'bindCanonicalAnnotationIdentities': {
            const { payload } = request;
            const { bindCanonicalAnnotationIdentitiesInBytes } = await import(
                '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-annotations/applyCanonicalAnnotationIdentityBindings'
            );
            const identityBindings: ISerializationWorkerResultMap['bindCanonicalAnnotationIdentities']['identityBindings'] = [];
            const data = await bindCanonicalAnnotationIdentitiesInBytes(
                payload.data,
                payload.comments,
                payload.program ?? [],
                {
                    ...payload.evidence,
                    onIdentityBound: binding => identityBindings.push(binding),
                },
            );
            return {
                data,
                identityBindings,
            };
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

async function runSerializationWorkerRequestInternal<K extends TSerializationWorkerRequestType>(
    type: K,
    payload: ISerializationWorkerRequestMap[K],
    binaryInput: ISerializationWorkerBinaryInput | undefined,
): Promise<ISerializationWorkerResultMap[K]> {
    const request: ISerializationWorkerRequest<K> = {
        id: serializationWorkerClient.createRequestId(),
        type,
        payload,
    };
    const typedRequest = request as TSerializationWorkerRequest;

    if (!canUseBrowserWorker()) {
        return runDirectWithYield(typedRequest) as Promise<ISerializationWorkerResultMap[K]>;
    }

    let worker: Worker;
    try {
        worker = serializationWorkerClient.getWorker();
    } catch {
        return runDirectWithYield(typedRequest) as Promise<ISerializationWorkerResultMap[K]>;
    }

    const workerRequest = await buildWorkerRequestWithTransfers(typedRequest, binaryInput);
    const requestTimeoutMs = resolveSerializationWorkerRequestTimeoutMs(typedRequest);
    return new Promise<ISerializationWorkerResultMap[K]>((resolve, reject) => {
        serializationWorkerClient.clearIdleTerminateTimer();

        serializationWorkerClient.registerPendingRequest(request.id, {
            requestType: type,
            resolveData: (data) => {
                if (type === 'bindCanonicalAnnotationIdentities') {
                    const decoded = decodeCanonicalIdentityBindingWorkerResult(data);
                    if (!decoded) {
                        return false;
                    }
                    resolve(decoded as ISerializationWorkerResultMap[K]);
                    return true;
                }
                const decoded = decodeSerializationWorkerResult(data);
                if (decoded === undefined) {
                    return false;
                }
                resolve(decoded as ISerializationWorkerResultMap[K]);
                return true;
            },
            reject,
        }, () => new PdfSerializationWorkerTimeoutError(
            `PDF serialization worker did not reply within ${requestTimeoutMs}ms (type=${request.type})`,
        ), requestTimeoutMs);

        try {
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
            throw error;
        }

        if (serializationWorkerClient.isActiveWorker(worker)) {
            serializationWorkerClient.resetWorker();
        }
        const fallbackRequest = await prepareDirectFallbackRequest(typedRequest, binaryInput);
        try {
            return await runDirectWithYield(fallbackRequest) as ISerializationWorkerResultMap[K];
        } catch (fallbackError) {
            if (binaryInput?.ownership === 'disposable' && binaryInput.bytes.byteLength === 0) {
                throw fallbackError;
            }
            throw error;
        }
    });
}

export async function runSerializationWorkerRequest<K extends TSerializationWorkerRequestType>(
    type: K,
    payload: ISerializationWorkerRequestMap[K],
    binaryInput?: ISerializationWorkerBinaryInput,
): Promise<ISerializationWorkerResultMap[K]> {
    if (serializationRequestCount >= SERIALIZATION_WORKER_MAX_QUEUED_REQUESTS) {
        throw new Error('PDF serialization queue is full; wait for the active save to finish');
    }
    serializationRequestCount += 1;
    const predecessor = serializationRequestTail;
    let releaseQueueSlot!: () => void;
    serializationRequestTail = new Promise<void>((resolve) => {
        releaseQueueSlot = resolve;
    });
    await predecessor;
    try {
        return await runSerializationWorkerRequestInternal(type, payload, binaryInput);
    } finally {
        serializationRequestCount -= 1;
        releaseQueueSlot();
    }
}
