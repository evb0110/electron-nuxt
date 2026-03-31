import type { ComputedRef } from 'vue';
import type {
    IAnnotationSettings,
    IShapeAnnotation,
    TAnnotationTool,
    TDrawableShapeType,
    TShapeResizeHandle,
} from '@app/types/annotations';
import type {
    IShapeContextProvide,
    TUseAnnotationShapesReturn,
} from '@app/composables/pdf/useAnnotationShapes';
import {
    isAuthoringAnnotationTool,
    isSelectionInteractionTool,
    isShapeTool,
} from '@app/composables/pdf/annotations/annotationRules';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotation-defaults';
import {
    getResizedBoundsForHandle,
    getShapeBounds,
    resizeShapeToBounds,
} from '@app/composables/pdf/pdfShapeResize';
import {
    cloneShapePoints,
    cloneShapeStrokes,
} from '@app/composables/pdf/pdfShapeStrokes';

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
    const isAnyAnnotationToolActive = computed(() => isAuthoringAnnotationTool(annotationTool.value));
    const isSelectionToolActive = computed(() => isSelectionInteractionTool(annotationTool.value));
    const activeShapeTool = computed<TDrawableShapeType | null>(() => isShapeTool(annotationTool.value) ? annotationTool.value : null);
    let dragState: {
        shapeId: string;
        origin: {
            x: number;
            y: number;
        };
        baselineShape: IShapeAnnotation;
    } | null = null;
    let resizeState: {
        shapeId: string;
        handle: TShapeResizeHandle;
        baselineShape: IShapeAnnotation;
        baselineBounds: ReturnType<typeof getShapeBounds>;
    } | null = null;

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

        if ((shape.type === 'polyline' || shape.type === 'polygon') && (shape.points || shape.strokes)) {
            return {
                ...shape,
                x: shape.x + safeDeltaX,
                y: shape.y + safeDeltaY,
                points: shape.points?.map(point => ({
                    x: point.x + safeDeltaX,
                    y: point.y + safeDeltaY,
                })),
                strokes: shape.strokes?.map(points => points.map(point => ({
                    x: point.x + safeDeltaX,
                    y: point.y + safeDeltaY,
                }))),
            };
        }

        return {
            ...shape,
            x: shape.x + safeDeltaX,
            y: shape.y + safeDeltaY,
        };
    }

    function cloneShape(shape: IShapeAnnotation): IShapeAnnotation {
        return {
            ...shape,
            points: cloneShapePoints(shape.points),
            strokes: cloneShapeStrokes(shape.strokes),
        };
    }

    provide<IShapeContextProvide>('shapeContext', {
        selectedShapeId: shapeComposable.selectedShapeId,
        drawingShape: shapeComposable.drawingShape,
        isShapeToolActive,
        isAnyAnnotationToolActive,
        isSelectionToolActive,
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
            resizeState = null;
            dragState = {
                shapeId,
                origin: coords,
                baselineShape: cloneShape(baselineShape),
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
        handleStartResizingShape(shapeId: string, handle: TShapeResizeHandle, _coords: {
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
            dragState = null;
            resizeState = {
                shapeId,
                handle,
                baselineShape: cloneShape(baselineShape),
                baselineBounds: getShapeBounds(baselineShape),
            };
        },
        handleContinueResizingShape(coords: {
            x: number;
            y: number
        }) {
            if (!resizeState) {
                return;
            }

            const nextBounds = getResizedBoundsForHandle(
                resizeState.baselineBounds,
                resizeState.handle,
                coords,
            );
            const nextShape = resizeShapeToBounds(
                resizeState.baselineShape,
                resizeState.baselineBounds,
                nextBounds,
            );
            shapeComposable.updateShape(resizeState.shapeId, nextShape);
        },
        handleFinishResizingShape() {
            if (!resizeState) {
                return;
            }

            const currentShape = shapeComposable.getShapeById(resizeState.shapeId);
            const previousShape = resizeState.baselineShape;
            resizeState = null;
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
        isAnyAnnotationToolActive,
        isShapeToolActive,
        activeShapeTool,
    };
};
