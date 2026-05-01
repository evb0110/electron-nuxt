import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFRef,
    degrees,
    drawImage,
} from 'pdf-lib';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    IShapeAnnotation,
    IShapePoint,
    TLineEndStyle,
    TMarkupSubtype,
} from '@app/types/annotations';
import { getShapeStrokePointSets } from '@app/composables/pdf/pdfShapeStrokes';
import type { IPdfPlacedImageFinalizePayload } from '@app/types/pdf-image-placement';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdf';
import {
    markerRectIoU,
    normalizePageRotation,
    toPdfPointFromMarkerPoint,
    toMarkerRectFromPdfRect,
    toPdfRectFromMarkerRect,
} from '@app/composables/pdf/annotationGeometry';
import {
    getPdfDictContents,
    getPdfDictSubtype,
} from '@app/utils/pdf-dict';
import {
    collectAnnotationRefsToDelete,
    removeAnnotationRefsFromPages,
    updateAnnotationTextByRef,
} from '@app/composables/pdf/pdfSerializationComments';
import {
    formatPdfJsAnnotationRef,
    normalizeManagedShapeStableKey,
    normalizePdfJsAnnotationId,
    readManagedShapeStableKey,
    resolveCommentPdfRefInDocument,
    writeManagedShapeStableKey,
} from '@app/composables/pdf/pdfSerializationRefs';
import type { IMarkupSubtypeHint } from '@app/composables/pdf/pdfSerializationSubtypeHints';
import {
    isImplicitDefaultPageLabels,
    normalizePageLabelRanges,
} from '@app/utils/pdf-page-labels';
import { normalizeBookmarkEntries } from '@app/composables/pdf/usePdfBookmarkSerialization';
import { parseHexColor } from '@app/utils/color';
import {
    readPdfRectFromDict,
    resolvePdfPageView,
} from '@app/composables/pdf/pdfPageBoxes';
import { writeBookmarkOutlines } from '@app/composables/pdf/pdfBookmarkOutlineWriter';

const MARKUP_SUBTYPE_TO_PDF_NAME: Record<TMarkupSubtype, string> = {
    Highlight: 'Highlight',
    Underline: 'Underline',
    StrikeOut: 'StrikeOut',
    Squiggly: 'Squiggly',
};

export interface IPdfSerializedPlacedImagePayload extends Omit<IPdfPlacedImageFinalizePayload, 'mimeType'> {mimeType: 'image/png' | 'image/jpeg';}

export interface IPdfSerializationSavePayload {
    markupSubtypeOverrides: Array<readonly [string, TMarkupSubtype]>;
    markupSubtypeHints: IMarkupSubtypeHint[];
    rewriteShapeState: boolean;
    shapes: IShapeAnnotation[];
    deletedShapeAnnotationIds: string[];
    deletedShapeStableKeys: string[];
    freeTextComments: IAnnotationCommentSummary[];
    annotationComments: IAnnotationCommentSummary[];
    pendingEmbeddedTextUpdates: Array<readonly [string, string]>;
    pendingEmbeddedAnnotationDeletes: IAnnotationCommentSummary[];
    pageLabelsDirty: boolean;
    pageLabelRanges: IPdfPageLabelRange[];
    totalPages: number;
    bookmarksDirty: boolean;
    bookmarkItems: IPdfBookmarkEntry[];
    untitledBookmarkLabel: string;
    placedImage: IPdfSerializedPlacedImagePayload | null;
}

function appendAnnotationRefToPage(
    page: ReturnType<PDFDocument['getPages']>[number],
    doc: PDFDocument,
    annotRef: PDFRef,
) {
    const annots = page.node.Annots() ?? doc.context.obj([]);
    if (annots instanceof PDFArray) {
        annots.push(annotRef);
        page.node.set(PDFName.of('Annots'), annots);
        return;
    }

    page.node.set(PDFName.of('Annots'), doc.context.obj([annotRef]));
}

function isAnnotationMarkerRect(value: IAnnotationCommentSummary['markerRect']): value is IAnnotationMarkerRect {
    return Boolean(
        value
        && Number.isFinite(value.left)
        && Number.isFinite(value.top)
        && Number.isFinite(value.width)
        && Number.isFinite(value.height),
    );
}

