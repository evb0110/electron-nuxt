import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
} from '@app/types/annotations';
import { normalizeMarkerRect } from '@app/composables/pdf/annotationGeometry';
import { getShapeRect } from '@app/composables/pdf/pdfShapeResize';

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

export function toShapeAnnotationCommentSummary(shape: IShapeAnnotation): IAnnotationCommentSummary {
    const rect = getShapeRect(shape, { rectFallbackMinSize: 0.01 });
    const sourceKey = shape.stableKey ?? shape.annotationId ?? shape.id;
    return {
        id: shape.id,
        stableKey: `shape:${shape.pageIndex}:${sourceKey}`,
        sortIndex: null,
        pageIndex: shape.pageIndex,
        pageNumber: shape.pageIndex + 1,
        text: '',
        previewText: null,
        kindLabel: null,
        subtype: resolveShapeSubtype(shape),
        author: null,
        modifiedAt: null,
        color: shape.color,
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

