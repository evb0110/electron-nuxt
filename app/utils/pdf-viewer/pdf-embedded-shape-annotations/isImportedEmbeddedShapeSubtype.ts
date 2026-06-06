import type { TEmbeddedPdfShapeSubtype } from '@app/types/annotations';

const IMPORTED_SHAPE_SUBTYPES = new Set<TEmbeddedPdfShapeSubtype>([
    'Square',
    'Circle',
    'Line',
    'PolyLine',
    'Polygon',
    'Ink',
]);

function normalizeImportedShapeSubtype(
    subtype: string | null | undefined,
): TEmbeddedPdfShapeSubtype | null {
    switch ((subtype ?? '').trim()) {
        case 'Square':
        case 'Circle':
        case 'Line':
        case 'PolyLine':
        case 'Polygon':
        case 'Ink':
            return subtype as TEmbeddedPdfShapeSubtype;
        default:
            return null;
    }
}

export function isImportedEmbeddedShapeSubtype(subtype: string | null | undefined) {
    const normalizedSubtype = normalizeImportedShapeSubtype(subtype);
    return normalizedSubtype ? IMPORTED_SHAPE_SUBTYPES.has(normalizedSubtype) : false;
}
