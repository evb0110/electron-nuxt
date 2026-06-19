export const PDF_ANNOTATION_MARKUP_SUBTYPES = [
    'Highlight',
    'Underline',
    'StrikeOut',
    'Squiggly',
] as const;

export const PDF_ANNOTATION_SHAPE_TYPES = [
    'rectangle',
    'circle',
    'line',
    'arrow',
    'polyline',
    'polygon',
] as const;

export const PDF_ANNOTATION_SHAPE_PDF_SUBTYPES = [
    'Square',
    'Circle',
    'Line',
    'PolyLine',
    'Polygon',
    'Ink',
] as const;

export const PDF_ANNOTATION_LINE_END_STYLES = [
    'none',
    'openArrow',
    'closedArrow',
] as const;

export type TPdfAnnotationMarkupSubtype = typeof PDF_ANNOTATION_MARKUP_SUBTYPES[number];
export type TPdfAnnotationShapeType = typeof PDF_ANNOTATION_SHAPE_TYPES[number];
export type TPdfAnnotationShapePdfSubtype = typeof PDF_ANNOTATION_SHAPE_PDF_SUBTYPES[number];
export type TPdfAnnotationLineEndStyle = typeof PDF_ANNOTATION_LINE_END_STYLES[number];
