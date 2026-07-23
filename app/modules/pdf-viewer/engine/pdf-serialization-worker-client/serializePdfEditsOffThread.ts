import type { IPdfSerializationSavePayload } from '@app/modules/pdf-viewer/engine/pdf-serialization-operations/pdfSerializationSavePayload';
import type { ISerializationWorkerBinaryInput } from '@app/modules/pdf-viewer/engine/canonicalAnnotationIdentityBindingWorkerResult.types';
import { runSerializationWorkerRequest } from '@app/modules/pdf-viewer/engine/pdf-serialization-worker-client/runSerializationWorkerRequest';

export async function serializePdfEditsOffThread(
    input: Uint8Array | ISerializationWorkerBinaryInput,
    payload: IPdfSerializationSavePayload,
) {
    const binaryInput = input instanceof Uint8Array
        ? {
            bytes: input,
            ownership: 'borrowed' as const,
        }
        : input;
    return runSerializationWorkerRequest('save', {
        data: binaryInput.bytes,
        payload,
    }, binaryInput);
}
