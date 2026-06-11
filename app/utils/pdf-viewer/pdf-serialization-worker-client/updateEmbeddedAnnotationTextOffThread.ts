import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { runSerializationWorkerRequest } from '@app/utils/pdf-viewer/pdf-serialization-worker-client/runSerializationWorkerRequest';

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
