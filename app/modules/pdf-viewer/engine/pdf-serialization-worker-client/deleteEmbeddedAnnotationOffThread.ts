import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { runSerializationWorkerRequest } from '@app/modules/pdf-viewer/engine/pdf-serialization-worker-client/runSerializationWorkerRequest';

export async function deleteEmbeddedAnnotationOffThread(
    data: Uint8Array,
    comment: IAnnotationCommentSummary,
) {
    return runSerializationWorkerRequest('deleteEmbeddedAnnotation', {
        data,
        comment,
    });
}
