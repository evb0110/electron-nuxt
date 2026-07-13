import type {
    TSerializationWorkerRequest,
    TSerializationWorkerResponse,
} from '@app/modules/pdf-viewer/engine/canonicalAnnotationIdentityBindingWorkerResult.types';
import { deleteEmbeddedAnnotation } from '@app/modules/pdf-viewer/engine/pdf-serialization-operations/deleteEmbeddedAnnotation';
import { serializePdfEdits } from '@app/modules/pdf-viewer/engine/pdf-serialization-operations/serializePdfEdits';
import { updateEmbeddedAnnotationText } from '@app/modules/pdf-viewer/engine/pdf-serialization-operations/updateEmbeddedAnnotationText';
import {
    bindCanonicalAnnotationIdentitiesInBytes,
    type ICanonicalAnnotationIdentityBinding,
} from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-annotations/applyCanonicalAnnotationIdentityBindings';
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
        case 'bindCanonicalAnnotationIdentities': {
            const identityBindings: ICanonicalAnnotationIdentityBinding[] = [];
            const data = await bindCanonicalAnnotationIdentitiesInBytes(
                request.payload.data,
                request.payload.comments,
                request.payload.program ?? [],
                {
                    ...request.payload.evidence,
                    onIdentityBound: binding => identityBindings.push(binding),
                },
            );
            return {
                data,
                identityBindings,
            };
        }
        default:
            throw new Error(`Unsupported PDF serialization worker request: ${(request as TSerializationWorkerRequest).type}`);
    }
}

self.addEventListener('message', async (event: MessageEvent<TSerializationWorkerRequest>) => {
    const request = event.data;

    try {
        const data = await handleRequest(request);
        const transferableData = data instanceof Uint8Array
            ? toTransferableUint8Array(data)
            : data === null
                ? null
                : toTransferableUint8Array(data.data);
        const responseData = data === null || data instanceof Uint8Array
            ? transferableData
            : {
                ...data,
                data: transferableData!,
            };
        const response = {
            id: request.id,
            ok: true,
            data: responseData,
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
