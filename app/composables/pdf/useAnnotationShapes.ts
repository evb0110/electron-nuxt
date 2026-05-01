
import type {
    Ref,
    ComputedRef,
} from 'vue';
import type {
    IShapeAnnotation,
    IShapePoint,
    TDrawableShapeType,
    IAnnotationSettings,
    TShapeResizeHandle,
} from '@app/types/annotations';
import { isShapeTool } from '@app/composables/pdf/annotations/annotationRules';
import {
    generateManagedShapeStableKey,
    normalizeManagedShapeStableKey,
    normalizePdfJsAnnotationId,
} from '@app/composables/pdf/pdfSerializationRefs';
import {
    cloneShapePoints,
    cloneShapeStrokes,
    getAllShapePoints,
} from '@app/composables/pdf/pdfShapeStrokes';
import { BrowserLogger } from '@app/utils/browser-logger';

function generateShapeId() {
    return `shape-${crypto.randomUUID()}`;
}

function normalizeComparableNumber(value: number | null | undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }

    return Number(value.toFixed(6));
}

export interface IShapeContextProvide {
    selectedShapeId: Ref<string | null>;
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

export const useAnnotationShapes = () => {
    const shapes = ref<Map<number, IShapeAnnotation[]>>(new Map());
    const selectedShapeId = ref<string | null>(null);
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
        const grouped = new Map<number, IShapeAnnotation[]>();
        for (const shape of input) {
            const pageShapes = grouped.get(shape.pageIndex) ?? [];
            pageShapes.push(shape);
            grouped.set(shape.pageIndex, pageShapes);
        }
        return grouped;
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
    }

    function resolveShapeBounds(shape: Pick<IShapeAnnotation, 'x' | 'y' | 'width' | 'height' | 'points' | 'strokes'>) {
        const points = getAllShapePoints(shape);
        if (points.length === 0) {
            return {
                x: shape.x,
                y: shape.y,
                width: shape.width,
                height: shape.height,
            };
        }

        const xs = points.map(point => point.x);
        const ys = points.map(point => point.y);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);

