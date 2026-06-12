import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { runSerializationWorkerRequest } from '@app/modules/pdf-viewer/engine/pdf-serialization-worker-client/runSerializationWorkerRequest';

export async function updateEmbeddedAnnotationTextOffThread(
    data: Uint8Array,
    comment: IAnnotationCommentSummary,
    text: string,
) {
    return runSerializationWorkerRequest('updateEmbeddedText', {
        data,
        comment,
        text,
    });
}
