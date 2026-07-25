import type { IShapeAnnotation } from '@app/types/annotations';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import type { IPdfNativeShapeAnnotation } from '@contracts/electronApiDocuments';
import { requirePageIndex } from '@contracts/pageNumbers';
import {
    PDF_ANNOTATION_LINE_END_STYLES,
    PDF_ANNOTATION_SHAPE_PDF_SUBTYPES,
    PDF_ANNOTATION_SHAPE_TYPES,
} from '@contracts/annotations';

const NATIVE_SHAPE_TYPES = new Set(PDF_ANNOTATION_SHAPE_TYPES);
const NATIVE_SHAPE_PDF_SUBTYPES = new Set(PDF_ANNOTATION_SHAPE_PDF_SUBTYPES);
const NATIVE_SHAPE_LINE_END_STYLES = new Set(PDF_ANNOTATION_LINE_END_STYLES);

function isFiniteUnitNumber(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isFiniteNonNegativeNumber(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function areNativeShapePointsEligible(points: IShapeAnnotation['points']) {
    return Array.isArray(points)
        && points.length >= 2
        && points.every(point => isFiniteUnitNumber(point.x) && isFiniteUnitNumber(point.y));
}

function areNativeShapeStrokesEligible(strokes: IShapeAnnotation['strokes']) {
    return Array.isArray(strokes)
        && strokes.length > 0
        && strokes.every(points => areNativeShapePointsEligible(points));
}

function hasNativeShapeRectGeometry(shape: IShapeAnnotation) {
    return isFiniteUnitNumber(shape.x)
        && isFiniteUnitNumber(shape.y)
        && isFiniteNonNegativeNumber(shape.width)
        && isFiniteNonNegativeNumber(shape.height)
        && shape.width > 0
        && shape.height > 0
        && shape.x + shape.width <= 1
        && shape.y + shape.height <= 1;
}

function hasNativeShapeLineGeometry(shape: IShapeAnnotation) {
    return isFiniteUnitNumber(shape.x)
        && isFiniteUnitNumber(shape.y)
        && isFiniteUnitNumber(shape.x2)
        && isFiniteUnitNumber(shape.y2);
}

export function isNativeShapeEligible(shape: IShapeAnnotation, totalPageCount: number) {
    if (
        !NATIVE_SHAPE_TYPES.has(shape.type)
        || !Number.isSafeInteger(shape.pageIndex)
        || shape.pageIndex < 0
        || shape.pageIndex >= totalPageCount
        || typeof shape.color !== 'string'
        || !isFiniteNonNegativeNumber(shape.strokeWidth)
        || !isFiniteUnitNumber(shape.opacity)
        || (
            shape.pdfSubtype !== undefined
            && shape.pdfSubtype !== null
            && !NATIVE_SHAPE_PDF_SUBTYPES.has(shape.pdfSubtype)
        )
        || (
            shape.lineStartStyle !== undefined
            && !NATIVE_SHAPE_LINE_END_STYLES.has(shape.lineStartStyle)
        )
        || (
            shape.lineEndStyle !== undefined
            && !NATIVE_SHAPE_LINE_END_STYLES.has(shape.lineEndStyle)
        )
    ) {
        return false;
    }

    if (shape.type === 'rectangle' || shape.type === 'circle') {
        return hasNativeShapeRectGeometry(shape);
    }
    if (shape.type === 'line' || shape.type === 'arrow') {
        return hasNativeShapeLineGeometry(shape);
    }
    if (shape.pdfSubtype === 'Ink') {
        return areNativeShapeStrokesEligible(shape.strokes)
            || areNativeShapePointsEligible(shape.points);
    }
    return areNativeShapePointsEligible(shape.points);
}

export function toNativeShapeAnnotation(shape: IShapeAnnotation): IPdfNativeShapeAnnotation {
    const nativeShape: IPdfNativeShapeAnnotation = {
        id: shape.id,
        type: shape.type,
        pageIndex: requirePageIndex(shape.pageIndex),
        x: shape.x,
        y: shape.y,
        width: shape.width,
        height: shape.height,
        x2: shape.x2 ?? null,
        y2: shape.y2 ?? null,
        color: shape.color,
        fillColor: shape.fillColor ?? null,
        opacity: shape.opacity,
        strokeWidth: shape.strokeWidth,
        annotationId: normalizePdfJsAnnotationId(shape.annotationId) ?? null,
        stableKey: shape.stableKey ?? null,
        pdfSubtype: shape.pdfSubtype ?? null,
        lineStartStyle: shape.lineStartStyle ?? null,
        lineEndStyle: shape.lineEndStyle ?? null,
        createdAt: typeof shape.createdAt === 'number' && Number.isFinite(shape.createdAt)
            ? Math.trunc(shape.createdAt)
            : null,
        modifiedAt: typeof shape.modifiedAt === 'number' && Number.isFinite(shape.modifiedAt)
            ? Math.trunc(shape.modifiedAt)
            : null,
    };
    if (shape.points) {
        nativeShape.points = shape.points.map(point => ({...point}));
    }
    if (shape.strokes) {
        nativeShape.strokes = shape.strokes.map(points => points.map(point => ({...point})));
    }
    return nativeShape;
}

export function buildNativeShapesMutationForSave(opts: {
    shapeStateDirty: boolean;
    rewriteShapeState: boolean;
    totalPageCount: number;
    shapes: IShapeAnnotation[] | null;
    deletedAnnotationIds: string[];
    deletedStableKeys: string[];
}) {
    if (!opts.shapeStateDirty) {
        return null;
    }
    if (!opts.shapes || opts.totalPageCount <= 0) {
        return null;
    }
    if (!opts.shapes.every(shape => isNativeShapeEligible(shape, opts.totalPageCount))) {
        return null;
    }

    return {
        totalPages: opts.totalPageCount,
        rewriteShapeState: opts.rewriteShapeState,
        shapes: opts.shapes.map(toNativeShapeAnnotation),
        deletedAnnotationIds: opts.deletedAnnotationIds,
        deletedStableKeys: opts.deletedStableKeys,
    };
}
