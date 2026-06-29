import type {
    ComputedRef,
    Ref,
} from 'vue';
import { groupBy } from 'es-toolkit/array';
import type {
    IAnnotationSettings,
    IShapeAnnotation,
    TDrawableShapeType,
    TShapeResizeHandle,
} from '@app/types/annotations';
import { isShapeTool } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isShapeTool';
import { normalizeManagedShapeStableKey } from '@app/modules/pdf-viewer/engine/pdf-serialization-refs/normalizeManagedShapeStableKey';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import {
    getNormalizedShapeAnnotationId,
    getNormalizedShapeStableKey,
    shapeStableRefsMatch,
} from '@app/modules/pdf-viewer/engine/annotations/shape-annotation-identity/shapeAnnotationIdentity';
import { cloneShapePoints } from '@app/modules/pdf-viewer/engine/pdf-shape-strokes/cloneShapePoints';
import { cloneShapeStrokes } from '@app/modules/pdf-viewer/engine/pdf-shape-strokes/cloneShapeStrokes';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    buildShapeAnnotation,
    createDrawingShape,
    isDrawableFinishedShape,
    updateDrawingShapeForPoint,
} from '@app/modules/pdf-viewer/tools/annotationShapeDrawing';

function normalizeComparableNumber(value: number | null | undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }

    return Number(value.toFixed(6));
}

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

interface IShapeStateSnapshot {
    shapes: IShapeAnnotation[];
    deletedAnnotationIds: string[];
    deletedStableKeys: string[];
    baselineSignature: string;
    selectedShapeId: string | null;
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

    function groupShapesByPage(input: IShapeAnnotation[]): Map<number, IShapeAnnotation[]> {
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

    function resetDrawingState() {
        isDrawing.value = false;
        drawingShape.value = null;
        drawOrigin = null;
    }

    function toComparableShape(shape: IShapeAnnotation) {
        const comparable = {
            annotationId: getNormalizedShapeAnnotationId(shape) ?? shape.annotationId ?? null,
            color: shape.color,
            fillColor: shape.fillColor ?? null,
            height: shape.height,
            lineEndStyle: shape.lineEndStyle ?? null,
            lineStartStyle: shape.lineStartStyle ?? null,
            opacity: shape.opacity,
            pageIndex: shape.pageIndex,
            pdfSubtype: shape.pdfSubtype ?? null,
            stableKey: getNormalizedShapeStableKey(shape) ?? null,
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
            stableKey: getNormalizedShapeStableKey(shape) ?? null,
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
        const annotationId = getNormalizedShapeAnnotationId(shape);
        if (annotationId && deletedAnnotationIds.has(annotationId)) {
            return true;
        }

        const stableKey = getNormalizedShapeStableKey(shape);
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

    function getShapesForPage(pageIndex: number): IShapeAnnotation[] {
        return shapes.value.get(pageIndex) ?? [];
    }

    function getAllShapes(): IShapeAnnotation[] {
        const all: IShapeAnnotation[] = [];
        for (const pageShapes of shapes.value.values()) {
            all.push(...pageShapes.map((shape: IShapeAnnotation) => cloneShape(shape)));
        }
        return all;
    }

    function getShapeById(id: string): IShapeAnnotation | null {
        for (const pageShapes of shapes.value.values()) {
            const shape = pageShapes.find((s: IShapeAnnotation) => s.id === id);
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

        if (shapeStableRefsMatch(candidate, reference)) {
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
            const index = pageShapes.findIndex((s: IShapeAnnotation) => s.id === id);
            if (index !== -1) {
                const currentShape = pageShapes[index];
                if (!currentShape) {
                    continue;
                }
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
        const currentStableKey = getNormalizedShapeStableKey(currentShape);
        const importedIndexByStableKey = currentStableKey
            ? remainingImportedShapes.findIndex(shape => getNormalizedShapeStableKey(shape) === currentStableKey)
            : -1;

        if (importedIndexByStableKey !== -1) {
            return importedIndexByStableKey;
        }

        const currentAnnotationId = getNormalizedShapeAnnotationId(currentShape);
        const importedIndexByAnnotationId = currentAnnotationId
            ? remainingImportedShapes.findIndex(shape => getNormalizedShapeAnnotationId(shape) === currentAnnotationId)
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
                const importedShape = remainingImportedShapes.splice(importedIndex, 1)[0];
                if (!importedShape) {
                    continue;
                }
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
                const importedShape = remainingImportedShapes.splice(importedIndex, 1)[0];
                if (!importedShape) {
                    continue;
                }
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
                ? loaded.some(shape => getNormalizedShapeAnnotationId(shape) === normalizedDeletedId)
                : loaded.some(shape => shape.annotationId === rawAnnotationId);

            if (stillPresentInImportedShapes) {
                nextDeletedIds.add(rawAnnotationId);
            }
        });
        currentDeletedStableKeys.forEach((rawStableKey) => {
            const normalizedDeletedStableKey = normalizeManagedShapeStableKey(rawStableKey);
            const stillPresentInImportedShapes = normalizedDeletedStableKey
                ? loaded.some(shape => getNormalizedShapeStableKey(shape) === normalizedDeletedStableKey)
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
        drawingShape.value = updateDrawingShapeForPoint(shape, drawOrigin, x, y);
    }

    function finishDrawing() {
        if (!drawingShape.value || !isDrawing.value) {
            return null;
        }

        const shape: IShapeAnnotation = {
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
