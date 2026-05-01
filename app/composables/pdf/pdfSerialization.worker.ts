import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IPdfSerializationSavePayload } from '@app/composables/pdf/pdfSerializationOperations';
import {
    deleteEmbeddedAnnotation,
    serializePdfEdits,
    updateEmbeddedAnnotationText,
} from '@app/composables/pdf/pdfSerializationOperations';
import { getErrorMessage } from '@app/utils/error';

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

type TSerializationWorkerRequest = {
    [K in TSerializationWorkerRequestType]: {
        id: number;
        type: K;
        payload: ISerializationWorkerRequestMap[K];
    };
}[TSerializationWorkerRequestType];

type TSerializationWorkerResponse =
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
        const response: TSerializationWorkerResponse = {
            id: request.id,
            ok: true,
            data: transferableData,
        };
        self.postMessage(
            response,
            transferableData ? [transferableData.buffer] : [],
        );
    } catch (error) {
        const response: TSerializationWorkerResponse = {
            id: request.id,
            ok: false,
            error: getErrorMessage(error),
        };
        self.postMessage(response);
    }
});