function refToTag(ref: PDFRef) {
    return formatPdfJsAnnotationRef(ref);
}

function setRgbColor(
    annotDict: PDFDict,
    doc: PDFDocument,
    key: 'C' | 'IC',
    color: string | undefined,
) {
    if (!color || color === 'transparent' || color === 'none') {
        annotDict.delete(PDFName.of(key));
        return;
    }

    const [
        red,
        green,
        blue,
    ] = parseHexColor(color);
    annotDict.set(PDFName.of(key), doc.context.obj([
        red,
        green,
        blue,
    ]));
}

function setOpacity(annotDict: PDFDict, opacity: number) {
    annotDict.set(PDFName.of('CA'), PDFNumber.of(opacity));
}

function setBorderWidth(annotDict: PDFDict, doc: PDFDocument, strokeWidth: number) {
    annotDict.set(PDFName.of('Border'), doc.context.obj([
        0,
        0,
        strokeWidth,
    ]));
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

function resolveShapePageContext(page: ReturnType<PDFDocument['getPages']>[number]) {
    const pageView = resolvePdfPageView(page);
    if (!pageView) {
        return null;
    }

    return {
        pageView,
        pageRotation: normalizePageRotation(page.getRotation().angle),
    };
}

function toPdfLinePoints(
    shape: IShapeAnnotation,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
) {
    const start = toPdfPointFromMarkerPoint(shape.x, shape.y, pageView, pageRotation);
    const end = toPdfPointFromMarkerPoint(shape.x2 ?? shape.x, shape.y2 ?? shape.y, pageView, pageRotation);
    if (!start || !end) {
        return null;
    }

    return [
        start,
        end,
    ] as const;
}

function toPdfVertexPoints(
    points: IShapePoint[] | undefined,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
) {
    if (!points || points.length < 2) {
        return null;
    }

    const pdfPoints = points
        .map(point => toPdfPointFromMarkerPoint(point.x, point.y, pageView, pageRotation))
        .filter((point): point is NonNullable<typeof point> => Boolean(point));
    return pdfPoints.length === points.length ? pdfPoints : null;
}

function toPdfInkList(
    shape: IShapeAnnotation,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
) {
    const strokePointSets = getShapeStrokePointSets(shape);
    if (strokePointSets.length === 0) {
        return null;
    }

    const inkList: number[][] = [];
    const pdfPoints = strokePointSets.flatMap((points) => {
        const strokePdfPoints = toPdfVertexPoints(points, pageView, pageRotation);
        if (!strokePdfPoints) {
            return [];
        }
        inkList.push(strokePdfPoints.flatMap(point => [
            point.x,
            point.y,
        ]));
        return strokePdfPoints;
    });
    if (inkList.length === 0 || pdfPoints.length === 0) {
        return null;
    }

    return {
        pdfPoints,
        inkList,
    };
}

function toPdfBoundsRect(points: ReadonlyArray<{
    x: number;
    y: number;
}>, strokeWidth: number) {
    if (points.length === 0) {
        return null;
    }

    const xs = points.map(point => point.x);
    const ys = points.map(point => point.y);
    return [
        Math.min(...xs) - strokeWidth,
        Math.min(...ys) - strokeWidth,
        Math.max(...xs) + strokeWidth,
        Math.max(...ys) + strokeWidth,
    ] as [number, number, number, number];
}

function updateShapeStyle(annotDict: PDFDict, doc: PDFDocument, shape: IShapeAnnotation) {
    setRgbColor(annotDict, doc, 'C', shape.color);
    setOpacity(annotDict, shape.opacity);
    setBorderWidth(annotDict, doc, shape.strokeWidth);
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

function applyShapeAnnotations(
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
    const shapesByAnnotationId = new Map<string, IShapeAnnotation>();
    const shapesByStableKey = new Map<string, IShapeAnnotation>();
    const remainingShapes = shapes.slice();

    function consumeShape(shape: IShapeAnnotation) {
        const remainingIndex = remainingShapes.indexOf(shape);
        if (remainingIndex !== -1) {
            remainingShapes.splice(remainingIndex, 1);
        }

        const annotationId = normalizePdfJsAnnotationId(shape.annotationId);
        if (annotationId) {
            shapesByAnnotationId.delete(annotationId);
        }

        const stableKey = normalizeManagedShapeStableKey(shape.stableKey);
        if (stableKey) {
            shapesByStableKey.delete(stableKey);
        }
    }

    shapes.forEach((shape) => {
        const stableKey = normalizeManagedShapeStableKey(shape.stableKey);
        if (stableKey) {
            shapesByStableKey.set(stableKey, shape);
        }

        const annotationId = normalizePdfJsAnnotationId(shape.annotationId);
        if (annotationId) {
            shapesByAnnotationId.set(annotationId, shape);
        }
    });

    const refsToDeleteByTag = new Map<string, PDFRef>();
    const deletedIds = new Set<string>();
    deletedShapeAnnotationIds.forEach((annotationId) => {
        const normalizedId = normalizePdfJsAnnotationId(annotationId);
        if (normalizedId) {
            deletedIds.add(normalizedId);
        }
    });
    const deletedStableKeys = new Set<string>();
    deletedShapeStableKeys.forEach((stableKey) => {
        const normalizedStableKey = normalizeManagedShapeStableKey(stableKey);
        if (normalizedStableKey) {
            deletedStableKeys.add(normalizedStableKey);
        }
    });
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
            const value = annots.get(index);
            if (!(value instanceof PDFRef)) {
                continue;
            }

            const annotDict = doc.context.lookupMaybe(value, PDFDict);
            if (!annotDict) {
                continue;
            }

            const annotationStableKey = readManagedShapeStableKey(annotDict);
            const annotationId = refToTag(value);
            const isDeletedManagedShape = annotationStableKey
                ? deletedStableKeys.has(annotationStableKey)
                : false;

            if (deletedIds.has(annotationId) || isDeletedManagedShape) {
                collectAnnotationRefsToDelete(doc, value).forEach((ref) => {
                    refsToDeleteByTag.set(refToTag(ref), ref);
                });
                modified = true;
                continue;
            }

            if (annotationStableKey) {
                const shape = shapesByStableKey.get(annotationStableKey) ?? null;
                if (!shape) {
                    if (!rewriteShapeState) {
                        continue;
                    }

                    collectAnnotationRefsToDelete(doc, value).forEach((ref) => {
                        refsToDeleteByTag.set(refToTag(ref), ref);
                    });
                    modified = true;
                    continue;
                }

                if (updateEmbeddedShapeAnnotationDict(doc, annotDict, shape, context.pageView, context.pageRotation)) {
                    modified = true;
                }
                if (writeManagedShapeStableKey(annotDict, shape.stableKey)) {
                    modified = true;
                }
                consumeShape(shape);
                continue;
            }

            const shape = shapesByAnnotationId.get(annotationId)
                ?? null;
            if (!shape) {
                continue;
            }

            if (updateEmbeddedShapeAnnotationDict(doc, annotDict, shape, context.pageView, context.pageRotation)) {
                modified = true;
            }
            if (writeManagedShapeStableKey(annotDict, shape.stableKey)) {
                modified = true;
            }
            consumeShape(shape);
        }
    }

    if (refsToDeleteByTag.size > 0) {
        modified = removeAnnotationRefsFromPages(doc, [...refsToDeleteByTag.values()]) || modified;
    }

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

function applyEmbeddedAnnotationDeletes(
    doc: PDFDocument,
    comments: IAnnotationCommentSummary[],
) {
    if (comments.length === 0) {
        return false;
    }

    const refsToDeleteByTag = new Map<string, PDFRef>();
    for (const comment of comments) {
        const targetRef = resolveCommentPdfRefInDocument(doc, comment);
        if (!targetRef) {
            continue;
        }

        collectAnnotationRefsToDelete(doc, targetRef).forEach((ref) => {
            refsToDeleteByTag.set(refToTag(ref), ref);
        });
    }

    if (refsToDeleteByTag.size === 0) {
        return false;
    }

    return removeAnnotationRefsFromPages(doc, [...refsToDeleteByTag.values()]);
}

function applyMarkupSubtypeRewrites(
    doc: PDFDocument,
    overrides: Array<readonly [string, TMarkupSubtype]>,
    subtypeHints: IMarkupSubtypeHint[],
) {
    const overridesMap = new Map<string, TMarkupSubtype>(overrides);
    if (overridesMap.size === 0 && subtypeHints.length === 0) {
        return false;
    }

    const hintsByPage = new Map<number, IMarkupSubtypeHint[]>();
    subtypeHints.forEach((hint) => {
        const pageHints = hintsByPage.get(hint.pageIndex);
        if (pageHints) {
            pageHints.push({
                ...hint,
                consumed: false,
            });
            return;
        }
        hintsByPage.set(hint.pageIndex, [{
            ...hint,
            consumed: false,
        }]);
    });

    const subtypeName = PDFName.of('Subtype');
    const highlightName = PDFName.of('Highlight');
    let rewritten = false;

    const pages = doc.getPages();
    for (const [
        pageIndex,
        page,
    ] of pages.entries()) {
        const pageHints = hintsByPage.get(pageIndex) ?? [];
        const pageView = resolvePdfPageView(page);
        if (!pageView) {
            continue;
        }
        const pageRotation = normalizePageRotation(page.getRotation().angle);
        const annots = page.node.Annots();
        if (!(annots instanceof PDFArray)) {
            continue;
        }

        for (let index = 0; index < annots.size(); index += 1) {
            const value = annots.get(index);
            const ref = value instanceof PDFRef ? value : null;
            if (!ref) {
                continue;
            }

            const dict = doc.context.lookupMaybe(ref, PDFDict);
            if (!dict) {
                continue;
            }

            const currentSubtype = dict.get(subtypeName);
            if (!(currentSubtype instanceof PDFName) || currentSubtype !== highlightName) {
                continue;
            }

            const refTag = formatPdfJsAnnotationRef(ref);
            let targetSubtype = overridesMap.get(refTag) ?? null;
            if (!targetSubtype && pageHints.length > 0) {
                const markerRect = toMarkerRectFromPdfRect(
                    readPdfRectFromDict(dict),
                    pageView,
                    pageRotation,
                );
                let bestMatch: {
                    score: number;
                    hint: IMarkupSubtypeHint;
                } | null = null;

                for (const hint of pageHints) {
                    if (hint.consumed) {
                        continue;
                    }

                    const score = markerRectIoU(markerRect, hint.markerRect);
                    if (score <= 0) {
                        continue;
                    }

                    if (!bestMatch || score > bestMatch.score) {
                        bestMatch = {
                            score,
                            hint,
                        };
                    }
                }

                if (bestMatch && bestMatch.score >= 0.2) {
                    targetSubtype = bestMatch.hint.subtype;
                    bestMatch.hint.consumed = true;
                }
            }

            if (!targetSubtype) {
                continue;
            }

            const pdfSubtypeName = MARKUP_SUBTYPE_TO_PDF_NAME[targetSubtype];
            if (pdfSubtypeName && pdfSubtypeName !== 'Highlight') {
                dict.set(subtypeName, PDFName.of(pdfSubtypeName));
                rewritten = true;
            }
        }
    }

    return rewritten;
}

function applyFreeTextNoteRects(doc: PDFDocument, comments: IAnnotationCommentSummary[]) {
    if (comments.length === 0) {
        return false;
    }

    const subtypeName = PDFName.of('Subtype');
    const freeTextName = PDFName.of('FreeText');
    const rectName = PDFName.of('Rect');
    const popupName = PDFName.of('Popup');
    const apName = PDFName.of('AP');
    let modified = false;
    let blankApRef: PDFRef | null = null;

    const pages = doc.getPages();
    for (const [
        pageIndex,
        page,
    ] of pages.entries()) {
        const pageComments = comments.filter(comment => comment.pageIndex === pageIndex && isAnnotationMarkerRect(comment.markerRect));
        if (pageComments.length === 0) {
            continue;
        }

        const pageView = resolvePdfPageView(page);
        if (!pageView) {
            continue;
        }
        const pageRotation = normalizePageRotation(page.getRotation().angle);

        const annots = page.node.Annots();
        if (!(annots instanceof PDFArray)) {
            continue;
        }

        for (let annotIndex = 0; annotIndex < annots.size(); annotIndex += 1) {
            const value = annots.get(annotIndex);
            const ref = value instanceof PDFRef ? value : null;
            if (!ref) {
                continue;
            }

            const dict = doc.context.lookupMaybe(ref, PDFDict);
            if (!dict) {
                continue;
            }

            const currentSubtype = dict.get(subtypeName);
            if (!(currentSubtype instanceof PDFName) || currentSubtype !== freeTextName) {
                continue;
            }

            if (!dict.get(popupName)) {
                continue;
            }

            const dictRect = toMarkerRectFromPdfRect(
                readPdfRectFromDict(dict),
                pageView,
                pageRotation,
            );
            const refTag = `${ref.objectNumber}R${ref.generationNumber}`;
            const dictText = getPdfDictContents(dict).trim().toLowerCase();

            let bestMatch: {
                comment: IAnnotationCommentSummary;
                score: number;
            } | null = null;
            for (const comment of pageComments) {
                if (!isAnnotationMarkerRect(comment.markerRect)) {
                    continue;
                }

                if (normalizePdfJsAnnotationId(comment.annotationId) === refTag) {
                    bestMatch = {
                        comment,
                        score: 100,
                    };
                    break;
                }

                const iou = dictRect ? markerRectIoU(dictRect, comment.markerRect) : 0;
                if (iou > 0.05) {
                    if (!bestMatch || iou > bestMatch.score) {
                        bestMatch = {
                            comment,
                            score: iou,
                        };
                    }
                    continue;
                }

                if (dictText.length > 0 && comment.text) {
                    const commentText = comment.text.trim().toLowerCase();
                    if (dictText === commentText) {
                        bestMatch = {
                            comment,
                            score: 50,
                        };
                        break;
                    }
                }
            }

            if (!bestMatch) {
                const singleComment = pageComments.length === 1 ? pageComments[0] : null;
                if (!singleComment || !isAnnotationMarkerRect(singleComment.markerRect)) {
                    continue;
                }
                bestMatch = {
                    comment: singleComment,
                    score: 1,
                };
            }

            if (!isAnnotationMarkerRect(bestMatch.comment.markerRect)) {
                continue;
            }

            const pdfRect = toPdfRectFromMarkerRect(
                bestMatch.comment.markerRect,
                pageView,
                pageRotation,
            );
            if (!pdfRect) {
                continue;
            }

            dict.set(rectName, doc.context.obj([
                PDFNumber.of(pdfRect[0]),
                PDFNumber.of(pdfRect[1]),
                PDFNumber.of(pdfRect[2]),
                PDFNumber.of(pdfRect[3]),
            ]));

            if (!blankApRef) {
                blankApRef = doc.context.register(doc.context.formXObject([], {}));
            }
            dict.set(apName, doc.context.obj({ N: blankApRef }));
            modified = true;
        }
    }

    return modified;
}

function applyEmbeddedNoteTextUpdates(
    doc: PDFDocument,
    comments: IAnnotationCommentSummary[],
    pendingUpdates: Array<readonly [string, string]>,
) {
    if (pendingUpdates.length === 0) {
        return false;
    }

    const commentsByKey = new Map<string, IAnnotationCommentSummary>();
    comments.forEach((comment) => {
        const match = pendingUpdates.some(([stableKey]) => stableKey === comment.stableKey);
        if (match) {
            commentsByKey.set(comment.stableKey, comment);
        }
    });

    let modified = false;
    for (const [
        stableKey,
        text,
    ] of pendingUpdates) {
        const comment = commentsByKey.get(stableKey);
        if (!comment) {
            continue;
        }

        const targetRef = resolveCommentPdfRefInDocument(doc, comment);
        if (!targetRef) {
            continue;
        }

        if (updateAnnotationTextByRef(doc, targetRef, text)) {
            modified = true;
        }
    }

    return modified;
}

function applyPageLabels(
    doc: PDFDocument,
    pageLabelsDirty: boolean,
    pageLabelRanges: IPdfPageLabelRange[],
    totalPages: number,
) {
    if (!pageLabelsDirty || totalPages <= 0) {
        return false;
    }

    const normalizedRanges = normalizePageLabelRanges(pageLabelRanges, totalPages);
    const pageLabelsName = PDFName.of('PageLabels');

    if (isImplicitDefaultPageLabels(normalizedRanges, totalPages)) {
        const hadLabels = doc.catalog.has(pageLabelsName);
        doc.catalog.delete(pageLabelsName);
        return hadLabels;
    }

    const nums = doc.context.obj([]);
    const styleName = PDFName.of('S');
    const prefixName = PDFName.of('P');
    const startName = PDFName.of('St');
    const typeName = PDFName.of('Type');
    const pageLabelName = PDFName.of('PageLabel');

    for (const range of normalizedRanges) {
        nums.push(PDFNumber.of(range.startPage - 1));

        const labelDict = doc.context.obj({});
        labelDict.set(typeName, pageLabelName);
        if (range.style) {
            labelDict.set(styleName, PDFName.of(range.style));
        }
        if (range.prefix.length > 0) {
            labelDict.set(prefixName, PDFHexString.fromText(range.prefix));
        }
        if (range.style && range.startNumber > 1) {
            labelDict.set(startName, PDFNumber.of(range.startNumber));
        }

        nums.push(labelDict);
    }

    doc.catalog.set(pageLabelsName, doc.context.obj({Nums: nums}));
    return true;
}

function applyBookmarks(
    doc: PDFDocument,
    bookmarksDirty: boolean,
    bookmarkItems: IPdfBookmarkEntry[],
    totalPages: number,
    untitledLabel: string,
) {
    if (!bookmarksDirty) {
        return false;
    }

    const normalizedBookmarks = normalizeBookmarkEntries(bookmarkItems, totalPages, untitledLabel);
    return writeBookmarkOutlines(doc, normalizedBookmarks);
}

async function applyPlacedImage(
    doc: PDFDocument,
    placement: IPdfSerializedPlacedImagePayload | null,
) {
    if (!placement || placement.bytes.length === 0) {
        return false;
    }

    const page = doc.getPages()[placement.pageNumber - 1];
    if (!page) {
        return false;
    }

    const pageView = resolvePdfPageView(page);
    if (!pageView) {
        return false;
    }

    const embedMimeType = placement.mimeType;
    const embeddedImage = embedMimeType === 'image/jpeg'
        ? await doc.embedJpg(placement.bytes)
        : await doc.embedPng(placement.bytes);

    const pageRotation = normalizePageRotation(page.getRotation().angle);
    const pdfRect = toPdfRectFromMarkerRect({
        left: placement.x,
        top: placement.y,
        width: placement.width,
        height: placement.height,
    }, pageView, pageRotation);
    if (!pdfRect) {
        return false;
    }

    const x = Math.min(pdfRect[0], pdfRect[2]);
    const y = Math.min(pdfRect[1], pdfRect[3]);
    const width = Math.abs(pdfRect[2] - pdfRect[0]);
    const height = Math.abs(pdfRect[3] - pdfRect[1]);
    if (width <= 0 || height <= 0) {
        return false;
    }

    const rotationDegrees = 0 - (placement.rotationDegrees ?? 0);
    const radians = (rotationDegrees * Math.PI) / 180;
    const absCos = Math.abs(Math.cos(radians));
    const absSin = Math.abs(Math.sin(radians));
    const bboxWidth = (width * absCos) + (height * absSin);
    const bboxHeight = (width * absSin) + (height * absCos);
    const bboxCenterX = bboxWidth / 2;
    const bboxCenterY = bboxHeight / 2;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const rotatedHalfWidth = ((width / 2) * cos) - ((height / 2) * sin);
    const rotatedHalfHeight = ((width / 2) * sin) + ((height / 2) * cos);
    const imageX = bboxCenterX - rotatedHalfWidth;
    const imageY = bboxCenterY - rotatedHalfHeight;
    const imageName = doc.context.addRandomSuffix('Image', 10);
    const appearanceRef = doc.context.register(
        doc.context.formXObject(
            drawImage(imageName, {
                x: imageX,
                y: imageY,
                width,
                height,
                rotate: degrees(rotationDegrees),
                xSkew: degrees(0),
                ySkew: degrees(0),
            }),
            {
                Resources: { XObject: { [imageName]: embeddedImage.ref } },
                BBox: doc.context.obj([
                    0,
                    0,
                    bboxWidth,
                    bboxHeight,
                ]),
                Matrix: doc.context.obj([
                    1,
                    0,
                    0,
                    1,
                    0,
                    0,
                ]),
            },
        ),
    );
    const rectOffsetX = (bboxWidth - width) / 2;
    const rectOffsetY = (bboxHeight - height) / 2;
    const stampDict = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Stamp'),
        Rect: doc.context.obj([
            PDFNumber.of(x - rectOffsetX),
            PDFNumber.of(y - rectOffsetY),
            PDFNumber.of(x + width + rectOffsetX),
            PDFNumber.of(y + height + rectOffsetY),
        ]),
        AP: doc.context.obj({ N: appearanceRef }),
        F: PDFNumber.of(4),
        NM: PDFHexString.fromText(`placed-image-${crypto.randomUUID()}`),
        Name: PDFName.of('Approved'),
    });
    appendAnnotationRefToPage(page, doc, doc.context.register(stampDict));
    return true;
}

