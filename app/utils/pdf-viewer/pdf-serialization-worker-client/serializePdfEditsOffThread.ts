import type { IPdfSerializationSavePayload } from '@app/utils/pdf-viewer/pdf-serialization-operations/pdfSerializationSavePayload';
import { runSerializationWorkerRequest } from '@app/utils/pdf-viewer/pdf-serialization-worker-client/runSerializationWorkerRequest';

export async function serializePdfEditsOffThread(
    data: Uint8Array,
    payload: IPdfSerializationSavePayload,
) {
    return runSerializationWorkerRequest('save', {
        data,
        payload,
    });
}
