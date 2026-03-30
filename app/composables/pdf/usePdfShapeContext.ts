import type { ComputedRef } from 'vue';
import type {
    IAnnotationSettings,
    IShapeAnnotation,
    TAnnotationTool,
    TDrawableShapeType,
} from '@app/types/annotations';
import type {
    IShapeContextProvide,
    TUseAnnotationShapesReturn,
} from '@app/composables/pdf/useAnnotationShapes';
import { isShapeTool } from '@app/composables/pdf/annotations/annotationRules';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotation-defaults';

interface IShapeContextMenuPayload {
    shapeId: string;
    clientX: number;
    clientY: number;
}

interface IUsePdfShapeContextDeps {
    shapeComposable: TUseAnnotationShapesReturn;
    annotationTool: ComputedRef<TAnnotationTool>;
    annotationSettings: ComputedRef<IAnnotationSettings | null>;
    onShapeCreated: (shape: IShapeAnnotation) => void;
    onShapeUpdated: (previousShape: IShapeAnnotation, nextShape: IShapeAnnotation) => void;
    onShapeContextMenu: (payload: IShapeContextMenuPayload) => void;
}

export const usePdfShapeContext = (deps: IUsePdfShapeContextDeps) => {
    const {
        shapeComposable,
        annotationTool,
        annotationSettings,
        onShapeCreated,
        onShapeUpdated,
        onShapeContextMenu,
    } = deps;

    const isShapeToolActive = computed(() => isShapeTool(annotationTool.value));
    const activeShapeTool = computed<TDrawableShapeType | null>(() => isShapeTool(annotationTool.value) ? annotationTool.value : null);
    let dragState: {
        shapeId: string;
        origin: {
            x: number;
            y: number;
        };
        baselineShape: IShapeAnnotation;
    } | null = null;

    function getShapeBounds(shape: IShapeAnnotation) {
        if ((shape.type === 'polyline' || shape.type === 'polygon') && shape.points && shape.points.length > 0) {
            const xs = shape.points.map(point => point.x);
            const ys = shape.points.map(point => point.y);
            return {
                minX: Math.min(...xs),
                minY: Math.min(...ys),
                maxX: Math.max(...xs),
                maxY: Math.max(...ys),
            };
        }

        if (shape.type === 'line' || shape.type === 'arrow') {
            const x2 = shape.x2 ?? shape.x;
            const y2 = shape.y2 ?? shape.y;
            return {
                minX: Math.min(shape.x, x2),
                minY: Math.min(shape.y, y2),
                maxX: Math.max(shape.x, x2),
                maxY: Math.max(shape.y, y2),
            };
        }

        return {
            minX: shape.x,
            minY: shape.y,
            maxX: shape.x + shape.width,
            maxY: shape.y + shape.height,
        };
    }

    function translateShape(shape: IShapeAnnotation, deltaX: number, deltaY: number): IShapeAnnotation {
        const bounds = getShapeBounds(shape);
        const safeDeltaX = Math.max(-bounds.minX, Math.min(1 - bounds.maxX, deltaX));
        const safeDeltaY = Math.max(-bounds.minY, Math.min(1 - bounds.maxY, deltaY));

        if (shape.type === 'line' || shape.type === 'arrow') {
            return {
                ...shape,
                x: shape.x + safeDeltaX,
                y: shape.y + safeDeltaY,
                x2: (shape.x2 ?? shape.x) + safeDeltaX,
                y2: (shape.y2 ?? shape.y) + safeDeltaY,
            };
        }

        if ((shape.type === 'polyline' || shape.type === 'polygon') && shape.points) {
            return {
                ...shape,
                x: shape.x + safeDeltaX,
                y: shape.y + safeDeltaY,
                points: shape.points.map(point => ({
                    x: point.x + safeDeltaX,
                    y: point.y + safeDeltaY,
                })),
            };
        }

        return {
            ...shape,
            x: shape.x + safeDeltaX,
            y: shape.y + safeDeltaY,
        };
    }

    provide<IShapeContextProvide>('shapeContext', {
        selectedShapeId: shapeComposable.selectedShapeId,
        drawingShape: shapeComposable.drawingShape,
        isShapeToolActive,
        activeShapeTool,
        settings: computed(() => annotationSettings.value ?? DEFAULT_ANNOTATION_SETTINGS),
        getShapesForPage: shapeComposable.getShapesForPage,
        handleStartDrawing(pageIndex: number, coords: {
            x: number;
            y: number
        }) {
            const tool = activeShapeTool.value;
            if (!tool) {
                return;
            }
            const settings = annotationSettings.value;
            if (!settings) {
                return;
            }
            shapeComposable.startDrawing(pageIndex, tool, coords.x, coords.y, settings);
        },
        handleContinueDrawing(coords: {
            x: number;
            y: number
        }) {
            shapeComposable.continueDrawing(coords.x, coords.y);
        },
        handleFinishDrawing() {
            const shape = shapeComposable.finishDrawing();
            if (shape) {
                onShapeCreated(shape);
            }
        },
        handleSelectShape(id: string | null) {
            shapeComposable.selectShape(id);
        },
        handleStartDraggingShape(shapeId: string, coords: {
            x: number;
            y: number
        }) {
            if (isShapeToolActive.value) {
                return;
            }

            const baselineShape = shapeComposable.getShapeById(shapeId);
            if (!baselineShape) {
                return;
            }

            shapeComposable.selectShape(shapeId);
            dragState = {
                shapeId,
                origin: coords,
                baselineShape: {
                    ...baselineShape,
                    points: baselineShape.points?.map(point => ({ ...point })),
                },
            };
        },
        handleContinueDraggingShape(coords: {
            x: number;
            y: number
        }) {
            if (!dragState) {
                return;
            }

            const deltaX = coords.x - dragState.origin.x;
            const deltaY = coords.y - dragState.origin.y;
            const nextShape = translateShape(dragState.baselineShape, deltaX, deltaY);
            shapeComposable.updateShape(dragState.shapeId, nextShape);
        },
        handleFinishDraggingShape() {
            if (!dragState) {
                return;
            }

            const currentShape = shapeComposable.getShapeById(dragState.shapeId);
            const previousShape = dragState.baselineShape;
            dragState = null;
            if (!currentShape) {
                return;
            }

            onShapeUpdated(previousShape, currentShape);
        },
        handleShapeContextMenu(payload: IShapeContextMenuPayload) {
            shapeComposable.selectShape(payload.shapeId);
            onShapeContextMenu(payload);
        },
    });

    return {
        isShapeToolActive,
        activeShapeTool,
    };
};
