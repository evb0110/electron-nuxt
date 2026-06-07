import type {
    ComputedRef,
    Ref,
} from 'vue';
import { groupBy } from 'es-toolkit/array';
import type {
    IAnnotationSettings,
    IShapeAnnotation,
    IShapePoint,
    TDrawableShapeType,
    TShapeResizeHandle,
} from '@app/types/annotations';
import { isShapeTool } from '@app/utils/pdf-viewer/annotations/annotation-rules/isShapeTool';
import { generateManagedShapeStableKey } from '@app/utils/pdf-viewer/pdf-serialization-refs/generateManagedShapeStableKey';
import { normalizeManagedShapeStableKey } from '@app/utils/pdf-viewer/pdf-serialization-refs/normalizeManagedShapeStableKey';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import { getPointMinMaxBounds } from '@app/utils/pdf-viewer/pdf-shape-resize/getPointMinMaxBounds';
import { toShapeRect } from '@app/utils/pdf-viewer/pdf-shape-resize/toShapeRect';
import { cloneShapePoints } from '@app/utils/pdf-viewer/pdf-shape-strokes/cloneShapePoints';
import { cloneShapeStrokes } from '@app/utils/pdf-viewer/pdf-shape-strokes/cloneShapeStrokes';
import { getAllShapePoints } from '@app/utils/pdf-viewer/pdf-shape-strokes/getAllShapePoints';
import { BrowserLogger } from '@app/utils/browserLogger';

function generateShapeId() {
    return `shape-${crypto.randomUUID()}`;
}

function normalizeComparableNumber(value: number | null | undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }

    return Number(value.toFixed(6));
}

const MIN_DRAWN_SHAPE_SIZE = 0.005;

export interface IShapeContextProvide {
    selectedShapeId: Ref<string | null>;
    focusedShapeId: Ref<string | null>;
    drawingShape: Ref<IShapeAnnotation | null>;
    isShapeToolActive: ComputedRef<boolean>;
    isAnyAnnotationToolActive: ComputedRef<boolean>;
    isSelectionToolActive: ComputedRef<boolean>;
    activeShapeTool: ComputedRef<TDrawableShapeType | null>;
    settings: Ref<IAnnotationSettings>;
    getShapesForPage: (pageIndex: number) => IShapeAnnotation[];
    handleStartDrawing: (pageIndex: number, coords: {
        x: number;
        y: number 
    }) => void;
    handleContinueDrawing: (coords: {
        x: number;
        y: number 
    }) => void;
    handleFinishDrawing: () => void;
    handleSelectShape: (id: string | null) => void;
    handleStartDraggingShape: (shapeId: string, coords: {
        x: number;
        y: number
    }) => void;
    handleContinueDraggingShape: (coords: {
        x: number;
        y: number
    }) => void;
    handleFinishDraggingShape: () => void;
    handleStartResizingShape: (shapeId: string, handle: TShapeResizeHandle, coords: {
        x: number;
        y: number
    }) => void;
    handleContinueResizingShape: (coords: {
        x: number;
        y: number
    }) => void;
    handleFinishResizingShape: () => void;
    handleShapeContextMenu: (payload: {
        shapeId: string;
        clientX: number;
        clientY: number;
    }) => void;
}

export interface IShapeStateSnapshot {
    shapes: IShapeAnnotation[];
    deletedAnnotationIds: string[];
    deletedStableKeys: string[];
    baselineSignature: string;
    selectedShapeId: string | null;
}

export interface IBuildShapeAnnotationOptions {
    pageIndex: number;
    tool: TDrawableShapeType;
    x: number;
    y: number;
    width?: number | undefined;
    height?: number | undefined;
    x2?: number | undefined;
    y2?: number | undefined;
    points?: IShapePoint[] | undefined;
    strokes?: IShapePoint[][] | undefined;
    color?: string | undefined;
    fillColor?: string | null | undefined;
    opacity?: number | undefined;
    strokeWidth?: number | undefined;
}

