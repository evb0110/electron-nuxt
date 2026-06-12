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
} from '@app/modules/pdf-viewer/tools/useAnnotationShapes';
import { isAuthoringAnnotationTool } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isAuthoringAnnotationTool';
import { isSelectionInteractionTool } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isSelectionInteractionTool';
import { isShapeTool } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isShapeTool';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { getResizedBoundsForHandle } from '@app/modules/pdf-viewer/engine/pdf-shape-resize/getResizedBoundsForHandle';
import { getShapeBounds } from '@app/modules/pdf-viewer/engine/pdf-shape-resize/getShapeBounds';
import { resizeShapeToBounds } from '@app/modules/pdf-viewer/engine/pdf-shape-resize/resizeShapeToBounds';
import { cloneShapePoints } from '@app/modules/pdf-viewer/engine/pdf-shape-strokes/cloneShapePoints';
import { cloneShapeStrokes } from '@app/modules/pdf-viewer/engine/pdf-shape-strokes/cloneShapeStrokes';

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

type TShapeTranslator = (shape: IShapeAnnotation, deltaX: number, deltaY: number) => IShapeAnnotation;

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

    function resolveSafeShapeTranslation(shape: IShapeAnnotation, deltaX: number, deltaY: number) {
        const bounds = getShapeBounds(shape);
        return {
            x: Math.max(-bounds.minX, Math.min(1 - bounds.maxX, deltaX)),
            y: Math.max(-bounds.minY, Math.min(1 - bounds.maxY, deltaY)),
        };
    }

    function translateLineShape(shape: IShapeAnnotation, deltaX: number, deltaY: number): IShapeAnnotation {
        return {
            ...shape,
            x: shape.x + deltaX,
            y: shape.y + deltaY,
            x2: (shape.x2 ?? shape.x) + deltaX,
            y2: (shape.y2 ?? shape.y) + deltaY,
        };
    }

    function translatePoint(point: {
        x: number;
        y: number
    }, deltaX: number, deltaY: number) {
        return {
            x: point.x + deltaX,
            y: point.y + deltaY,
        };
    }

    function translatePointShape(shape: IShapeAnnotation, deltaX: number, deltaY: number): IShapeAnnotation {
        return {
            ...shape,
            x: shape.x + deltaX,
            y: shape.y + deltaY,
            points: shape.points?.map(point => translatePoint(point, deltaX, deltaY)),
            strokes: shape.strokes?.map(points => points.map(point => translatePoint(point, deltaX, deltaY))),
        };
    }

    function translatePositionShape(shape: IShapeAnnotation, deltaX: number, deltaY: number): IShapeAnnotation {
        return {
            ...shape,
            x: shape.x + deltaX,
            y: shape.y + deltaY,
        };
    }

    function isLineShape(shape: IShapeAnnotation) {
        return shape.type === 'line' || shape.type === 'arrow';
    }

    function hasTranslatablePointGeometry(shape: IShapeAnnotation) {
        return (shape.type === 'polyline' || shape.type === 'polygon')
            && (Boolean(shape.points) || Boolean(shape.strokes));
    }

    const shapeTranslationRules: Array<{
        matches: (shape: IShapeAnnotation) => boolean;
        translate: TShapeTranslator;
    }> = [
        {
            matches: isLineShape,
            translate: translateLineShape,
        },
        {
            matches: hasTranslatablePointGeometry,
            translate: translatePointShape,
        },
    ];

    function resolveShapeTranslator(shape: IShapeAnnotation): TShapeTranslator {
        return shapeTranslationRules.find(rule => rule.matches(shape))?.translate ?? translatePositionShape;
    }

    function translateShape(shape: IShapeAnnotation, deltaX: number, deltaY: number): IShapeAnnotation {
        const safeDelta = resolveSafeShapeTranslation(shape, deltaX, deltaY);
        return resolveShapeTranslator(shape)(shape, safeDelta.x, safeDelta.y);
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
        focusedShapeId: shapeComposable.focusedShapeId,
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
