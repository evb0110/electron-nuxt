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
        const response: TSerializationWorkerResponse = {
            id: request.id,
            ok: true,
            data,
        };
        self.postMessage(response);
    } catch (error) {
        const response: TSerializationWorkerResponse = {
            id: request.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
        self.postMessage(response);
    }
});
