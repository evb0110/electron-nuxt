import type { IPdfSerializationSavePayload } from '@app/modules/pdf-viewer/engine/pdf-serialization-operations/pdfSerializationSavePayload';
import { runSerializationWorkerRequest } from '@app/modules/pdf-viewer/engine/pdf-serialization-worker-client/runSerializationWorkerRequest';

export async function serializePdfEditsOffThread(
    data: Uint8Array,
    payload: IPdfSerializationSavePayload,
) {
    return runSerializationWorkerRequest('save', {
        data,
        payload,
    });
}