export const useAnnotationShapes = () => {
    const shapes = ref<Map<number, IShapeAnnotation[]>>(new Map());
    const selectedShapeId = ref<string | null>(null);
    const focusedShapeId = ref<string | null>(null);
    const drawingShape = ref<IShapeAnnotation | null>(null);
    const isDrawing = ref(false);
    const deletedEmbeddedAnnotationIds = ref<Set<string>>(new Set());
    const deletedEmbeddedShapeStableKeys = ref<Set<string>>(new Set());
    const baselineSignature = ref('[]');
    let drawOrigin: {
        x: number;
        y: number 
    } | null = null;

    function cloneShape(shape: IShapeAnnotation): IShapeAnnotation {
        return {
            ...shape,
            points: cloneShapePoints(shape.points),
            strokes: cloneShapeStrokes(shape.strokes),
        };
    }

    function groupShapesByPage(input: IShapeAnnotation[]) {
        return new Map(
            Object.entries(groupBy(input, shape => shape.pageIndex))
                .map(([
                    pageIndex,
                    shapes,
                ]) => ([
                    Number(pageIndex),
                    shapes,
                ])),
        );
    }

    function replaceShapeState(
        nextShapes: IShapeAnnotation[],
        options?: {
            deletedIds?: Set<string>;
            deletedStableKeys?: Set<string>;
            baselineShapes?: IShapeAnnotation[];
            baselineSignatureValue?: string;
        },
    ) {
        shapes.value = groupShapesByPage(nextShapes);
        deletedEmbeddedAnnotationIds.value = new Set(options?.deletedIds ?? []);
        deletedEmbeddedShapeStableKeys.value = new Set(options?.deletedStableKeys ?? []);
        baselineSignature.value = options?.baselineSignatureValue
            ?? toShapesSignature(options?.baselineShapes ?? nextShapes);

        BrowserLogger.debug('pdf-shapes', 'Replaced shape state', () => ({
            shapeCount: nextShapes.length,
            embeddedCount: nextShapes.filter(shape => shape.source === 'embedded').length,
            localCount: nextShapes.filter(shape => shape.source !== 'embedded').length,
            deletedAnnotationIds: [...deletedEmbeddedAnnotationIds.value],
            deletedStableKeys: [...deletedEmbeddedShapeStableKeys.value],
            baselineShapeCount: options?.baselineShapes?.length ?? nextShapes.length,
            usedExplicitBaselineSignature: typeof options?.baselineSignatureValue === 'string',
        }));

        if (selectedShapeId.value && !nextShapes.some(shape => shape.id === selectedShapeId.value)) {
            selectedShapeId.value = null;
        }
        if (focusedShapeId.value && !nextShapes.some(shape => shape.id === focusedShapeId.value)) {
            focusedShapeId.value = null;
        }
    }

    function resolveShapeBounds(shape: Pick<IShapeAnnotation, 'x' | 'y' | 'width' | 'height' | 'points' | 'strokes'>) {
        const bounds = getPointMinMaxBounds(getAllShapePoints(shape));
        if (!bounds) {
            return {
                x: shape.x,
                y: shape.y,
                width: shape.width,
                height: shape.height,
            };
        }

        const rect = toShapeRect(bounds, 0.0001);
        return {
            x: rect.minX,
            y: rect.minY,
            width: rect.maxX - rect.minX,
            height: rect.maxY - rect.minY,
        };
    }

    function appendDrawPoint(points: IShapePoint[], x: number, y: number) {
        const lastPoint = points[points.length - 1];
        if (!lastPoint) {
            return [
                ...points,
                {
                    x,
                    y,
                },
            ];
        }

        if (Math.hypot(lastPoint.x - x, lastPoint.y - y) < 0.001) {
            return points;
        }

        return [
            ...points,
            {
                x,
                y,
            },
        ];
    }

    function getShapePathLength(points: IShapePoint[]) {
        let length = 0;
        for (let index = 1; index < points.length; index += 1) {
            const previous = points[index - 1];
            const current = points[index];
            if (!previous || !current) {
                continue;
            }
            length += Math.hypot(current.x - previous.x, current.y - previous.y);
        }
        return length;
    }

    function isLineLikeShape(shape: IShapeAnnotation) {
        return shape.type === 'line' || shape.type === 'arrow';
    }

    function createInitialDrawPoint(x: number, y: number): IShapePoint {
        return {
            x,
            y,
        };
    }

    function resolveDrawingFillColor(tool: TDrawableShapeType, settings: IAnnotationSettings) {
        if (tool === 'draw' || settings.shapeFillColor === 'transparent') {
            return undefined;
        }
        return settings.shapeFillColor;
    }

    function resolveDrawingShapeType(tool: TDrawableShapeType) {
        return tool === 'draw' ? 'polyline' : tool;
    }

    function resolveDrawingStyle(tool: TDrawableShapeType, settings: IAnnotationSettings) {
        if (tool === 'draw') {
            return {
                color: settings.inkColor,
                opacity: settings.inkOpacity,
                strokeWidth: settings.inkThickness,
                fillColor: undefined,
            };
        }

        return {
            color: settings.shapeColor,
            opacity: settings.shapeOpacity,
            strokeWidth: settings.shapeStrokeWidth,
            fillColor: resolveDrawingFillColor(tool, settings),
        };
    }

    function clampUnit(value: number) {
        if (!Number.isFinite(value)) {
            return 0;
        }
        return Math.min(1, Math.max(0, value));
    }

    function normalizeOptionalPoint(value: number | undefined, fallback: number) {
        return typeof value === 'number' && Number.isFinite(value)
            ? clampUnit(value)
            : fallback;
    }

    function normalizeOptionalPositiveNumber(value: number | undefined, fallback: number) {
        return typeof value === 'number' && Number.isFinite(value)
            ? Math.max(0, value)
            : fallback;
    }

    function normalizeStyleColor(value: string | undefined, fallback: string) {
        const color = value?.trim();
        return color ? color : fallback;
    }

    function normalizeGeometryPoint(point: IShapePoint): IShapePoint {
        return {
            x: clampUnit(point.x),
            y: clampUnit(point.y),
        };
    }

    function normalizeGeometryPoints(points: IShapePoint[] | undefined) {
        const normalized = points
            ?.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
            .map(normalizeGeometryPoint)
            ?? [];
        return normalized.length > 0 ? normalized : null;
    }

    function normalizeGeometryStrokes(strokes: IShapePoint[][] | undefined) {
        const normalized = strokes
            ?.map(points => normalizeGeometryPoints(points) ?? [])
            .filter(points => points.length > 0)
            ?? [];
        return normalized.length > 0 ? normalized : null;
    }

    function resolveGeometryFillColor(
        tool: TDrawableShapeType,
        settings: IAnnotationSettings,
        fillColor: string | null | undefined,
    ) {
        if (fillColor === null || fillColor === 'transparent') {
            return undefined;
        }

        const normalized = fillColor?.trim();
        return normalized || resolveDrawingFillColor(tool, settings);
    }

    function applyGeometryStyle(
        shape: IShapeAnnotation,
        tool: TDrawableShapeType,
        settings: IAnnotationSettings,
        options: IBuildShapeAnnotationOptions,
    ): IShapeAnnotation {
        const style = resolveDrawingStyle(tool, settings);
        return {
            ...shape,
            color: normalizeStyleColor(options.color, style.color),
            fillColor: resolveGeometryFillColor(tool, settings, options.fillColor),
            opacity: Math.min(1, normalizeOptionalPositiveNumber(options.opacity, style.opacity)),
            strokeWidth: normalizeOptionalPositiveNumber(options.strokeWidth, style.strokeWidth),
        };
    }

    function applyBoxGeometry(shape: IShapeAnnotation, options: IBuildShapeAnnotationOptions): IShapeAnnotation {
        const startX = clampUnit(options.x);
        const startY = clampUnit(options.y);
        const hasEndPoint = typeof options.x2 === 'number' || typeof options.y2 === 'number';
        if (hasEndPoint) {
            const endX = normalizeOptionalPoint(options.x2, startX);
            const endY = normalizeOptionalPoint(options.y2, startY);
            const minX = Math.min(startX, endX);
            const minY = Math.min(startY, endY);
            return {
                ...shape,
                x: minX,
                y: minY,
                width: Math.abs(endX - startX),
                height: Math.abs(endY - startY),
            };
        }

        return {
            ...shape,
            x: startX,
            y: startY,
            width: Math.min(1 - startX, normalizeOptionalPositiveNumber(options.width, 0)),
            height: Math.min(1 - startY, normalizeOptionalPositiveNumber(options.height, 0)),
        };
    }

    function applyLineGeometry(shape: IShapeAnnotation, options: IBuildShapeAnnotationOptions): IShapeAnnotation {
        const x = clampUnit(options.x);
        const y = clampUnit(options.y);
        const x2 = normalizeOptionalPoint(
            options.x2,
            Math.min(1, x + normalizeOptionalPositiveNumber(options.width, 0)),
        );
        const y2 = normalizeOptionalPoint(
            options.y2,
            Math.min(1, y + normalizeOptionalPositiveNumber(options.height, 0)),
        );

        return {
            ...shape,
            x,
            y,
            x2,
            y2,
            width: Math.abs(x2 - x),
            height: Math.abs(y2 - y),
        };
    }

    function applyInkGeometry(shape: IShapeAnnotation, options: IBuildShapeAnnotationOptions): IShapeAnnotation {
        const fallbackPoints = [
            {
                x: clampUnit(options.x),
                y: clampUnit(options.y),
            },
            {
                x: normalizeOptionalPoint(options.x2, clampUnit(options.x)),
                y: normalizeOptionalPoint(options.y2, clampUnit(options.y)),
            },
        ];
        const strokes = normalizeGeometryStrokes(options.strokes)
            ?? (normalizeGeometryPoints(options.points)
                ? [normalizeGeometryPoints(options.points)!]
                : [fallbackPoints]);
        const points = strokes[0] ?? fallbackPoints;
        return {
            ...shape,
            ...resolveShapeBounds({
                ...shape,
                points,
                strokes,
            }),
            points,
            strokes,
            pdfSubtype: 'Ink',
        };
    }

    function createLineDrawingGeometry(tool: TDrawableShapeType, x: number, y: number) {
        if (tool !== 'line' && tool !== 'arrow') {
            return {};
        }

        return {
            x2: x,
            y2: y,
        };
    }

    function createInkDrawingGeometry(tool: TDrawableShapeType, x: number, y: number) {
        if (tool !== 'draw') {
            return {};
        }

        return {
            points: [createInitialDrawPoint(x, y)],
            strokes: [[createInitialDrawPoint(x, y)]],
            pdfSubtype: 'Ink' as const,
        };
    }

    function createArrowDrawingGeometry(tool: TDrawableShapeType) {
        if (tool !== 'arrow') {
            return {};
        }

        return { lineEndStyle: 'closedArrow' as const };
    }

    function createDrawingShape(
        pageIndex: number,
        tool: TDrawableShapeType,
        x: number,
        y: number,
        settings: IAnnotationSettings,
    ): IShapeAnnotation {
        const style = resolveDrawingStyle(tool, settings);
        const createdAt = Date.now();
        return {
            id: generateShapeId(),
            type: resolveDrawingShapeType(tool),
            pageIndex,
            x,
            y,
            width: 0,
            height: 0,
            ...createLineDrawingGeometry(tool, x, y),
            ...style,
            ...createInkDrawingGeometry(tool, x, y),
            source: 'local',
            stableKey: generateManagedShapeStableKey(),
            ...createArrowDrawingGeometry(tool),
            createdAt,
            modifiedAt: createdAt,
        };
    }

    function buildShapeAnnotation(
        options: IBuildShapeAnnotationOptions,
        settings: IAnnotationSettings,
    ): IShapeAnnotation | null {
        const baseShape = applyGeometryStyle(
            createDrawingShape(
                Math.max(0, Math.trunc(options.pageIndex)),
                options.tool,
                clampUnit(options.x),
                clampUnit(options.y),
                settings,
            ),
            options.tool,
            settings,
            options,
        );
        const shape = (() => {
            if (options.tool === 'draw') {
                return applyInkGeometry(baseShape, options);
            }
            if (options.tool === 'line' || options.tool === 'arrow') {
                return applyLineGeometry(baseShape, options);
            }
            return applyBoxGeometry(baseShape, options);
        })();

        return isDrawableFinishedShape(shape)
            ? shape
            : null;
    }

    function isDrawableFinishedShape(shape: IShapeAnnotation) {
        if (shape.type === 'polyline') {
            const points = shape.strokes?.[0] ?? shape.points ?? [];
            return points.length >= 2 && getShapePathLength(points) >= MIN_DRAWN_SHAPE_SIZE;
        }

        if (isLineLikeShape(shape)) {
            const dx = (shape.x2 ?? shape.x) - shape.x;
            const dy = (shape.y2 ?? shape.y) - shape.y;
            return Math.hypot(dx, dy) >= MIN_DRAWN_SHAPE_SIZE;
        }

        return shape.width >= MIN_DRAWN_SHAPE_SIZE && shape.height >= MIN_DRAWN_SHAPE_SIZE;
    }

    function resetDrawingState() {
        isDrawing.value = false;
        drawingShape.value = null;
        drawOrigin = null;
    }

    function toComparableShape(shape: IShapeAnnotation) {
        const comparable = {
            annotationId: normalizePdfJsAnnotationId(shape.annotationId) ?? shape.annotationId ?? null,
            color: shape.color,
            fillColor: shape.fillColor ?? null,
            height: shape.height,
            lineEndStyle: shape.lineEndStyle ?? null,
            lineStartStyle: shape.lineStartStyle ?? null,
            opacity: shape.opacity,
            pageIndex: shape.pageIndex,
            pdfSubtype: shape.pdfSubtype ?? null,
            stableKey: normalizeManagedShapeStableKey(shape.stableKey) ?? null,
            points: shape.points?.map(point => ({
                x: point.x,
                y: point.y,
            })) ?? null,
            strokes: shape.strokes?.map(points => points.map(point => ({
                x: point.x,
                y: point.y,
            }))) ?? null,
            source: shape.source ?? 'local',
            strokeWidth: shape.strokeWidth,
            type: shape.type,
            width: shape.width,
            x: shape.x,
            x2: shape.x2 ?? null,
            y: shape.y,
            y2: shape.y2 ?? null,
        };
        return comparable;
    }

    function toReconciliationKey(shape: IShapeAnnotation) {
        return JSON.stringify({
            color: shape.color,
            fillColor: shape.fillColor ?? null,
            height: normalizeComparableNumber(shape.height),
            lineEndStyle: shape.lineEndStyle ?? null,
            lineStartStyle: shape.lineStartStyle ?? null,
            opacity: normalizeComparableNumber(shape.opacity),
            pageIndex: shape.pageIndex,
            pdfSubtype: shape.pdfSubtype ?? null,
            stableKey: normalizeManagedShapeStableKey(shape.stableKey) ?? null,
            points: shape.points?.map(point => ({
                x: normalizeComparableNumber(point.x),
                y: normalizeComparableNumber(point.y),
            })) ?? null,
            strokes: shape.strokes?.map(points => points.map(point => ({
                x: normalizeComparableNumber(point.x),
                y: normalizeComparableNumber(point.y),
            }))) ?? null,
            strokeWidth: normalizeComparableNumber(shape.strokeWidth),
            type: shape.type,
            width: normalizeComparableNumber(shape.width),
            x: normalizeComparableNumber(shape.x),
            x2: normalizeComparableNumber(shape.x2),
            y: normalizeComparableNumber(shape.y),
            y2: normalizeComparableNumber(shape.y2),
        });
    }

    function mergeImportedShape(currentShape: IShapeAnnotation, importedShape: IShapeAnnotation): IShapeAnnotation {
        return {
            ...cloneShape(importedShape),
            id: currentShape.id,
        };
    }

    function mergeImportedShapeMetadata(currentShape: IShapeAnnotation, importedShape: IShapeAnnotation): IShapeAnnotation {
        return {
            ...cloneShape(currentShape),
            source: importedShape.source ?? 'embedded',
            annotationId: importedShape.annotationId ?? currentShape.annotationId ?? null,
            stableKey: importedShape.stableKey ?? currentShape.stableKey ?? null,
            pdfSubtype: importedShape.pdfSubtype ?? currentShape.pdfSubtype ?? null,
            lineStartStyle: importedShape.lineStartStyle ?? currentShape.lineStartStyle,
            lineEndStyle: importedShape.lineEndStyle ?? currentShape.lineEndStyle,
        };
    }

    function matchesDeletedImportedShape(
        shape: IShapeAnnotation,
        deletedAnnotationIds: Set<string>,
        deletedStableKeys: Set<string>,
    ) {
        const annotationId = normalizePdfJsAnnotationId(shape.annotationId);
        if (annotationId && deletedAnnotationIds.has(annotationId)) {
            return true;
        }

        const stableKey = normalizeManagedShapeStableKey(shape.stableKey);
        if (stableKey && deletedStableKeys.has(stableKey)) {
            return true;
        }

        return false;
    }

    function toShapesSignature(input: IShapeAnnotation[]) {
        const comparable = input
            .map(shape => toComparableShape(shape))
            .sort((left, right) => (
                left.pageIndex - right.pageIndex
                || (left.annotationId ?? left.type).localeCompare(right.annotationId ?? right.type)
                || left.x - right.x
                || left.y - right.y
            ));
        return JSON.stringify(comparable);
    }

    function getShapesForPage(pageIndex: number) {
        return shapes.value.get(pageIndex) ?? [];
    }

    function getAllShapes() {
        const all: IShapeAnnotation[] = [];
        for (const pageShapes of shapes.value.values()) {
            all.push(...pageShapes);
        }
        return all;
    }

    function getShapeById(id: string) {
        for (const pageShapes of shapes.value.values()) {
            const shape = pageShapes.find(s => s.id === id);
            if (shape) {
                return shape;
            }
        }
        return null;
    }

    function getDeletedEmbeddedAnnotationIds() {
        return [...deletedEmbeddedAnnotationIds.value];
    }

    function getDeletedEmbeddedShapeStableKeys() {
        return [...deletedEmbeddedShapeStableKeys.value];
    }

    function getManagedEmbeddedAnnotationIds() {
        const ids = new Set(deletedEmbeddedAnnotationIds.value);
        for (const shape of getAllShapes()) {
            if (shape.source === 'embedded' && shape.annotationId) {
                ids.add(shape.annotationId);
            }
        }
        return [...ids];
    }

    type TShapeHistoryMatchKind = 'none' | 'durable' | 'fallback';

    function shapeHistoryMatchKind(candidate: IShapeAnnotation, reference: IShapeAnnotation): TShapeHistoryMatchKind {
        if (candidate.id === reference.id) {
            return 'durable';
        }

        const candidateStableKey = normalizeManagedShapeStableKey(candidate.stableKey);
        const referenceStableKey = normalizeManagedShapeStableKey(reference.stableKey);
        if (candidateStableKey && referenceStableKey && candidateStableKey === referenceStableKey) {
            return 'durable';
        }

        const candidateAnnotationId = normalizePdfJsAnnotationId(candidate.annotationId);
        const referenceAnnotationId = normalizePdfJsAnnotationId(reference.annotationId);
        if (candidateAnnotationId && referenceAnnotationId && candidateAnnotationId === referenceAnnotationId) {
            return 'durable';
        }

        return toReconciliationKey(candidate) === toReconciliationKey(reference)
            ? 'fallback'
            : 'none';
    }

    function removeShapeHistoryReferenceMatches(input: IShapeAnnotation[], reference: IShapeAnnotation) {
        const durableMatches = new Set(
            input
                .filter(candidate => shapeHistoryMatchKind(candidate, reference) === 'durable')
                .map(candidate => candidate.id),
        );

        if (durableMatches.size > 0) {
            return input.filter(candidate => !durableMatches.has(candidate.id));
        }

        let removedFallback = false;
        return input.filter((candidate) => {
            if (!removedFallback && shapeHistoryMatchKind(candidate, reference) === 'fallback') {
                removedFallback = true;
                return false;
            }
            return true;
        });
    }

    function getShapeHistoryReferenceMatchIds(reference: IShapeAnnotation) {
        const allShapes = getAllShapes();
        const durableMatchIds = allShapes
            .filter(candidate => shapeHistoryMatchKind(candidate, reference) === 'durable')
            .map(candidate => candidate.id);
        if (durableMatchIds.length > 0) {
            return new Set(durableMatchIds);
        }

        const fallbackMatch = allShapes.find(candidate => shapeHistoryMatchKind(candidate, reference) === 'fallback');
        return new Set(fallbackMatch ? [fallbackMatch.id] : []);
    }

    function addShape(shape: IShapeAnnotation) {
        const nextShapes = removeShapeHistoryReferenceMatches(getAllShapes(), shape);
        nextShapes.push(cloneShape(shape));
        shapes.value = groupShapesByPage(nextShapes);
        shapes.value = new Map(shapes.value);
        if (shape.annotationId) {
            const nextDeletedIds = new Set(deletedEmbeddedAnnotationIds.value);
            nextDeletedIds.delete(shape.annotationId);
            deletedEmbeddedAnnotationIds.value = nextDeletedIds;
        }
        if (shape.stableKey) {
            const nextDeletedStableKeys = new Set(deletedEmbeddedShapeStableKeys.value);
            nextDeletedStableKeys.delete(shape.stableKey);
            deletedEmbeddedShapeStableKeys.value = nextDeletedStableKeys;
        }
    }

    function markDeletedEmbeddedShape(deletedShape: IShapeAnnotation) {
        if (deletedShape.source === 'embedded' && deletedShape.annotationId) {
            const nextDeletedIds = new Set(deletedEmbeddedAnnotationIds.value);
            nextDeletedIds.add(deletedShape.annotationId);
            deletedEmbeddedAnnotationIds.value = nextDeletedIds;
        }
        if (deletedShape.source === 'embedded' && deletedShape.stableKey) {
            const nextDeletedStableKeys = new Set(deletedEmbeddedShapeStableKeys.value);
            nextDeletedStableKeys.add(deletedShape.stableKey);
            deletedEmbeddedShapeStableKeys.value = nextDeletedStableKeys;
        }
    }

    function deleteShapesByPredicate(
        predicate: (shape: IShapeAnnotation) => boolean,
        debugReference: Pick<IShapeAnnotation, 'id' | 'source' | 'annotationId' | 'stableKey' | 'pageIndex' | 'color'>,
    ) {
        const deletedShapes: IShapeAnnotation[] = [];
        const nextShapes = getAllShapes().filter((shape) => {
            if (!predicate(shape)) {
                return true;
            }
            deletedShapes.push(shape);
            return false;
        });

        if (deletedShapes.length === 0) {
            return [];
        }

        BrowserLogger.debug('pdf-shapes', 'Deleting shape', () => ({
            id: debugReference.id,
            source: debugReference.source,
            annotationId: debugReference.annotationId ?? null,
            stableKey: debugReference.stableKey ?? null,
            pageIndex: debugReference.pageIndex,
            color: debugReference.color,
            deletedCount: deletedShapes.length,
            deletedAnnotationIdsBefore: [...deletedEmbeddedAnnotationIds.value],
            deletedStableKeysBefore: [...deletedEmbeddedShapeStableKeys.value],
        }));

        for (const deletedShape of deletedShapes) {
            markDeletedEmbeddedShape(deletedShape);
            if (selectedShapeId.value === deletedShape.id) {
                selectedShapeId.value = null;
            }
            if (focusedShapeId.value === deletedShape.id) {
                focusedShapeId.value = null;
            }
        }

        shapes.value = groupShapesByPage(nextShapes);
        shapes.value = new Map(shapes.value);

        BrowserLogger.debug('pdf-shapes', 'Deleted shape', () => ({
            id: debugReference.id,
            remainingShapeCount: getAllShapes().length,
            deletedAnnotationIdsAfter: [...deletedEmbeddedAnnotationIds.value],
            deletedStableKeysAfter: [...deletedEmbeddedShapeStableKeys.value],
        }));
        return deletedShapes.map(shape => cloneShape(shape));
    }

    function updateShape(id: string, updates: Partial<IShapeAnnotation>) {
        for (const [
            pageIndex,
            pageShapes,
        ] of shapes.value.entries()) {
            const index = pageShapes.findIndex(s => s.id === id);
            if (index !== -1) {
                const currentShape = pageShapes[index]!;
                const updatedAt = Date.now();
                pageShapes[index] = {
                    ...currentShape,
                    ...updates, 
                    points: updates.points ? cloneShapePoints(updates.points) : currentShape.points,
                    strokes: updates.strokes ? cloneShapeStrokes(updates.strokes) : currentShape.strokes,
                    createdAt: updates.createdAt ?? currentShape.createdAt ?? updatedAt,
                    modifiedAt: updatedAt,
                };
                shapes.value.set(pageIndex, [...pageShapes]);
                shapes.value = new Map(shapes.value);
                return;
            }
        }
    }

    function deleteShape(id: string) {
        const deletedShape = getShapeById(id);
        if (!deletedShape) {
            return;
        }
        deleteShapesByPredicate(shape => shape.id === id, deletedShape);
    }

    function deleteShapeByReference(reference: IShapeAnnotation) {
        const matchIds = getShapeHistoryReferenceMatchIds(reference);
        return deleteShapesByPredicate(
            shape => matchIds.has(shape.id),
            reference,
        );
    }

    function deleteSelectedShape() {
        if (selectedShapeId.value) {
            deleteShape(selectedShapeId.value);
        }
    }

    function selectShape(id: string | null) {
        selectedShapeId.value = id;
        focusedShapeId.value = null;
    }

    function focusShape(id: string | null) {
        focusedShapeId.value = id && getShapeById(id) ? id : null;
        selectedShapeId.value = null;
    }

    function clearShapes() {
        shapes.value = new Map();
        selectedShapeId.value = null;
        focusedShapeId.value = null;
        drawingShape.value = null;
        isDrawing.value = false;
        drawOrigin = null;
        deletedEmbeddedAnnotationIds.value = new Set();
        deletedEmbeddedShapeStableKeys.value = new Set();
        baselineSignature.value = '[]';
    }

    function replaceShapes(loaded: IShapeAnnotation[]) {
        replaceShapeState(
            loaded.map(shape => cloneShape(shape)),
            {
                deletedIds: new Set(),
                baselineShapes: loaded,
            },
        );
    }

    function findImportedShapeIndexForCurrentShape(
        currentShape: IShapeAnnotation,
        remainingImportedShapes: IShapeAnnotation[],
    ) {
        const currentStableKey = normalizeManagedShapeStableKey(currentShape.stableKey);
        const importedIndexByStableKey = currentStableKey
            ? remainingImportedShapes.findIndex(shape => normalizeManagedShapeStableKey(shape.stableKey) === currentStableKey)
            : -1;

        if (importedIndexByStableKey !== -1) {
            return importedIndexByStableKey;
        }

        const currentAnnotationId = normalizePdfJsAnnotationId(currentShape.annotationId);
        const importedIndexByAnnotationId = currentAnnotationId
            ? remainingImportedShapes.findIndex(shape => normalizePdfJsAnnotationId(shape.annotationId) === currentAnnotationId)
            : -1;

        if (importedIndexByAnnotationId !== -1) {
            return importedIndexByAnnotationId;
        }

        const currentShapeKey = toReconciliationKey(currentShape);
        return remainingImportedShapes.findIndex(
            shape => toReconciliationKey(shape) === currentShapeKey,
        );
    }

    function buildMergedPersistedShapes(
        currentShapes: IShapeAnnotation[],
        loaded: IShapeAnnotation[],
        currentDeletedIds: Set<string>,
        currentDeletedStableKeys: Set<string>,
    ) {
        const remainingImportedShapes = loaded.map(shape => cloneShape(shape));
        const nextShapes: IShapeAnnotation[] = [];

        for (const currentShape of currentShapes) {
            const importedIndex = findImportedShapeIndexForCurrentShape(currentShape, remainingImportedShapes);
            if (importedIndex !== -1) {
                const importedShape = remainingImportedShapes.splice(importedIndex, 1)[0]!;
                nextShapes.push(mergeImportedShape(currentShape, importedShape));
                continue;
            }

            if (currentShape.source !== 'embedded') {
                nextShapes.push(currentShape);
            }
        }

        nextShapes.push(
            ...remainingImportedShapes.filter(shape => !matchesDeletedImportedShape(
                shape,
                currentDeletedIds,
                currentDeletedStableKeys,
            )),
        );

        return nextShapes;
    }

    function buildMetadataPrimedPersistedShapes(
        currentShapes: IShapeAnnotation[],
        loaded: IShapeAnnotation[],
        currentDeletedIds: Set<string>,
        currentDeletedStableKeys: Set<string>,
    ) {
        const remainingImportedShapes = loaded.map(shape => cloneShape(shape));
        const nextShapes: IShapeAnnotation[] = [];

        for (const currentShape of currentShapes) {
            const importedIndex = findImportedShapeIndexForCurrentShape(currentShape, remainingImportedShapes);
            if (importedIndex !== -1) {
                const importedShape = remainingImportedShapes.splice(importedIndex, 1)[0]!;
                nextShapes.push(mergeImportedShapeMetadata(currentShape, importedShape));
                continue;
            }

            if (currentShape.source !== 'embedded') {
                nextShapes.push(currentShape);
            }
        }

        nextShapes.push(
            ...remainingImportedShapes.filter(shape => !matchesDeletedImportedShape(
                shape,
                currentDeletedIds,
                currentDeletedStableKeys,
            )),
        );

        return nextShapes;
    }

    function createPersistedShapeLoadDebugPayload(
        currentShapes: IShapeAnnotation[],
        loaded: IShapeAnnotation[],
        currentDeletedIds: Set<string>,
        currentDeletedStableKeys: Set<string>,
    ) {
        return {
            currentShapeCount: currentShapes.length,
            loadedShapeCount: loaded.length,
            currentEmbeddedCount: currentShapes.filter(shape => shape.source === 'embedded').length,
            loadedEmbeddedCount: loaded.filter(shape => shape.source === 'embedded').length,
            currentDeletedIds: [...currentDeletedIds],
            currentDeletedStableKeys: [...currentDeletedStableKeys],
        };
    }

    function preparePersistedShapeMerge(loaded: IShapeAnnotation[]) {
        const currentShapes = getAllShapes().map(shape => cloneShape(shape));
        const currentDeletedIds = new Set(deletedEmbeddedAnnotationIds.value);
        const currentDeletedStableKeys = new Set(deletedEmbeddedShapeStableKeys.value);
        const nextShapes = buildMergedPersistedShapes(
            currentShapes,
            loaded,
            currentDeletedIds,
            currentDeletedStableKeys,
        );

        return {
            currentShapes,
            currentDeletedIds,
            currentDeletedStableKeys,
            nextShapes,
        };
    }

    function reconcilePersistedShapes(loaded: IShapeAnnotation[]) {
        const {
            currentShapes,
            currentDeletedIds,
            currentDeletedStableKeys,
            nextShapes,
        } = preparePersistedShapeMerge(loaded);

        BrowserLogger.debug('pdf-shapes', 'Reconciling persisted shapes', () => createPersistedShapeLoadDebugPayload(
            currentShapes,
            loaded,
            currentDeletedIds,
            currentDeletedStableKeys,
        ));

        const nextDeletedIds = new Set<string>();
        const nextDeletedStableKeys = new Set<string>();
        currentDeletedIds.forEach((rawAnnotationId) => {
            const normalizedDeletedId = normalizePdfJsAnnotationId(rawAnnotationId);
            const stillPresentInImportedShapes = normalizedDeletedId
                ? loaded.some(shape => normalizePdfJsAnnotationId(shape.annotationId) === normalizedDeletedId)
                : loaded.some(shape => shape.annotationId === rawAnnotationId);

            if (stillPresentInImportedShapes) {
                nextDeletedIds.add(rawAnnotationId);
            }
        });
        currentDeletedStableKeys.forEach((rawStableKey) => {
            const normalizedDeletedStableKey = normalizeManagedShapeStableKey(rawStableKey);
            const stillPresentInImportedShapes = normalizedDeletedStableKey
                ? loaded.some(shape => normalizeManagedShapeStableKey(shape.stableKey) === normalizedDeletedStableKey)
                : loaded.some(shape => shape.stableKey === rawStableKey);

            if (stillPresentInImportedShapes) {
                nextDeletedStableKeys.add(rawStableKey);
            }
        });

        replaceShapeState(nextShapes, {
            deletedIds: nextDeletedIds,
            deletedStableKeys: nextDeletedStableKeys,
            baselineShapes: loaded,
        });

        BrowserLogger.debug('pdf-shapes', 'Reconciled persisted shapes', () => ({
            nextShapeCount: nextShapes.length,
            nextEmbeddedCount: nextShapes.filter(shape => shape.source === 'embedded').length,
            nextLocalCount: nextShapes.filter(shape => shape.source !== 'embedded').length,
            nextDeletedIds: [...nextDeletedIds],
            nextDeletedStableKeys: [...nextDeletedStableKeys],
        }));
    }

    function primePersistedShapes(loaded: IShapeAnnotation[]) {
        const preservedBaselineSignature = baselineSignature.value;
        const currentShapes = getAllShapes().map(shape => cloneShape(shape));
        const currentDeletedIds = new Set(deletedEmbeddedAnnotationIds.value);
        const currentDeletedStableKeys = new Set(deletedEmbeddedShapeStableKeys.value);
        const nextShapes = buildMetadataPrimedPersistedShapes(
            currentShapes,
            loaded,
            currentDeletedIds,
            currentDeletedStableKeys,
        );

        BrowserLogger.debug('pdf-shapes', 'Priming persisted shapes before save', () => createPersistedShapeLoadDebugPayload(
            currentShapes,
            loaded,
            currentDeletedIds,
            currentDeletedStableKeys,
        ));

        replaceShapeState(nextShapes, {
            deletedIds: currentDeletedIds,
            deletedStableKeys: currentDeletedStableKeys,
            baselineSignatureValue: preservedBaselineSignature,
        });

        BrowserLogger.debug('pdf-shapes', 'Primed persisted shapes before save', () => ({
            nextShapeCount: nextShapes.length,
            nextEmbeddedCount: nextShapes.filter(shape => shape.source === 'embedded').length,
            nextLocalCount: nextShapes.filter(shape => shape.source !== 'embedded').length,
            preservedDirtyState: true,
            deletedIds: [...currentDeletedIds],
            deletedStableKeys: [...currentDeletedStableKeys],
        }));
    }

    function adoptPersistedShapeMetadata(loaded: IShapeAnnotation[]) {
        const currentShapes = getAllShapes().map(shape => cloneShape(shape));
        const currentDeletedIds = new Set(deletedEmbeddedAnnotationIds.value);
        const currentDeletedStableKeys = new Set(deletedEmbeddedShapeStableKeys.value);
        const nextShapes = buildMetadataPrimedPersistedShapes(
            currentShapes,
            loaded,
            currentDeletedIds,
            currentDeletedStableKeys,
        );

        BrowserLogger.debug('pdf-shapes', 'Adopting persisted shape metadata after save', () => createPersistedShapeLoadDebugPayload(
            currentShapes,
            loaded,
            currentDeletedIds,
            currentDeletedStableKeys,
        ));

        replaceShapeState(nextShapes, {
            deletedIds: new Set(),
            deletedStableKeys: new Set(),
            baselineShapes: nextShapes,
        });

        BrowserLogger.debug('pdf-shapes', 'Adopted persisted shape metadata after save', () => ({
            nextShapeCount: nextShapes.length,
            nextEmbeddedCount: nextShapes.filter(shape => shape.source === 'embedded').length,
            nextLocalCount: nextShapes.filter(shape => shape.source !== 'embedded').length,
            clearedDeletedIds: [...currentDeletedIds],
            clearedDeletedStableKeys: [...currentDeletedStableKeys],
        }));
    }

    function loadShapes(loaded: IShapeAnnotation[]) {
        replaceShapes(loaded);
    }

    function markSavedShapeState() {
        const currentShapes = getAllShapes().map(shape => cloneShape(shape));
        replaceShapeState(currentShapes, {
            deletedIds: new Set(),
            deletedStableKeys: new Set(),
            baselineShapes: currentShapes,
        });

        BrowserLogger.debug('pdf-shapes', 'Marked current shape state as saved', () => ({
            shapeCount: currentShapes.length,
            embeddedCount: currentShapes.filter(shape => shape.source === 'embedded').length,
            localCount: currentShapes.filter(shape => shape.source !== 'embedded').length,
        }));
    }

    function captureShapeStateSnapshot(): IShapeStateSnapshot {
        return {
            shapes: getAllShapes().map(shape => cloneShape(shape)),
            deletedAnnotationIds: [...deletedEmbeddedAnnotationIds.value],
            deletedStableKeys: [...deletedEmbeddedShapeStableKeys.value],
            baselineSignature: baselineSignature.value,
            selectedShapeId: selectedShapeId.value,
        };
    }

    function restoreShapeStateSnapshot(snapshot: IShapeStateSnapshot) {
        replaceShapeState(snapshot.shapes.map(shape => cloneShape(shape)), {
            deletedIds: new Set(snapshot.deletedAnnotationIds),
            deletedStableKeys: new Set(snapshot.deletedStableKeys),
            baselineSignatureValue: snapshot.baselineSignature,
        });

        if (snapshot.selectedShapeId && getShapeById(snapshot.selectedShapeId)) {
            selectedShapeId.value = snapshot.selectedShapeId;
        } else {
            selectedShapeId.value = null;
        }
        focusedShapeId.value = null;

        BrowserLogger.debug('pdf-shapes', 'Restored shape state snapshot', () => ({
            shapeCount: snapshot.shapes.length,
            deletedAnnotationIds: snapshot.deletedAnnotationIds,
            deletedStableKeys: snapshot.deletedStableKeys,
            selectedShapeId: selectedShapeId.value,
        }));
    }

    function startDrawing(
        pageIndex: number,
        tool: TDrawableShapeType,
        x: number,
        y: number,
        settings: IAnnotationSettings,
    ) {
        selectedShapeId.value = null;
        focusedShapeId.value = null;
        drawOrigin = {
            x,
            y, 
        };
        drawingShape.value = createDrawingShape(pageIndex, tool, x, y, settings);
        isDrawing.value = true;
    }

    function continueDrawing(x: number, y: number) {
        if (!drawingShape.value || !isDrawing.value || !drawOrigin) {
            return;
        }

        const shape = drawingShape.value;
        if (shape.type === 'polyline') {
            const points = appendDrawPoint(shape.strokes?.[0] ?? shape.points ?? [], x, y);
            const strokes = [points];
            drawingShape.value = {
                ...shape,
                ...resolveShapeBounds({
                    ...shape,
                    points,
                    strokes,
                }),
                points,
                strokes,
            };
        } else if (isLineLikeShape(shape)) {
            drawingShape.value = {
                ...shape,
                x2: x,
                y2: y, 
            };
        } else {
            const minX = Math.min(drawOrigin.x, x);
            const minY = Math.min(drawOrigin.y, y);
            const maxX = Math.max(drawOrigin.x, x);
            const maxY = Math.max(drawOrigin.y, y);
            drawingShape.value = {
                ...shape,
                x: minX,
                y: minY,
                width: maxX - minX,
                height: maxY - minY,
            };
        }
    }

    function finishDrawing() {
        if (!drawingShape.value || !isDrawing.value) {
            return null;
        }

        const shape = {
            ...drawingShape.value,
            modifiedAt: Date.now(),
        };
        resetDrawingState();

        if (!isDrawableFinishedShape(shape)) {
            return null;
        }

        addShape(shape);
        return shape;
    }

    function cancelDrawing() {
        resetDrawingState();
    }

    const hasShapes = computed(() => (
        deletedEmbeddedAnnotationIds.value.size > 0
        || deletedEmbeddedShapeStableKeys.value.size > 0
        || toShapesSignature(getAllShapes()) !== baselineSignature.value
    ));

    return {
        shapes,
        selectedShapeId,
        focusedShapeId,
        drawingShape,
        isDrawing,
        hasShapes,
        isShapeTool,
        getShapesForPage,
        getAllShapes,
        getShapeById,
        getDeletedEmbeddedAnnotationIds,
        getDeletedEmbeddedShapeStableKeys,
        getManagedEmbeddedAnnotationIds,
        addShape,
        updateShape,
        deleteShape,
        deleteShapeByReference,
        deleteSelectedShape,
        deletedEmbeddedAnnotationIds,
        deletedEmbeddedShapeStableKeys,
        selectShape,
        focusShape,
        clearShapes,
        loadShapes,
        replaceShapes,
        reconcilePersistedShapes,
        primePersistedShapes,
        adoptPersistedShapeMetadata,
        markSavedShapeState,
        captureShapeStateSnapshot,
        restoreShapeStateSnapshot,
        buildShapeAnnotation,
        startDrawing,
        continueDrawing,
        finishDrawing,
        cancelDrawing,
    };
};

export type TUseAnnotationShapesReturn = ReturnType<typeof useAnnotationShapes>;
