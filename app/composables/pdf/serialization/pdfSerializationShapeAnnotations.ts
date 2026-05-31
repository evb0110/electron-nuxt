import type {
    PDFDict,
    PDFDocument,
    PDFRef,
} from 'pdf-lib';
import {
    PDFArray,
    PDFName,
    PDFString,
} from 'pdf-lib';
import type {
    IShapeAnnotation,
    TLineEndStyle,
} from '@app/types/annotations';
import type { normalizePageRotation} from '@app/composables/pdf/annotationGeometry';
import { toPdfRectFromMarkerRect} from '@app/composables/pdf/annotationGeometry';
import { getPdfDictSubtype } from '@app/utils/pdfDict';
import { toPdfDateString } from '@app/utils/pdfDate';
import {
    collectAnnotationRefsToDelete,
    removeAnnotationRefsFromPages,
} from '@app/composables/pdf/pdfSerializationComments';
import {
    normalizeManagedShapeStableKey,
    normalizePdfJsAnnotationId,
    readManagedShapeStableKey,
    writeManagedShapeStableKey,
} from '@app/composables/pdf/pdfSerializationRefs';
import { lookupAnnotationRefDict } from '@app/composables/pdf/pdfPageAnnotationIteration';
import {
    appendAnnotationRefToPage,
    refToTag,
} from '@app/composables/pdf/serialization/pdfSerializationShared';
import {
    setBorderWidth,
    setOpacity,
    setRgbColor,
} from '@app/composables/pdf/serialization/pdfSerializationColors';
import {
    resolveShapePageContext,
    toPdfBoundsRect,
    toPdfInkList,
    toPdfLinePoints,
    toPdfVertexPoints,
} from '@app/composables/pdf/serialization/pdfSerializationGeometry';

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
    const rect = resolveShapePdfRect(shape, pageView, pageRotation);
    if (!rect) {
        return false;
    }

    setPdfRect(annotDict, doc, rect);
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
    updateShapeDates(annotDict, shape);
    return true;
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
    switch (subtype) {
        case 'Square':
        case 'Circle':
            return updateRectAnnotationDict(annotDict, doc, shape, pageView, pageRotation);
        case 'Line':
            return updateLineAnnotationDict(annotDict, doc, shape, pageView, pageRotation);
        case 'PolyLine':
            return updateVertexAnnotationDict(annotDict, doc, shape, pageView, pageRotation, 'PolyLine');
        case 'Polygon':
            return updateVertexAnnotationDict(annotDict, doc, shape, pageView, pageRotation, 'Polygon');
        case 'Ink':
            return updateInkAnnotationDict(annotDict, doc, shape, pageView, pageRotation);
        default:
            return false;
    }
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
        refsToDeleteByTag.set(refToTag(deleteRef), deleteRef);
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
    const annotationId = refToTag(ref);
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
            continue;
        }

        const context = resolveShapePageContext(page);
        if (!context) {
            continue;
        }

        const annotDict = createShapeAnnotationDict(doc, shape, context.pageView, context.pageRotation);
        if (!annotDict) {
            continue;
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
