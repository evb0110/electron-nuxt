
import type {
    Ref,
    ComputedRef,
} from 'vue';
import type {
    IShapeAnnotation,
    TDrawableShapeType,
    IAnnotationSettings,
    TShapeResizeHandle,
} from '@app/types/annotations';
import { isShapeTool } from '@app/composables/pdf/annotations/annotationRules';

function generateShapeId() {
    return `shape-${crypto.randomUUID()}`;
}

export interface IShapeContextProvide {
    selectedShapeId: Ref<string | null>;
    drawingShape: Ref<IShapeAnnotation | null>;
    isShapeToolActive: ComputedRef<boolean>;
    isAnyAnnotationToolActive: ComputedRef<boolean>;
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

export const useAnnotationShapes = () => {
    const shapes = ref<Map<number, IShapeAnnotation[]>>(new Map());
    const selectedShapeId = ref<string | null>(null);
    const drawingShape = ref<IShapeAnnotation | null>(null);
    const isDrawing = ref(false);
    const deletedEmbeddedAnnotationIds = ref<Set<string>>(new Set());
    const baselineSignature = ref('[]');
    let drawOrigin: {
        x: number;
        y: number 
    } | null = null;

    function toComparableShape(shape: IShapeAnnotation) {
        const comparable = {
            annotationId: shape.annotationId ?? null,
            color: shape.color,
            fillColor: shape.fillColor ?? null,
            height: shape.height,
            lineEndStyle: shape.lineEndStyle ?? null,
            lineStartStyle: shape.lineStartStyle ?? null,
            opacity: shape.opacity,
            pageIndex: shape.pageIndex,
            pdfSubtype: shape.pdfSubtype ?? null,
            points: shape.points?.map(point => ({
                x: point.x,
                y: point.y,
            })) ?? null,
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
        pageShapes.push(shape);
        shapes.value.set(shape.pageIndex, pageShapes);
        shapes.value = new Map(shapes.value);
        if (shape.annotationId) {
            const nextDeletedIds = new Set(deletedEmbeddedAnnotationIds.value);
            nextDeletedIds.delete(shape.annotationId);
            deletedEmbeddedAnnotationIds.value = nextDeletedIds;
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
                pageShapes.splice(index, 1);
                shapes.value.set(pageIndex, [...pageShapes]);
                shapes.value = new Map(shapes.value);
                if (deletedShape.source === 'embedded' && deletedShape.annotationId) {
                    const nextDeletedIds = new Set(deletedEmbeddedAnnotationIds.value);
                    nextDeletedIds.add(deletedShape.annotationId);
                    deletedEmbeddedAnnotationIds.value = nextDeletedIds;
                }
                if (selectedShapeId.value === id) {
                    selectedShapeId.value = null;
                }
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
        baselineSignature.value = '[]';
    }

    function loadShapes(loaded: IShapeAnnotation[]) {
        const grouped = new Map<number, IShapeAnnotation[]>();
        for (const shape of loaded) {
            const pageShapes = grouped.get(shape.pageIndex) ?? [];
            pageShapes.push(shape);
            grouped.set(shape.pageIndex, pageShapes);
        }
        shapes.value = grouped;
        deletedEmbeddedAnnotationIds.value = new Set();
        baselineSignature.value = toShapesSignature(loaded);
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
            type: tool,
            pageIndex,
            x,
            y,
            width: 0,
            height: 0,
            x2: tool === 'line' || tool === 'arrow' ? x : undefined,
            y2: tool === 'line' || tool === 'arrow' ? y : undefined,
            color: settings.shapeColor,
            fillColor: settings.shapeFillColor === 'transparent' ? undefined : settings.shapeFillColor,
            opacity: settings.shapeOpacity,
            strokeWidth: settings.shapeStrokeWidth,
            source: 'local',
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
        if (shape.type === 'line' || shape.type === 'arrow') {
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
        if (isLineLike) {
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
        selectedShapeId.value = shape.id;
        return shape;
    }

    function cancelDrawing() {
        isDrawing.value = false;
        drawingShape.value = null;
        drawOrigin = null;
    }

    const hasShapes = computed(() => (
        deletedEmbeddedAnnotationIds.value.size > 0
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
        getManagedEmbeddedAnnotationIds,
        addShape,
        updateShape,
        deleteShape,
        deleteSelectedShape,
        deletedEmbeddedAnnotationIds,
        selectShape,
        clearShapes,
        loadShapes,
        startDrawing,
        continueDrawing,
        finishDrawing,
        cancelDrawing,
    };
};

export type TUseAnnotationShapesReturn = ReturnType<typeof useAnnotationShapes>;