function hasSaveWork(payload: IPdfSerializationSavePayload) {
    return payload.markupSubtypeOverrides.length > 0
        || payload.markupSubtypeHints.length > 0
        || payload.rewriteShapeState
        || payload.shapes.length > 0
        || payload.deletedShapeAnnotationIds.length > 0
        || payload.deletedShapeStableKeys.length > 0
        || payload.freeTextComments.length > 0
        || payload.pendingEmbeddedTextUpdates.length > 0
        || payload.pendingEmbeddedAnnotationDeletes.length > 0
        || payload.pageLabelsDirty
        || payload.bookmarksDirty
        || Boolean(payload.placedImage);
}

export async function serializePdfEdits(
    data: Uint8Array,
    payload: IPdfSerializationSavePayload,
) {
    if (!hasSaveWork(payload)) {
        return data;
    }

    const doc = await PDFDocument.load(data, { updateMetadata: false });
    let modified = false;

    modified = applyMarkupSubtypeRewrites(doc, payload.markupSubtypeOverrides, payload.markupSubtypeHints) || modified;
    modified = applyShapeAnnotations(
        doc,
        payload.shapes,
        payload.deletedShapeAnnotationIds,
        payload.deletedShapeStableKeys,
        payload.rewriteShapeState,
    ) || modified;
    modified = applyEmbeddedAnnotationDeletes(doc, payload.pendingEmbeddedAnnotationDeletes) || modified;
    modified = applyFreeTextNoteRects(doc, payload.freeTextComments) || modified;
    modified = applyEmbeddedNoteTextUpdates(doc, payload.annotationComments, payload.pendingEmbeddedTextUpdates) || modified;
    modified = applyPageLabels(doc, payload.pageLabelsDirty, payload.pageLabelRanges, payload.totalPages) || modified;
    modified = applyBookmarks(
        doc,
        payload.bookmarksDirty,
        payload.bookmarkItems,
        payload.totalPages,
        payload.untitledBookmarkLabel,
    ) || modified;
    modified = await applyPlacedImage(doc, payload.placedImage) || modified;

    if (!modified) {
        return data;
    }

    return new Uint8Array(await doc.save());
}

export async function updateEmbeddedAnnotationText(
    data: Uint8Array,
    comment: IAnnotationCommentSummary,
    text: string,
) {
    const doc = await PDFDocument.load(data, { updateMetadata: false });
    const targetRef = resolveCommentPdfRefInDocument(doc, comment);
    if (!targetRef) {
        return null;
    }

    if (!updateAnnotationTextByRef(doc, targetRef, text)) {
        return null;
    }

    return new Uint8Array(await doc.save());
}

export async function deleteEmbeddedAnnotation(
    data: Uint8Array,
    comment: IAnnotationCommentSummary,
) {
    const doc = await PDFDocument.load(data, { updateMetadata: false });
    const targetRef = resolveCommentPdfRefInDocument(doc, comment);
    if (!targetRef) {
        return null;
    }

    const refsToDelete = collectAnnotationRefsToDelete(doc, targetRef);
    if (!removeAnnotationRefsFromPages(doc, refsToDelete)) {
        return null;
    }

    return new Uint8Array(await doc.save());
}
