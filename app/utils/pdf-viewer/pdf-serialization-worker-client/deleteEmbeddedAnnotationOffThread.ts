import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { runSerializationWorkerRequest } from '@app/utils/pdf-viewer/pdf-serialization-worker-client/runSerializationWorkerRequest';

export async function deleteEmbeddedAnnotationOffThread(
    data: Uint8Array,
    comment: IAnnotationCommentSummary,
) {
    return runSerializationWorkerRequest('deleteEmbeddedAnnotation', {
        data,
        comment,
    });
}
