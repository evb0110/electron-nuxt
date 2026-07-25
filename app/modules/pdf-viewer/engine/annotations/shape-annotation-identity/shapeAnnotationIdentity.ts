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

function comparableNumber(value: number | null | undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }
    return Number(value.toFixed(6));
}

function comparablePoints(points: IShapeAnnotation['points']) {
    return points?.map(point => ({
        x: comparableNumber(point.x),
        y: comparableNumber(point.y),
    })) ?? null;
}

/** Geometry-only identity used when neither a stable key nor a PDF ref matches. */
function shapeGeometryReconciliationKey(shape: IShapeAnnotation) {
    return JSON.stringify({
        color: shape.color,
        fillColor: shape.fillColor ?? null,
        height: comparableNumber(shape.height),
        lineEndStyle: shape.lineEndStyle ?? null,
        lineStartStyle: shape.lineStartStyle ?? null,
        opacity: comparableNumber(shape.opacity),
        pageIndex: shape.pageIndex,
        pdfSubtype: shape.pdfSubtype ?? null,
        stableKey: getNormalizedShapeStableKey(shape) ?? null,
        points: comparablePoints(shape.points),
        strokes: shape.strokes?.map(points => comparablePoints(points)) ?? null,
        strokeWidth: comparableNumber(shape.strokeWidth),
        type: shape.type,
        width: comparableNumber(shape.width),
        x: comparableNumber(shape.x),
        x2: comparableNumber(shape.x2),
        y: comparableNumber(shape.y),
        y2: comparableNumber(shape.y2),
    });
}

/**
 * Matches a shape the app already owns against a freshly imported document scan,
 * preferring durable refs over geometry so a re-serialized annotation keeps its
 * canonical identity even when the PDF assigned it a new object number.
 */
export function findImportedShapeMatchIndex(
    current: IShapeAnnotation,
    imported: readonly IShapeAnnotation[],
) {
    const currentStableKey = getNormalizedShapeStableKey(current);
    const stableKeyIndex = currentStableKey
        ? imported.findIndex(shape => getNormalizedShapeStableKey(shape) === currentStableKey)
        : -1;
    if (stableKeyIndex !== -1) {
        return stableKeyIndex;
    }

    const currentAnnotationId = getNormalizedShapeAnnotationId(current);
    const annotationIdIndex = currentAnnotationId
        ? imported.findIndex(shape => getNormalizedShapeAnnotationId(shape) === currentAnnotationId)
        : -1;
    if (annotationIdIndex !== -1) {
        return annotationIdIndex;
    }

    const geometryKey = shapeGeometryReconciliationKey(current);
    return imported.findIndex(shape => shapeGeometryReconciliationKey(shape) === geometryKey);
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
