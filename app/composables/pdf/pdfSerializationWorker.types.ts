import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IPdfSerializationSavePayload } from '@app/composables/pdf/pdfSerializationOperations';

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

type TSerializationWorkerRequest = {
    [K in TSerializationWorkerRequestType]: ISerializationWorkerRequest<K>;
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

export type {
    ISerializationWorkerRequestMap,
    ISerializationWorkerRequest,
    TSerializationWorkerRequest,
    TSerializationWorkerRequestType,
    TSerializationWorkerResponse,
};
