import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFName,
    PDFNumber,
} from 'pdf-lib';
import type { PDFRef } from 'pdf-lib';
import { clamp } from 'es-toolkit/math';
import type {
    IShapeAnnotation,
    IShapePoint,
    TEmbeddedPdfShapeSubtype,
    TLineEndStyle,
    TShapeType,
} from '@app/types/annotations';
import {
    normalizeMarkerRect,
    toMarkerPointFromPdfPoint,
    toMarkerRectFromPdfRect,
} from '@app/composables/pdf/annotationGeometry';
import type { normalizePageRotation } from '@app/composables/pdf/annotationGeometry';
import {
    formatPdfJsAnnotationRef,
    generateManagedShapeStableKey,
    readManagedShapeStableKey,
} from '@app/composables/pdf/pdfSerializationRefs';
import { getAllShapePoints } from '@app/composables/pdf/pdfShapeStrokes';
import { readPdfRectFromDict } from '@app/composables/pdf/pdfPageBoxes';
import {
    computePointsMinMax,
    iterateAnnotationRefDicts,
    resolvePageAnnotationContext,
} from '@app/composables/pdf/pdfPageAnnotationIteration';

const IMPORTED_SHAPE_SUBTYPES = new Set<TEmbeddedPdfShapeSubtype>([
    'Square',
    'Circle',
    'Line',
    'PolyLine',
    'Polygon',
    'Ink',
]);

const BORDER_NAME = PDFName.of('Border');
const BORDER_STYLE_NAME = PDFName.of('BS');
const WIDTH_NAME = PDFName.of('W');
const COLOR_NAME = PDFName.of('C');
const INTERIOR_COLOR_NAME = PDFName.of('IC');
const OPACITY_NAME = PDFName.of('CA');
const LINE_POINTS_NAME = PDFName.of('L');
const VERTICES_NAME = PDFName.of('Vertices');
const INK_LIST_NAME = PDFName.of('InkList');
const LINE_ENDINGS_NAME = PDFName.of('LE');
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

function numberFromPdfArray(array: PDFArray, index: number) {
    const value = array.get(index);
    return value instanceof PDFNumber ? value.asNumber() : null;
}

function numbersFromPdfArray(array: PDFArray) {
    const values: number[] = [];
    for (let index = 0; index < array.size(); index += 1) {
        const value = numberFromPdfArray(array, index);
        if (value === null) {
            return null;
        }
        values.push(value);
    }
    return values;
}

function pointsFromPdfNumberPairs(
    values: number[],
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
) {
    const points: IShapePoint[] = [];
    for (let index = 0; index < values.length; index += 2) {
        const point = toMarkerPointFromPdfPoint(
            values[index]!,
            values[index + 1]!,
            pageView,
            pageRotation,
        );
        if (point) {
            points.push(point);
        }
    }
    return points;
}

function rgbComponentToHex(value: number) {
    return clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
}

function toHexColor(
    color: number[] | null | undefined,
    fallback: string,
) {
    if (!Array.isArray(color) || color.length < 3) {
        return fallback;
    }

    const scale = color.every(component => component >= 0 && component <= 1) ? 255 : 1;
    return `#${rgbComponentToHex((color[0] ?? 0) * scale)}${rgbComponentToHex((color[1] ?? 0) * scale)}${rgbComponentToHex((color[2] ?? 0) * scale)}`;
}

function readColor(dict: PDFDict, key: PDFName) {
    const colorArray = dict.lookupMaybe(key, PDFArray);
    if (!(colorArray instanceof PDFArray)) {
        return null;
    }
    return numbersFromPdfArray(colorArray);
}

function readOpacity(dict: PDFDict) {
    const opacity = dict.lookupMaybe(OPACITY_NAME, PDFNumber);
    if (!(opacity instanceof PDFNumber)) {
        return 1;
    }
    return clamp(opacity.asNumber(), 0, 1);
}

