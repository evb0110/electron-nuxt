import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
} from '@app/types/annotations';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import { getShapeRect } from '@app/modules/pdf-viewer/engine/pdf-shape-resize/getShapeRect';
import { computeShapeCommentStableKey } from '@app/modules/pdf-viewer/engine/annotations/shape-annotation-identity/shapeAnnotationIdentity';

function resolveShapeSubtype(shape: IShapeAnnotation) {
    if (shape.type === 'arrow') {
        return 'Arrow';
    }
    if (shape.pdfSubtype) {
        return shape.pdfSubtype;
    }
    if (shape.type === 'rectangle') {
        return 'Square';
    }
    if (shape.type === 'polyline') {
        return 'Ink';
    }
    return shape.type.charAt(0).toUpperCase() + shape.type.slice(1);
}

export function toShapeAnnotationCommentSummary(
    shape: IShapeAnnotation,
    sortIndex: number | null = null,
): IAnnotationCommentSummary {
    const rect = getShapeRect(shape, { rectFallbackMinSize: 0.01 });
    return {
        id: shape.id,
        stableKey: computeShapeCommentStableKey(shape),
        sortIndex,
        pageIndex: shape.pageIndex,
        pageNumber: shape.pageIndex + 1,
        text: '',
        previewText: null,
        kindLabel: null,
        subtype: resolveShapeSubtype(shape),
        author: null,
        createdAt: shape.createdAt ?? shape.modifiedAt ?? null,
        modifiedAt: shape.modifiedAt ?? null,
        color: shape.color,
        fillColor: shape.fillColor ?? null,
        opacity: shape.opacity,
        strokeWidth: shape.strokeWidth,
        uid: null,
        annotationId: shape.annotationId ?? null,
        source: 'shape',
        hasNote: false,
        markerRect: normalizeMarkerRect({
            left: rect.x,
            top: rect.y,
            width: rect.width,
            height: rect.height,
        }),
    };
}
