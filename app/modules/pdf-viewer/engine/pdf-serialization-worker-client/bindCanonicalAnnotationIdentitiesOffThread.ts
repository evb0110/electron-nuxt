import type {IAnnotationCommentSummary} from '@app/types/annotations';
import type {IBackendAnnotationMutation} from '@app/modules/pdf-viewer/engine/annotations/persistence/backendAnnotationMutation';
import type {ICanonicalAnnotationIdentityBindingEvidence} from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-annotations/applyCanonicalAnnotationIdentityBindings';
import {runSerializationWorkerRequest} from '@app/modules/pdf-viewer/engine/pdf-serialization-worker-client/runSerializationWorkerRequest';

export async function bindCanonicalAnnotationIdentitiesOffThread(
    data: Uint8Array,
    comments: readonly IAnnotationCommentSummary[],
    program: readonly IBackendAnnotationMutation[],
    evidence: ICanonicalAnnotationIdentityBindingEvidence = {},
) {
    const {
        onIdentityBound,
        ...serializableEvidence
    } = evidence;
    const result = await runSerializationWorkerRequest('bindCanonicalAnnotationIdentities', {
        data,
        comments,
        program,
        evidence: serializableEvidence,
    });
    result.identityBindings.forEach(binding => onIdentityBound?.(binding));
    return result;
}
