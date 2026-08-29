import {
    PDFDict,
    PDFArray,
    PDFName,
    PDFNumber,
    PDFString,
} from 'pdf-lib';
import type {
    PDFDocument,
    PDFRef,
} from 'pdf-lib';
import type {
    IShapeAnnotation,
    TLineEndStyle,
} from '@app/types/annotations';
import type { normalizePageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizePageRotation';
import { toPdfRectFromMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/toPdfRectFromMarkerRect';
import { getPdfDictSubtype } from '@app/utils/pdfDict';
import { toPdfDateString } from '@app/utils/pdfDate';
import { collectAnnotationRefsToDelete } from '@app/modules/pdf-viewer/engine/pdf-serialization-comments/collectAnnotationRefsToDelete';
import { removeAnnotationRefsFromPages } from '@app/modules/pdf-viewer/engine/pdf-serialization-comments/removeAnnotationRefsFromPages';
import { normalizeManagedShapeStableKey } from '@app/modules/pdf-viewer/engine/pdf-serialization-refs/normalizeManagedShapeStableKey';
import { readManagedShapeStableKey } from '@app/modules/pdf-viewer/engine/pdf-serialization-refs/readManagedShapeStableKey';
import { writeManagedShapeStableKey } from '@app/modules/pdf-viewer/engine/pdf-serialization-refs/writeManagedShapeStableKey';
import {
    formatPdfJsAnnotationRef,
    normalizePdfJsAnnotationId,
} from '@app/utils/pdfAnnotationRefs';
import { lookupAnnotationRefDict } from '@app/modules/pdf-viewer/engine/pdf-page-annotation-iteration/lookupAnnotationRefDict';
import { appendAnnotationRefToPage } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-shared/appendAnnotationRefToPage';
import { setBorderWidth } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-colors/setBorderWidth';
import { setOpacity } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-colors/setOpacity';
import { setRgbColor } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-colors/setRgbColor';
import { resolveShapePageContext } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-geometry/resolveShapePageContext';
import { toPdfBoundsRect } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-geometry/toPdfBoundsRect';
import { toPdfInkList } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-geometry/toPdfInkList';
import { toPdfLinePoints } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-geometry/toPdfLinePoints';
import { toPdfVertexPoints } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-geometry/toPdfVertexPoints';
import { applyInkAnnotationAppearance } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-shape-annotations/applyInkAnnotationAppearance';
import { isImportedShapeRectUnchanged } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-shape-annotations/isImportedShapeRectUnchanged';
import { parsePdfColor } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-colors/parsePdfColor';
import { readPdfRectFromDict } from '@pdf-core';

function updateShapeStyle(annotDict: PDFDict, doc: PDFDocument, shape: IShapeAnnotation) {
    setRgbColor(annotDict, doc, 'C', shape.color);
    setOpacity(annotDict, shape.opacity);
    setBorderWidth(annotDict, doc, shape.strokeWidth);
}

function toShapePdfDate(timestamp: number | null | undefined, fallback: number) {
    const safeTimestamp = typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0
        ? timestamp
        : fallback;
    return PDFString.of(toPdfDateString(new Date(safeTimestamp)));
}

function updateShapeDates(annotDict: PDFDict, shape: IShapeAnnotation) {
    const fallback = Date.now();
    const createdAt = shape.createdAt ?? shape.modifiedAt ?? fallback;
    annotDict.set(PDFName.of('CreationDate'), toShapePdfDate(createdAt, fallback));
    annotDict.set(PDFName.of('M'), toShapePdfDate(shape.modifiedAt ?? createdAt, fallback));
}

function toPdfLineEndingName(style: TLineEndStyle | undefined) {
    switch (style) {
        case 'openArrow':
            return PDFName.of('OpenArrow');
        case 'closedArrow':
            return PDFName.of('ClosedArrow');
        default:
            return PDFName.of('None');
    }
}

function setLineEndings(annotDict: PDFDict, doc: PDFDocument, shape: IShapeAnnotation) {
    const lineStartStyle = shape.lineStartStyle ?? 'none';
    const lineEndStyle = shape.lineEndStyle ?? 'none';
    if (lineStartStyle === 'none' && lineEndStyle === 'none') {
        annotDict.delete(PDFName.of('LE'));
        return;
    }

    annotDict.set(PDFName.of('LE'), doc.context.obj([
        toPdfLineEndingName(lineStartStyle),
        toPdfLineEndingName(lineEndStyle),
    ]));
}

function getShapeMarkerRect(shape: IShapeAnnotation) {
    return {
        left: shape.x,
        top: shape.y,
        width: shape.width,
        height: shape.height,
    };
}

function toFlatPdfPoints(points: ReadonlyArray<{
    x: number;
    y: number;
}>) {
    const values: number[] = [];
    points.forEach((point) => {
        values.push(point.x, point.y);
    });
    return values;
}

function setPdfRect(annotDict: PDFDict, doc: PDFDocument, rect: [number, number, number, number]) {
    annotDict.set(PDFName.of('Rect'), doc.context.obj(rect));
}

function applyRectAnnotationStyle(
    annotDict: PDFDict,
    doc: PDFDocument,
    shape: IShapeAnnotation,
) {
    updateShapeStyle(annotDict, doc, shape);
    setRgbColor(annotDict, doc, 'IC', shape.fillColor);
}

function resolveShapePdfRect(
    shape: IShapeAnnotation,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
) {
    return toPdfRectFromMarkerRect(getShapeMarkerRect(shape), pageView, pageRotation);
}

function resolvePdfLineGeometry(
    shape: IShapeAnnotation,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
) {
    const pdfPoints = toPdfLinePoints(shape, pageView, pageRotation);
    if (!pdfPoints) {
        return null;
    }

    const rect = toPdfBoundsRect(pdfPoints, shape.strokeWidth);
    if (!rect) {
        return null;
    }

    return {
        linePoints: toFlatPdfPoints(pdfPoints),
        rect,
    };
}

function applyLineAnnotationGeometry(
    annotDict: PDFDict,
    doc: PDFDocument,
    geometry: NonNullable<ReturnType<typeof resolvePdfLineGeometry>>,
) {
    setPdfRect(annotDict, doc, geometry.rect);
    annotDict.set(PDFName.of('L'), doc.context.obj(geometry.linePoints));
}

function applyLineAnnotationStyle(
    annotDict: PDFDict,
    doc: PDFDocument,
    shape: IShapeAnnotation,
) {
    updateShapeStyle(annotDict, doc, shape);
    setLineEndings(annotDict, doc, shape);
    // A Line has no interior. Producers still leave /IC behind, and a viewer
    // that honours it paints a fill the shape never had.
    annotDict.delete(PDFName.of('IC'));
}

function applyVertexAnnotationStyle(
    annotDict: PDFDict,
    doc: PDFDocument,
    shape: IShapeAnnotation,
    subtype: 'PolyLine' | 'Polygon',
) {
    updateShapeStyle(annotDict, doc, shape);
    if (subtype === 'PolyLine') {
        setLineEndings(annotDict, doc, shape);
    } else {
        annotDict.delete(PDFName.of('LE'));
    }
    if (subtype === 'Polygon') {
        setRgbColor(annotDict, doc, 'IC', shape.fillColor);
    } else {
        annotDict.delete(PDFName.of('IC'));
    }
}

function createRectAnnotationDict(
    doc: PDFDocument,
    shape: IShapeAnnotation,
    subtype: 'Square' | 'Circle',
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
) {
    const rect = resolveShapePdfRect(shape, pageView, pageRotation);
    if (!rect) {
        return null;
    }

    const annotDict = doc.context.obj({
        Type: 'Annot',
        Subtype: subtype,
        Rect: doc.context.obj(rect),
    });
    applyRectAnnotationStyle(annotDict, doc, shape);
    updateShapeDates(annotDict, shape);
    return annotDict;
}

function updateRectAnnotationDict(
    annotDict: PDFDict,
    doc: PDFDocument,
    shape: IShapeAnnotation,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
) {
    // An untouched imported Square/Circle keeps the rect the file already
    // carries. Its marker geometry is a clamped projection of that rect, so
    // rewriting it would move or shrink a shape nobody edited.
    if (!isImportedShapeRectUnchanged(annotDict, getShapeMarkerRect(shape), pageView, pageRotation)) {
        const rect = resolveShapePdfRect(shape, pageView, pageRotation);
        if (!rect) {
            return false;
        }

        setPdfRect(annotDict, doc, rect);
    }

    applyRectAnnotationStyle(annotDict, doc, shape);
    updateShapeDates(annotDict, shape);
    return true;
}

function createLineAnnotationDict(
    doc: PDFDocument,
    shape: IShapeAnnotation,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
) {
    const geometry = resolvePdfLineGeometry(shape, pageView, pageRotation);
    if (!geometry) {
        return null;
    }

    const annotDict = doc.context.obj({
        Type: 'Annot',
        Subtype: 'Line',
        Rect: doc.context.obj(geometry.rect),
        L: doc.context.obj(geometry.linePoints),
    });
    applyLineAnnotationStyle(annotDict, doc, shape);
    updateShapeDates(annotDict, shape);
    return annotDict;
}

function updateLineAnnotationDict(
    annotDict: PDFDict,
    doc: PDFDocument,
    shape: IShapeAnnotation,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
) {
    const geometry = resolvePdfLineGeometry(shape, pageView, pageRotation);
    if (!geometry) {
        return false;
    }

    applyLineAnnotationGeometry(annotDict, doc, geometry);
    applyLineAnnotationStyle(annotDict, doc, shape);
    updateShapeDates(annotDict, shape);
    return true;
}

function createVertexAnnotationDict(
    doc: PDFDocument,
    shape: IShapeAnnotation,
    subtype: 'PolyLine' | 'Polygon',
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
) {
    const pdfPoints = toPdfVertexPoints(shape.points, pageView, pageRotation);
    if (!pdfPoints) {
        return null;
    }

    const rect = toPdfBoundsRect(pdfPoints, shape.strokeWidth);
    if (!rect) {
        return null;
    }

    const vertices = toFlatPdfPoints(pdfPoints);

    const annotDict = doc.context.obj({
        Type: 'Annot',
        Subtype: subtype,
        Rect: doc.context.obj(rect),
        Vertices: doc.context.obj(vertices),
    });
    applyVertexAnnotationStyle(annotDict, doc, shape, subtype);
    updateShapeDates(annotDict, shape);
    return annotDict;
}

function updateVertexAnnotationDict(
    annotDict: PDFDict,
    doc: PDFDocument,
    shape: IShapeAnnotation,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
    subtype: 'PolyLine' | 'Polygon',
) {
    const pdfPoints = toPdfVertexPoints(shape.points, pageView, pageRotation);
    if (!pdfPoints) {
        return false;
    }

    const rect = toPdfBoundsRect(pdfPoints, shape.strokeWidth);
    if (!rect) {
        return false;
    }

    const vertices = toFlatPdfPoints(pdfPoints);

    annotDict.set(PDFName.of('Rect'), doc.context.obj(rect));
    annotDict.set(PDFName.of('Vertices'), doc.context.obj(vertices));
    applyVertexAnnotationStyle(annotDict, doc, shape, subtype);
    updateShapeDates(annotDict, shape);
    return true;
}

function createInkAnnotationDict(
    doc: PDFDocument,
    shape: IShapeAnnotation,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
) {
    const inkData = toPdfInkList(shape, pageView, pageRotation);
    if (!inkData) {
        return null;
    }

    const rect = toPdfBoundsRect(inkData.pdfPoints, shape.strokeWidth);
    if (!rect) {
        return null;
    }

    const annotDict = doc.context.obj({
        Type: 'Annot',
        Subtype: 'Ink',
        Rect: doc.context.obj(rect),
        InkList: doc.context.obj(inkData.inkList.map(points => doc.context.obj(points))),
    });
    updateShapeStyle(annotDict, doc, shape);
    annotDict.delete(PDFName.of('LE'));
    annotDict.delete(PDFName.of('IC'));
    applyInkAnnotationAppearance(annotDict, doc, shape, inkData.inkList, rect);
    updateShapeDates(annotDict, shape);
    return annotDict;
}

function updateInkAnnotationDict(
    annotDict: PDFDict,
    doc: PDFDocument,
    shape: IShapeAnnotation,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
) {
    const inkData = toPdfInkList(shape, pageView, pageRotation);
    if (!inkData) {
        return false;
    }

    const rect = toPdfBoundsRect(inkData.pdfPoints, shape.strokeWidth);
    if (!rect) {
        return false;
    }

    annotDict.set(PDFName.of('Rect'), doc.context.obj(rect));
    annotDict.set(PDFName.of('InkList'), doc.context.obj(inkData.inkList.map(points => doc.context.obj(points))));
    updateShapeStyle(annotDict, doc, shape);
    annotDict.delete(PDFName.of('LE'));
    annotDict.delete(PDFName.of('IC'));
    applyInkAnnotationAppearance(annotDict, doc, shape, inkData.inkList, rect);
    updateShapeDates(annotDict, shape);
    return true;
}

const SHAPE_SEMANTIC_NUMBER_EPSILON = 0.0001;

function readPdfNumberArray(annotDict: PDFDict, key: string) {
    const array = annotDict.lookupMaybe(PDFName.of(key), PDFArray);
    if (!(array instanceof PDFArray)) {
        return null;
    }

    const values: number[] = [];
    for (let index = 0; index < array.size(); index += 1) {
        const value = array.get(index);
        if (!(value instanceof PDFNumber)) {
            return null;
        }
        values.push(value.asNumber());
    }
    return values;
}

function approximatelyEqual(left: number, right: number) {
    return Math.abs(left - right) <= SHAPE_SEMANTIC_NUMBER_EPSILON;
}

function approximatelyEqualArray(
    actual: number[] | null,
    expected: readonly number[] | null,
) {
    if (actual === null || expected === null) {
        return actual === expected;
    }
    return actual.length === expected.length
        && actual.every((value, index) => approximatelyEqual(value, expected[index]!));
}

function readShapeOpacity(annotDict: PDFDict) {
    return annotDict.lookupMaybe(PDFName.of('CA'), PDFNumber)?.asNumber() ?? 1;
}

function readShapeStrokeWidth(annotDict: PDFDict) {
    const border = annotDict.lookupMaybe(PDFName.of('Border'), PDFArray);
    if (border instanceof PDFArray && border.size() >= 3) {
        const width = border.get(2);
        if (width instanceof PDFNumber && width.asNumber() >= 0) {
            return width.asNumber();
        }
    }

    const borderStyle = annotDict.lookupMaybe(PDFName.of('BS'), PDFDict);
    const width = borderStyle?.lookupMaybe(PDFName.of('W'), PDFNumber);
    return width?.asNumber() ?? 1;
}

function readShapeLineEndings(annotDict: PDFDict) {
    const endings = annotDict.lookupMaybe(PDFName.of('LE'), PDFArray);
    if (!(endings instanceof PDFArray)) {
        return [
            'none',
            'none',
        ] as const;
    }

    return [
        0,
        1,
    ].map(index => (endings.get(index)?.toString() ?? '/None')
        .replace(/^\//u, '')
        .toLowerCase()) as [string, string];
}

function expectedLineEnding(style: IShapeAnnotation['lineStartStyle']) {
    switch (style) {
        case 'openArrow':
            return 'openarrow';
        case 'closedArrow':
            return 'closedarrow';
        default:
            return 'none';
    }
}

function shapeSemanticChange(
    annotDict: PDFDict,
    shape: IShapeAnnotation,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
) {
    const subtype = getPdfDictSubtype(annotDict);
    if (subtype === 'Ink') {
        return false;
    }

    if (!approximatelyEqual(readShapeOpacity(annotDict), shape.opacity)
        || !approximatelyEqual(readShapeStrokeWidth(annotDict), shape.strokeWidth)
        || !approximatelyEqualArray(readPdfNumberArray(annotDict, 'C'), parsePdfColor(shape.color))
        || !approximatelyEqualArray(readPdfNumberArray(annotDict, 'IC'), parsePdfColor(shape.fillColor))) {
        return true;
    }

    if (subtype === 'Line' || subtype === 'PolyLine') {
        const [
            actualStart,
            actualEnd,
        ] = readShapeLineEndings(annotDict);
        if (actualStart !== expectedLineEnding(shape.lineStartStyle)
            || actualEnd !== expectedLineEnding(shape.lineEndStyle)) {
            return true;
        }
    } else if (subtype === 'Polygon' && annotDict.has(PDFName.of('LE'))) {
        return true;
    }

    switch (subtype) {
        case 'Square':
        case 'Circle':
            // The marker rect is clamped on import. The helper therefore
            // decides whether the on-disk rect represents an edit.
            return !isImportedShapeRectUnchanged(
                annotDict,
                getShapeMarkerRect(shape),
                pageView,
                pageRotation,
            );
        case 'Line': {
            const geometry = resolvePdfLineGeometry(shape, pageView, pageRotation);
            return !geometry
                || !approximatelyEqualArray(readPdfRectFromDict(annotDict), geometry.rect)
                || !approximatelyEqualArray(readPdfNumberArray(annotDict, 'L'), geometry.linePoints);
        }
        case 'PolyLine':
        case 'Polygon': {
            const pdfPoints = toPdfVertexPoints(shape.points, pageView, pageRotation);
            const rect = pdfPoints ? toPdfBoundsRect(pdfPoints, shape.strokeWidth) : null;
            const vertices = pdfPoints ? toFlatPdfPoints(pdfPoints) : null;
            return !rect
                || !approximatelyEqualArray(readPdfRectFromDict(annotDict), rect)
                || !approximatelyEqualArray(readPdfNumberArray(annotDict, 'Vertices'), vertices);
        }
        default:
            return true;
    }
}

function createShapeAnnotationDict(
    doc: PDFDocument,
    shape: IShapeAnnotation,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
) {
    switch (shape.type) {
        case 'rectangle':
            return createRectAnnotationDict(doc, shape, 'Square', pageView, pageRotation);
        case 'circle':
            return createRectAnnotationDict(doc, shape, 'Circle', pageView, pageRotation);
        case 'line':
        case 'arrow':
            return createLineAnnotationDict(doc, shape, pageView, pageRotation);
        case 'polyline':
            if (shape.pdfSubtype === 'Ink') {
                return createInkAnnotationDict(doc, shape, pageView, pageRotation);
            }
            return createVertexAnnotationDict(doc, shape, 'PolyLine', pageView, pageRotation);
        case 'polygon':
            return createVertexAnnotationDict(doc, shape, 'Polygon', pageView, pageRotation);
        default:
            return null;
    }
}

function updateEmbeddedShapeAnnotationDict(
    doc: PDFDocument,
    annotDict: PDFDict,
    shape: IShapeAnnotation,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
) {
    const subtype = getPdfDictSubtype(annotDict);
    const semanticChanged = subtype !== 'Ink'
        && shapeSemanticChange(annotDict, shape, pageView, pageRotation);
    let updated = false;
    switch (subtype) {
        case 'Square':
        case 'Circle':
            updated = updateRectAnnotationDict(annotDict, doc, shape, pageView, pageRotation);
            break;
        case 'Line':
            updated = updateLineAnnotationDict(annotDict, doc, shape, pageView, pageRotation);
            break;
        case 'PolyLine':
            updated = updateVertexAnnotationDict(annotDict, doc, shape, pageView, pageRotation, 'PolyLine');
            break;
        case 'Polygon':
            updated = updateVertexAnnotationDict(annotDict, doc, shape, pageView, pageRotation, 'Polygon');
            break;
        case 'Ink':
            updated = updateInkAnnotationDict(annotDict, doc, shape, pageView, pageRotation);
            break;
        default:
            break;
    }
    if (updated && subtype !== 'Ink' && semanticChanged) {
        // The semantic shape fields above are the source of truth after an
        // edit. An imported normal appearance describes the old geometry or
        // style, so keeping it would make readers draw stale pixels.
        annotDict.delete(PDFName.of('AP'));
    }
    return updated;
}

function applyEmbeddedShapeUpdate(
    doc: PDFDocument,
    annotDict: PDFDict,
    shape: IShapeAnnotation,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
) {
    const updatedShape = updateEmbeddedShapeAnnotationDict(doc, annotDict, shape, pageView, pageRotation);
    const wroteStableKey = writeManagedShapeStableKey(annotDict, shape.stableKey);
    return updatedShape || wroteStableKey;
}

interface IShapeConsumptionState {
    byAnnotationId: Map<string, IShapeAnnotation>;
    byStableKey: Map<string, IShapeAnnotation>;
    remaining: IShapeAnnotation[];
}

interface IDeletedShapeRefs {
    annotationIds: Set<string>;
    stableKeys: Set<string>;
}

function createShapeConsumptionState(shapes: IShapeAnnotation[]): IShapeConsumptionState {
    const state: IShapeConsumptionState = {
        byAnnotationId: new Map(),
        byStableKey: new Map(),
        remaining: shapes.slice(),
    };

    shapes.forEach((shape) => {
        const stableKey = normalizeManagedShapeStableKey(shape.stableKey);
        if (stableKey) {
            state.byStableKey.set(stableKey, shape);
        }

        const annotationId = normalizePdfJsAnnotationId(shape.annotationId);
        if (annotationId) {
            state.byAnnotationId.set(annotationId, shape);
        }
    });

    return state;
}

function consumeShape(shapeState: IShapeConsumptionState, shape: IShapeAnnotation) {
    const remainingIndex = shapeState.remaining.indexOf(shape);
    if (remainingIndex !== -1) {
        shapeState.remaining.splice(remainingIndex, 1);
    }

    const annotationId = normalizePdfJsAnnotationId(shape.annotationId);
    if (annotationId) {
        shapeState.byAnnotationId.delete(annotationId);
    }

    const stableKey = normalizeManagedShapeStableKey(shape.stableKey);
    if (stableKey) {
        shapeState.byStableKey.delete(stableKey);
    }
}

function collectDeletedShapeRefs(
    deletedShapeAnnotationIds: string[],
    deletedShapeStableKeys: string[],
): IDeletedShapeRefs {
    const annotationIds = new Set<string>();
    deletedShapeAnnotationIds.forEach((annotationId) => {
        const normalizedId = normalizePdfJsAnnotationId(annotationId);
        if (normalizedId) {
            annotationIds.add(normalizedId);
        }
    });

    const stableKeys = new Set<string>();
    deletedShapeStableKeys.forEach((stableKey) => {
        const normalizedStableKey = normalizeManagedShapeStableKey(stableKey);
        if (normalizedStableKey) {
            stableKeys.add(normalizedStableKey);
        }
    });

    return {
        annotationIds,
        stableKeys,
    };
}

function collectShapeAnnotationRefsToDelete(
    doc: PDFDocument,
    refsToDeleteByTag: Map<string, PDFRef>,
    ref: PDFRef,
) {
    collectAnnotationRefsToDelete(doc, ref).forEach((deleteRef) => {
        refsToDeleteByTag.set(formatPdfJsAnnotationRef(deleteRef), deleteRef);
    });
}

function updateExistingShapeAnnotation(
    doc: PDFDocument,
    annotDict: PDFDict,
    shape: IShapeAnnotation,
    context: NonNullable<ReturnType<typeof resolveShapePageContext>>,
) {
    return applyEmbeddedShapeUpdate(doc, annotDict, shape, context.pageView, context.pageRotation);
}

function applyExistingShapeAnnotationDecision(
    doc: PDFDocument,
    shapeState: IShapeConsumptionState,
    deletedRefs: IDeletedShapeRefs,
    refsToDeleteByTag: Map<string, PDFRef>,
    rewriteShapeState: boolean,
    context: NonNullable<ReturnType<typeof resolveShapePageContext>>,
    annotation: NonNullable<ReturnType<typeof lookupAnnotationRefDict>>,
) {
    const {
        dict: annotDict,
        ref,
    } = annotation;
    const annotationStableKey = readManagedShapeStableKey(annotDict);
    const annotationId = formatPdfJsAnnotationRef(ref);
    const isDeletedManagedShape = annotationStableKey
        ? deletedRefs.stableKeys.has(annotationStableKey)
        : false;

    if (deletedRefs.annotationIds.has(annotationId) || isDeletedManagedShape) {
        collectShapeAnnotationRefsToDelete(doc, refsToDeleteByTag, ref);
        return true;
    }

    if (annotationStableKey) {
        const shape = shapeState.byStableKey.get(annotationStableKey) ?? null;
        if (!shape) {
            if (!rewriteShapeState) {
                return false;
            }

            collectShapeAnnotationRefsToDelete(doc, refsToDeleteByTag, ref);
            return true;
        }

        const modified = updateExistingShapeAnnotation(doc, annotDict, shape, context);
        consumeShape(shapeState, shape);
        return modified;
    }

    const shape = shapeState.byAnnotationId.get(annotationId) ?? null;
    if (!shape) {
        return false;
    }

    const modified = updateExistingShapeAnnotation(doc, annotDict, shape, context);
    consumeShape(shapeState, shape);
    return modified;
}

function appendRemainingShapeAnnotations(
    doc: PDFDocument,
    pages: ReturnType<PDFDocument['getPages']>,
    remainingShapes: IShapeAnnotation[],
) {
    let modified = false;

    for (const shape of remainingShapes) {
        const page = pages[shape.pageIndex];
        if (!page) {
            throw new Error(`Unable to serialize shape annotation ${shape.stableKey}: page ${shape.pageIndex + 1} is missing`);
        }

        const context = resolveShapePageContext(page);
        if (!context) {
            throw new Error(`Unable to serialize shape annotation ${shape.stableKey}: page geometry is unavailable`);
        }

        const annotDict = createShapeAnnotationDict(doc, shape, context.pageView, context.pageRotation);
        if (!annotDict) {
            throw new Error(`Unable to serialize shape annotation ${shape.stableKey}: annotation geometry is invalid`);
        }

        writeManagedShapeStableKey(annotDict, shape.stableKey);
        const annotRef = doc.context.register(annotDict);
        appendAnnotationRefToPage(page, doc, annotRef);
        modified = true;
    }

    return modified;
}

export function applyShapeAnnotations(
    doc: PDFDocument,
    shapes: IShapeAnnotation[],
    deletedShapeAnnotationIds: string[],
    deletedShapeStableKeys: string[],
    rewriteShapeState: boolean,
) {
    if (
        !rewriteShapeState
        && shapes.length === 0
        && deletedShapeAnnotationIds.length === 0
        && deletedShapeStableKeys.length === 0
    ) {
        return false;
    }

    const pages = doc.getPages();
    const shapeState = createShapeConsumptionState(shapes);
    const refsToDeleteByTag = new Map<string, PDFRef>();
    const deletedRefs = collectDeletedShapeRefs(deletedShapeAnnotationIds, deletedShapeStableKeys);
    let modified = false;

    for (const page of pages) {
        const context = resolveShapePageContext(page);
        if (!context) {
            continue;
        }

        const annots = page.node.Annots();
        if (!(annots instanceof PDFArray)) {
            continue;
        }

        for (let index = 0; index < annots.size(); index += 1) {
            const annotation = lookupAnnotationRefDict(doc, annots.get(index));
            if (!annotation) {
                continue;
            }

            if (applyExistingShapeAnnotationDecision(
                doc,
                shapeState,
                deletedRefs,
                refsToDeleteByTag,
                rewriteShapeState,
                context,
                annotation,
            )) {
                modified = true;
            }
        }
    }

    if (refsToDeleteByTag.size > 0) {
        modified = removeAnnotationRefsFromPages(doc, [...refsToDeleteByTag.values()]) || modified;
    }

    modified = appendRemainingShapeAnnotations(doc, pages, shapeState.remaining) || modified;

    return modified;
}