function readBorderWidth(dict: PDFDict) {
    const border = dict.lookupMaybe(BORDER_NAME, PDFArray);
    if (border instanceof PDFArray && border.size() >= 3) {
        const width = numberFromPdfArray(border, 2);
        if (width !== null && width > 0) {
            return width;
        }
    }

    const borderStyle = dict.lookupMaybe(BORDER_STYLE_NAME, PDFDict);
    if (borderStyle instanceof PDFDict) {
        const width = borderStyle.lookupMaybe(WIDTH_NAME, PDFNumber);
        if (width instanceof PDFNumber && width.asNumber() > 0) {
            return width.asNumber();
        }
    }

    return 1;
}

function refToAnnotationId(ref: PDFRef) {
    return formatPdfJsAnnotationRef(ref);
}

function createImportedShapeId(
    pageIndex: number,
    annotationId: string | null,
    stableKey: string | null,
    subtype: TEmbeddedPdfShapeSubtype,
) {
    if (stableKey) {
        return `embedded-shape:${pageIndex}:${stableKey}`;
    }
    if (annotationId) {
        return `embedded-shape:${pageIndex}:${annotationId}`;
    }
    return `embedded-shape:${pageIndex}:${subtype}:${crypto.randomUUID()}`;
}

function toLineEndStyle(value: string | null | undefined): TLineEndStyle | undefined {
    switch ((value ?? '').replace(/^\//, '').trim().toLowerCase()) {
        case 'openarrow':
            return 'openArrow';
        case 'closedarrow':
            return 'closedArrow';
        case 'none':
        case '':
            return 'none';
        default:
            return undefined;
    }
}

function readLineEndingStyles(dict: PDFDict) {
    const lineEndings = dict.lookupMaybe(LINE_ENDINGS_NAME, PDFArray);
    if (!(lineEndings instanceof PDFArray)) {
        return {
            lineStartStyle: undefined,
            lineEndStyle: undefined,
        };
    }

    return {
        lineStartStyle: toLineEndStyle(lineEndings.get(0)?.toString()),
        lineEndStyle: toLineEndStyle(lineEndings.get(1)?.toString()),
    };
}

function toImportedShapeType(
    subtype: TEmbeddedPdfShapeSubtype,
    lineStartStyle?: TLineEndStyle,
    lineEndStyle?: TLineEndStyle,
): TShapeType {
    switch (subtype) {
        case 'Square':
            return 'rectangle';
        case 'Circle':
            return 'circle';
        case 'Line':
            return (lineStartStyle ?? 'none') === 'none' && (lineEndStyle ?? 'none') === 'none'
                ? 'line'
                : 'arrow';
        case 'PolyLine':
            return 'polyline';
        case 'Polygon':
            return 'polygon';
        case 'Ink':
            return 'polyline';
    }
}

function toPointsBounds(points: IShapePoint[]) {
    const bounds = computePointsMinMax(points);
    if (!bounds) {
        return null;
    }

    return {
        x: bounds.minX,
        y: bounds.minY,
        width: Math.max(0.0001, bounds.maxX - bounds.minX),
        height: Math.max(0.0001, bounds.maxY - bounds.minY),
    };
}

function importRectShape(
    dict: PDFDict,
    ref: PDFRef,
    pageIndex: number,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
    subtype: Extract<TEmbeddedPdfShapeSubtype, 'Square' | 'Circle'>,
): IShapeAnnotation | null {
    const markerRect = normalizeMarkerRect(
        toMarkerRectFromPdfRect(readPdfRectFromDict(dict), pageView, pageRotation),
    );
    if (!markerRect) {
        return null;
    }

    const annotationId = refToAnnotationId(ref);
    const stableKey = readManagedShapeStableKey(dict) ?? generateManagedShapeStableKey();
    const fillColor = toHexColor(readColor(dict, INTERIOR_COLOR_NAME), '');
    return {
        id: createImportedShapeId(pageIndex, annotationId, stableKey, subtype),
        type: toImportedShapeType(subtype),
        pageIndex,
        x: markerRect.left,
        y: markerRect.top,
        width: markerRect.width,
        height: markerRect.height,
        color: toHexColor(readColor(dict, COLOR_NAME), '#ff0000'),
        fillColor: fillColor || undefined,
        opacity: readOpacity(dict),
        strokeWidth: readBorderWidth(dict),
        source: 'embedded',
        stableKey,
        annotationId,
        pdfSubtype: subtype,
    };
}

function importLineShape(
    dict: PDFDict,
    ref: PDFRef,
    pageIndex: number,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
): IShapeAnnotation | null {
    const line = dict.lookupMaybe(LINE_POINTS_NAME, PDFArray);
    if (!(line instanceof PDFArray) || line.size() < 4) {
        return null;
    }

    const values = numbersFromPdfArray(line);
    if (!values || values.length < 4) {
        return null;
    }

    const start = toMarkerPointFromPdfPoint(
        values[0]!,
        values[1]!,
        pageView,
        pageRotation,
    );
    const end = toMarkerPointFromPdfPoint(
        values[2]!,
        values[3]!,
        pageView,
        pageRotation,
    );
    if (!start || !end) {
        return null;
    }

    const annotationId = refToAnnotationId(ref);
    const stableKey = readManagedShapeStableKey(dict) ?? generateManagedShapeStableKey();
    const {
        lineStartStyle,
        lineEndStyle,
    } = readLineEndingStyles(dict);

    return {
        id: createImportedShapeId(pageIndex, annotationId, stableKey, 'Line'),
        type: toImportedShapeType('Line', lineStartStyle, lineEndStyle),
        pageIndex,
        x: start.x,
        y: start.y,
        x2: end.x,
        y2: end.y,
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
        color: toHexColor(readColor(dict, COLOR_NAME), '#ff0000'),
        opacity: readOpacity(dict),
        strokeWidth: readBorderWidth(dict),
        source: 'embedded',
        stableKey,
        annotationId,
        pdfSubtype: 'Line',
        lineStartStyle,
        lineEndStyle,
    };
}

function importVerticesShape(
    dict: PDFDict,
    ref: PDFRef,
    pageIndex: number,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
    subtype: Extract<TEmbeddedPdfShapeSubtype, 'PolyLine' | 'Polygon'>,
): IShapeAnnotation | null {
    const vertices = dict.lookupMaybe(VERTICES_NAME, PDFArray);
    if (!(vertices instanceof PDFArray) || vertices.size() < 4) {
        return null;
    }

    const values = numbersFromPdfArray(vertices);
    if (!values || values.length < 4) {
        return null;
    }

    const points = pointsFromPdfNumberPairs(values, pageView, pageRotation);

    if (points.length < 2) {
        return null;
    }

    const bounds = toPointsBounds(points);
    if (!bounds) {
        return null;
    }

    const annotationId = refToAnnotationId(ref);
    const stableKey = readManagedShapeStableKey(dict) ?? generateManagedShapeStableKey();
    const {
        lineStartStyle,
        lineEndStyle,
    } = readLineEndingStyles(dict);
    const fillColor = subtype === 'Polygon'
        ? toHexColor(readColor(dict, INTERIOR_COLOR_NAME), '')
        : '';

    return {
        id: createImportedShapeId(pageIndex, annotationId, stableKey, subtype),
        type: toImportedShapeType(subtype, lineStartStyle, lineEndStyle),
        pageIndex,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        color: toHexColor(readColor(dict, COLOR_NAME), '#ff0000'),
        fillColor: fillColor || undefined,
        opacity: readOpacity(dict),
        strokeWidth: readBorderWidth(dict),
        points,
        source: 'embedded',
        stableKey,
        annotationId,
        pdfSubtype: subtype,
        lineStartStyle,
        lineEndStyle,
    };
}

function importInkShape(
    dict: PDFDict,
    ref: PDFRef,
    pageIndex: number,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
): IShapeAnnotation | null {
    // PDF.js owns native Ink appearance streams; only EVB-authored Ink is safe
    // to rehydrate into the managed SVG overlay without visual drift.
    const stableKey = readManagedShapeStableKey(dict);
    if (!stableKey) {
        return null;
    }

    const inkList = dict.lookupMaybe(INK_LIST_NAME, PDFArray);
    if (!(inkList instanceof PDFArray) || inkList.size() === 0) {
        return null;
    }

    const strokes: IShapePoint[][] = [];
    for (let strokeIndex = 0; strokeIndex < inkList.size(); strokeIndex += 1) {
        const strokeArray = inkList.lookup(strokeIndex, PDFArray);
        if (!(strokeArray instanceof PDFArray) || strokeArray.size() < 4) {
            continue;
        }

        const values = numbersFromPdfArray(strokeArray);
        if (!values || values.length < 4) {
            continue;
        }

        const points = pointsFromPdfNumberPairs(values, pageView, pageRotation);

        if (points.length >= 2) {
            strokes.push(points);
        }
    }

    if (strokes.length === 0) {
        return null;
    }

    const points = strokes[0]!;
    const bounds = toPointsBounds(getAllShapePoints({
        points,
        strokes,
    }));
    if (!bounds) {
        return null;
    }

    const annotationId = refToAnnotationId(ref);
    return {
        id: createImportedShapeId(pageIndex, annotationId, stableKey, 'Ink'),
        type: toImportedShapeType('Ink'),
        pageIndex,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        color: toHexColor(readColor(dict, COLOR_NAME), '#ff0000'),
        opacity: readOpacity(dict),
        strokeWidth: readBorderWidth(dict),
        points,
        strokes,
        source: 'embedded',
        stableKey,
        annotationId,
        pdfSubtype: 'Ink',
    };
}

export function isImportedEmbeddedShapeSubtype(subtype: string | null | undefined) {
    const normalizedSubtype = normalizeImportedShapeSubtype(subtype);
    return normalizedSubtype ? IMPORTED_SHAPE_SUBTYPES.has(normalizedSubtype) : false;
}

export async function importEmbeddedShapeAnnotations(data: Uint8Array) {
    const pdfDocument = await PDFDocument.load(data, { updateMetadata: false });
    const importedShapes: IShapeAnnotation[] = [];

    for (const [
        pageIndex,
        page,
    ] of pdfDocument.getPages().entries()) {
        const context = resolvePageAnnotationContext(page);
        if (!context) {
            continue;
        }

        const {
            pageView,
            pageRotation,
            annots,
        } = context;

        for (const {
            dict,
            ref,
        } of iterateAnnotationRefDicts(pdfDocument, annots)) {
            const rawSubtype = dict.get(PDFName.of('Subtype'))?.toString() ?? null;
            const subtype = normalizeImportedShapeSubtype(rawSubtype?.replace(/^\//, ''));
            if (!subtype) {
                continue;
            }

            const importedShape = (() => {
                switch (subtype) {
                    case 'Square':
                    case 'Circle':
                        return importRectShape(dict, ref, pageIndex, pageView, pageRotation, subtype);
                    case 'Line':
                        return importLineShape(dict, ref, pageIndex, pageView, pageRotation);
                    case 'PolyLine':
                    case 'Polygon':
                        return importVerticesShape(dict, ref, pageIndex, pageView, pageRotation, subtype);
                    case 'Ink':
                        return importInkShape(dict, ref, pageIndex, pageView, pageRotation);
                }
            })();

            if (importedShape) {
                importedShapes.push(importedShape);
            }
        }
    }

    return importedShapes;
}

export function collectEmbeddedShapeAnnotationIds(shapes: IShapeAnnotation[]) {
    const ids = new Set<string>();
    shapes.forEach((shape) => {
        if (shape.source === 'embedded' && shape.annotationId) {
            ids.add(shape.annotationId);
        }
    });
    return ids;
}