        return {
            x: minX,
            y: minY,
            width: Math.max(0.0001, maxX - minX),
            height: Math.max(0.0001, maxY - minY),
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

    function addShape(shape: IShapeAnnotation) {
        const pageShapes = shapes.value.get(shape.pageIndex) ?? [];
        pageShapes.push(cloneShape(shape));
        shapes.value.set(shape.pageIndex, pageShapes);
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

    function updateShape(id: string, updates: Partial<IShapeAnnotation>) {
        for (const [
            pageIndex,
            pageShapes,
        ] of shapes.value.entries()) {
            const index = pageShapes.findIndex(s => s.id === id);
            if (index !== -1) {
                pageShapes[index] = {
                    ...pageShapes[index]!,
                    ...updates, 
                    points: updates.points ? cloneShapePoints(updates.points) : pageShapes[index]!.points,
                    strokes: updates.strokes ? cloneShapeStrokes(updates.strokes) : pageShapes[index]!.strokes,
                };
                shapes.value.set(pageIndex, [...pageShapes]);
                shapes.value = new Map(shapes.value);
                return;
            }
        }
    }

    function deleteShape(id: string) {
        for (const [
            pageIndex,
            pageShapes,
        ] of shapes.value.entries()) {
            const index = pageShapes.findIndex(s => s.id === id);
            if (index !== -1) {
                const deletedShape = pageShapes[index]!;
                BrowserLogger.debug('pdf-shapes', 'Deleting shape', () => ({
                    id,
                    source: deletedShape.source,
                    annotationId: deletedShape.annotationId ?? null,
                    stableKey: deletedShape.stableKey ?? null,
                    pageIndex: deletedShape.pageIndex,
                    color: deletedShape.color,
                    deletedAnnotationIdsBefore: [...deletedEmbeddedAnnotationIds.value],
                    deletedStableKeysBefore: [...deletedEmbeddedShapeStableKeys.value],
                }));
                pageShapes.splice(index, 1);
                shapes.value.set(pageIndex, [...pageShapes]);
                shapes.value = new Map(shapes.value);
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
                if (selectedShapeId.value === id) {
                    selectedShapeId.value = null;
                }
                BrowserLogger.debug('pdf-shapes', 'Deleted shape', () => ({
                    id,
                    remainingShapeCount: getAllShapes().length,
                    deletedAnnotationIdsAfter: [...deletedEmbeddedAnnotationIds.value],
                    deletedStableKeysAfter: [...deletedEmbeddedShapeStableKeys.value],
                }));
                return;
            }
        }
    }

    function deleteSelectedShape() {
        if (selectedShapeId.value) {
            deleteShape(selectedShapeId.value);
        }
    }

    function selectShape(id: string | null) {
        selectedShapeId.value = id;
    }

    function clearShapes() {
        shapes.value = new Map();
        selectedShapeId.value = null;
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

    function buildMergedPersistedShapes(
        currentShapes: IShapeAnnotation[],
        loaded: IShapeAnnotation[],
        currentDeletedIds: Set<string>,
        currentDeletedStableKeys: Set<string>,
    ) {
        const remainingImportedShapes = loaded.map(shape => cloneShape(shape));
        const nextShapes: IShapeAnnotation[] = [];

        for (const currentShape of currentShapes) {
            const currentStableKey = normalizeManagedShapeStableKey(currentShape.stableKey);
            const importedIndexByStableKey = currentStableKey
                ? remainingImportedShapes.findIndex(shape => normalizeManagedShapeStableKey(shape.stableKey) === currentStableKey)
                : -1;

            if (importedIndexByStableKey !== -1) {
                const importedShape = remainingImportedShapes.splice(importedIndexByStableKey, 1)[0]!;
                nextShapes.push(mergeImportedShape(currentShape, importedShape));
                continue;
            }

            const currentAnnotationId = normalizePdfJsAnnotationId(currentShape.annotationId);
            const importedIndexByAnnotationId = currentAnnotationId
                ? remainingImportedShapes.findIndex(shape => normalizePdfJsAnnotationId(shape.annotationId) === currentAnnotationId)
                : -1;

            if (importedIndexByAnnotationId !== -1) {
                const importedShape = remainingImportedShapes.splice(importedIndexByAnnotationId, 1)[0]!;
                nextShapes.push(mergeImportedShape(currentShape, importedShape));
                continue;
            }

            const currentShapeKey = toReconciliationKey(currentShape);
            const importedIndexByShapeKey = remainingImportedShapes.findIndex(
                shape => toReconciliationKey(shape) === currentShapeKey,
            );
            if (importedIndexByShapeKey !== -1) {
                const importedShape = remainingImportedShapes.splice(importedIndexByShapeKey, 1)[0]!;
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

    function reconcilePersistedShapes(loaded: IShapeAnnotation[]) {
        const currentShapes = getAllShapes().map(shape => cloneShape(shape));
        const currentDeletedIds = new Set(deletedEmbeddedAnnotationIds.value);
        const currentDeletedStableKeys = new Set(deletedEmbeddedShapeStableKeys.value);
        const nextShapes = buildMergedPersistedShapes(
            currentShapes,
            loaded,
            currentDeletedIds,
            currentDeletedStableKeys,
        );

        BrowserLogger.debug('pdf-shapes', 'Reconciling persisted shapes', () => ({
            currentShapeCount: currentShapes.length,
            loadedShapeCount: loaded.length,
            currentEmbeddedCount: currentShapes.filter(shape => shape.source === 'embedded').length,
            loadedEmbeddedCount: loaded.filter(shape => shape.source === 'embedded').length,
            currentDeletedIds: [...currentDeletedIds],
            currentDeletedStableKeys: [...currentDeletedStableKeys],
        }));

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
        const currentShapes = getAllShapes().map(shape => cloneShape(shape));
        const currentDeletedIds = new Set(deletedEmbeddedAnnotationIds.value);
        const currentDeletedStableKeys = new Set(deletedEmbeddedShapeStableKeys.value);
        const preservedBaselineSignature = baselineSignature.value;
        const nextShapes = buildMergedPersistedShapes(
            currentShapes,
            loaded,
            currentDeletedIds,
            currentDeletedStableKeys,
        );

        BrowserLogger.debug('pdf-shapes', 'Priming persisted shapes before save', () => ({
            currentShapeCount: currentShapes.length,
            loadedShapeCount: loaded.length,
            currentEmbeddedCount: currentShapes.filter(shape => shape.source === 'embedded').length,
            loadedEmbeddedCount: loaded.filter(shape => shape.source === 'embedded').length,
            currentDeletedIds: [...currentDeletedIds],
            currentDeletedStableKeys: [...currentDeletedStableKeys],
        }));

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
        drawOrigin = {
            x,
            y, 
        };
        const shape: IShapeAnnotation = {
            id: generateShapeId(),
            type: tool === 'draw' ? 'polyline' : tool,
            pageIndex,
            x,
            y,
            width: 0,
            height: 0,
            x2: tool === 'line' || tool === 'arrow' ? x : undefined,
            y2: tool === 'line' || tool === 'arrow' ? y : undefined,
            color: tool === 'draw' ? settings.inkColor : settings.shapeColor,
            fillColor: tool === 'draw' || settings.shapeFillColor === 'transparent' ? undefined : settings.shapeFillColor,
            opacity: tool === 'draw' ? settings.inkOpacity : settings.shapeOpacity,
            strokeWidth: tool === 'draw' ? settings.inkThickness : settings.shapeStrokeWidth,
            points: tool === 'draw'
                ? [{
                    x,
                    y,
                }]
                : undefined,
            strokes: tool === 'draw'
                ? [[{
                    x,
                    y,
                }]]
                : undefined,
            source: 'local',
            stableKey: generateManagedShapeStableKey(),
            pdfSubtype: tool === 'draw' ? 'Ink' : undefined,
            lineEndStyle: tool === 'arrow' ? 'closedArrow' : undefined,
        };
        drawingShape.value = shape;
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
        } else if (shape.type === 'line' || shape.type === 'arrow') {
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

        const shape = drawingShape.value;
        isDrawing.value = false;
        drawingShape.value = null;
        drawOrigin = null;

        const isLineLike = shape.type === 'line' || shape.type === 'arrow';
        if (shape.type === 'polyline') {
            const points = shape.strokes?.[0] ?? shape.points ?? [];
            if (points.length < 2 || getShapePathLength(points) < 0.005) {
                return null;
            }
        } else if (isLineLike) {
            const dx = (shape.x2 ?? shape.x) - shape.x;
            const dy = (shape.y2 ?? shape.y) - shape.y;
            if (Math.hypot(dx, dy) < 0.005) {
                return null;
            }
        } else {
            if (shape.width < 0.005 || shape.height < 0.005) {
                return null;
            }
        }

        addShape(shape);
        return shape;
    }

    function cancelDrawing() {
        isDrawing.value = false;
        drawingShape.value = null;
        drawOrigin = null;
    }

    const hasShapes = computed(() => (
        deletedEmbeddedAnnotationIds.value.size > 0
        || deletedEmbeddedShapeStableKeys.value.size > 0
        || toShapesSignature(getAllShapes()) !== baselineSignature.value
    ));

    return {
        shapes,
        selectedShapeId,
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
        deleteSelectedShape,
        deletedEmbeddedAnnotationIds,
        deletedEmbeddedShapeStableKeys,
        selectShape,
        clearShapes,
        loadShapes,
        replaceShapes,
        reconcilePersistedShapes,
        primePersistedShapes,
        markSavedShapeState,
        captureShapeStateSnapshot,
        restoreShapeStateSnapshot,
        startDrawing,
        continueDrawing,
        finishDrawing,
        cancelDrawing,
    };
};

export type TUseAnnotationShapesReturn = ReturnType<typeof useAnnotationShapes>;
