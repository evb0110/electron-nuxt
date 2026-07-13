import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IPdfSerializationSavePayload } from '@app/modules/pdf-viewer/engine/pdf-serialization-operations/pdfSerializationSavePayload';
import type {
    ICanonicalAnnotationIdentityBinding,
    ICanonicalAnnotationIdentityBindingEvidence,
} from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-annotations/applyCanonicalAnnotationIdentityBindings';

export interface ICanonicalAnnotationIdentityBindingWorkerResult {
    data: Uint8Array;
    identityBindings: ICanonicalAnnotationIdentityBinding[];
}

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
    bindCanonicalAnnotationIdentities: {
        data: Uint8Array;
        comments: readonly IAnnotationCommentSummary[];
        program: IPdfSerializationSavePayload['canonicalAnnotationProgram'];
        evidence: Omit<ICanonicalAnnotationIdentityBindingEvidence, 'onIdentityBound'>;
    };
}

interface ISerializationWorkerResultMap {
    save: Uint8Array | null;
    updateEmbeddedText: Uint8Array | null;
    deleteEmbeddedAnnotation: Uint8Array | null;
    bindCanonicalAnnotationIdentities: ICanonicalAnnotationIdentityBindingWorkerResult;
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
        data: ISerializationWorkerResultMap[TSerializationWorkerRequestType];
    }
    | {
        id: number;
        ok: false;
        error: string;
    };

export type {
    ISerializationWorkerRequestMap,
    ISerializationWorkerResultMap,
    ISerializationWorkerRequest,
    TSerializationWorkerRequest,
    TSerializationWorkerRequestType,
    TSerializationWorkerResponse,
};
