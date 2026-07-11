import type {
    IShapeAnnotation,
    TAnnotationStableKey,
} from '@app/types/annotations';
import { normalizeManagedShapeStableKey } from '@app/modules/pdf-viewer/engine/pdf-serialization-refs/normalizeManagedShapeStableKey';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';

type TShapeIdentityInput = Pick<IShapeAnnotation, 'annotationId' | 'id' | 'pageIndex' | 'stableKey'>;

export function getNormalizedShapeAnnotationId(shape: Pick<IShapeAnnotation, 'annotationId'>) {
    return normalizePdfJsAnnotationId(shape.annotationId);
}

export function getNormalizedShapeStableKey(shape: Pick<IShapeAnnotation, 'stableKey'>) {
    return normalizeManagedShapeStableKey(shape.stableKey);
}

export function computeShapeCommentStableKey(shape: TShapeIdentityInput): TAnnotationStableKey {
    const sourceKey = shape.stableKey ?? shape.annotationId ?? shape.id;
    return `shape:${shape.pageIndex}:${sourceKey}`;
}

export function shapeStableRefsMatch(
    candidate: Pick<IShapeAnnotation, 'annotationId' | 'stableKey'>,
    reference: Pick<IShapeAnnotation, 'annotationId' | 'stableKey'>,
) {
    const candidateStableKey = getNormalizedShapeStableKey(candidate);
    const referenceStableKey = getNormalizedShapeStableKey(reference);
    if (candidateStableKey && referenceStableKey && candidateStableKey === referenceStableKey) {
        return true;
    }

    const candidateAnnotationId = getNormalizedShapeAnnotationId(candidate);
    const referenceAnnotationId = getNormalizedShapeAnnotationId(reference);
    return Boolean(
        candidateAnnotationId
        && referenceAnnotationId
        && candidateAnnotationId === referenceAnnotationId,
    );
}
