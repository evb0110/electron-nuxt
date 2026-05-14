import type {
    TSerializationWorkerRequest,
    TSerializationWorkerResponse,
} from '@app/composables/pdf/pdfSerializationWorker.types';
import {
    deleteEmbeddedAnnotation,
    serializePdfEdits,
    updateEmbeddedAnnotationText,
} from '@app/composables/pdf/pdfSerializationOperations';
import { getErrorMessage } from '@app/utils/error';

function toTransferableUint8Array(data: Uint8Array) {
    if (
        data.byteOffset === 0
        && data.byteLength === data.buffer.byteLength
    ) {
        return data;
    }

    return data.slice();
}

async function handleRequest(
    request: TSerializationWorkerRequest,
) {
    switch (request.type) {
        case 'save':
            return serializePdfEdits(request.payload.data, request.payload.payload);
        case 'updateEmbeddedText':
            return updateEmbeddedAnnotationText(
                request.payload.data,
                request.payload.comment,
                request.payload.text,
            );
        case 'deleteEmbeddedAnnotation':
            return deleteEmbeddedAnnotation(
                request.payload.data,
                request.payload.comment,
            );
        default:
            throw new Error(`Unsupported PDF serialization worker request: ${(request as TSerializationWorkerRequest).type}`);
    }
}

self.addEventListener('message', async (event: MessageEvent<TSerializationWorkerRequest>) => {
    const request = event.data;

    try {
        const data = await handleRequest(request);
        const transferableData = data ? toTransferableUint8Array(data) : null;
        const response = {
            id: request.id,
            ok: true,
            data: transferableData,
        } satisfies TSerializationWorkerResponse;
        self.postMessage(
            response,
            transferableData ? [transferableData.buffer] : [],
        );
    } catch (error) {
        const response = {
            id: request.id,
            ok: false,
            error: getErrorMessage(error),
        } satisfies TSerializationWorkerResponse;
        self.postMessage(response);
    }
});
