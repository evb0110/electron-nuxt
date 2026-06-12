import type {
    IShapeAnnotation,
    IShapePoint,
    TDrawableShapeType,
    TShapeResizeHandle,
} from '@app/types/annotations';
import { clamp } from 'es-toolkit/math';
import type { Ref } from 'vue';
import { findShapeAtPoint } from '@app/modules/pdf-viewer/engine/pdf-shape-overlay-interactions/findShapeAtPoint';
import { getNormalizedSvgPointerCoords } from '@app/modules/pdf-viewer/engine/pdf-shape-overlay-interactions/getNormalizedSvgPointerCoords';
import { hasPointerMovedPastThreshold } from '@app/modules/pdf-viewer/engine/pdf-shape-overlay-interactions/hasPointerMovedPastThreshold';
import type {
    IPointerEventLike,
    IShapeOverlayBounds,
} from '@app/modules/pdf-viewer/engine/pdf-shape-overlay-interactions/pdfShapeOverlayInteractionTypes';

interface IPdfShapeOverlayInteractionProps {
    shapes: IShapeAnnotation[];
    selectedShapeId: string | null;
    isActive: boolean;
    selectionEnabled: boolean;
    tool: TDrawableShapeType | null;
}

interface IPendingShapeDrag {
    shapeId: string;
    x: number;
    y: number;
    clientX: number;
    clientY: number;
}

interface IUsePdfShapeOverlayInteractionsOptions {
    svgRef: Ref<SVGSVGElement | null>;
    svgWidth: Ref<number>;
    svgHeight: Ref<number>;
    props: IPdfShapeOverlayInteractionProps;
    selectedShape: Ref<IShapeAnnotation | null>;
    selectedShapeBounds: Ref<IShapeOverlayBounds | null>;
    emit: {
        startDrawing: (payload: IShapePoint) => void;
        continueDrawing: (payload: IShapePoint) => void;
        finishDrawing: () => void;
        startDragShape: (payload: {
            shapeId: string;
            x: number;
            y: number;
        }) => void;
        continueDragShape: (payload: IShapePoint) => void;
        finishDragShape: () => void;
        startResizeShape: (payload: {
            shapeId: string;
            handle: TShapeResizeHandle;
            x: number;
            y: number;
        }) => void;
        continueResizeShape: (payload: IShapePoint) => void;
        finishResizeShape: () => void;
        selectShape: (id: string | null) => void;
        shapeContextmenu: (payload: {
            shapeId: string;
            clientX: number;
            clientY: number;
        }) => void;
    };
}

function canCapturePointer(event: PointerEvent) {
    return typeof event.pointerId === 'number' && event.pointerId >= 0;
}

export const usePdfShapeOverlayInteractions = (options: IUsePdfShapeOverlayInteractionsOptions) => {
    const {
        svgRef,
        svgWidth,
        svgHeight,
        props,
        selectedShape,
        selectedShapeBounds,
        emit,
    } = options;

    let pointerDrawing = false;
    let pointerDraggingShapeId: string | null = null;
    let pointerResizingShapeId: string | null = null;
    let suppressSelectionAfterDraw = false;
    let suppressSelectionResetFrame: number | null = null;
    let pendingShapeDrag: IPendingShapeDrag | null = null;

    function getNormalizedCoords(event: IPointerEventLike) {
        const coords = getNormalizedSvgPointerCoords(event);
        if (!coords) {
            return null;
        }
        return {
            x: clamp(coords.x, 0, 1),
            y: clamp(coords.y, 0, 1),
        };
    }

    function boundsContainCoords(bounds: IShapeOverlayBounds, coords: IShapePoint) {
        const padX = 12 / Math.max(svgWidth.value, 1);
        const padY = 12 / Math.max(svgHeight.value, 1);
        return (
            coords.x >= bounds.x - padX
            && coords.x <= bounds.x + bounds.width + padX
            && coords.y >= bounds.y - padY
            && coords.y <= bounds.y + bounds.height + padY
        );
    }

    function clearPostDrawSelectionSuppression() {
        suppressSelectionAfterDraw = false;
        if (suppressSelectionResetFrame !== null) {
            cancelAnimationFrame(suppressSelectionResetFrame);
            suppressSelectionResetFrame = null;
        }
    }

    function suppressPostDrawSelection() {
        suppressSelectionAfterDraw = true;
        if (suppressSelectionResetFrame !== null) {
            cancelAnimationFrame(suppressSelectionResetFrame);
        }
        suppressSelectionResetFrame = requestAnimationFrame(() => {
            suppressSelectionAfterDraw = false;
            suppressSelectionResetFrame = null;
        });
    }

    function beginPendingShapeInteraction(shape: IShapeAnnotation, coords: IShapePoint, event: PointerEvent) {
        emit.selectShape(shape.id);
        pendingShapeDrag = {
            shapeId: shape.id,
            x: coords.x,
            y: coords.y,
            clientX: event.clientX,
            clientY: event.clientY,
        };
        if (canCapturePointer(event)) {
            svgRef.value?.setPointerCapture?.(event.pointerId);
        }
    }

    function findInteractiveShape(event: Pick<PointerEvent, 'clientX' | 'clientY' | 'currentTarget' | 'target'>) {
        const coords = getNormalizedCoords(event);
        if (!coords) {
            return null;
        }

        const shape = findShapeAtPoint({
            shapes: props.shapes,
            x: coords.x,
            y: coords.y,
            svgWidth: svgWidth.value,
            svgHeight: svgHeight.value,
        });

        if (!shape) {
            const selected = props.selectedShapeId
                ? props.shapes.find(candidate => candidate.id === props.selectedShapeId) ?? null
                : null;
            if (selected && selectedShapeBounds.value && boundsContainCoords(selectedShapeBounds.value, coords)) {
                return {
                    coords,
                    shape: selected,
                };
            }
            return null;
        }

        return {
            coords,
            shape,
        };
    }

    function handlePointerDown(event: PointerEvent) {
        if (!props.isActive || !props.tool) {
            if (!props.selectionEnabled) {
                return;
            }
            if (event.button !== 0) {
                return;
            }
            const hit = findInteractiveShape(event);
            if (hit) {
                beginPendingShapeInteraction(hit.shape, hit.coords, event);
                return;
            }
            emit.selectShape(null);
            return;
        }
        event.preventDefault();
        const coords = getNormalizedCoords(event);
        if (!coords) {
            return;
        }
        pointerDrawing = true;
        if (canCapturePointer(event)) {
            svgRef.value?.setPointerCapture?.(event.pointerId);
        }
        emit.startDrawing(coords);
    }

    function handlePointerMove(event: PointerEvent) {
        if (pointerResizingShapeId) {
            const coords = getNormalizedCoords(event);
            if (!coords) {
                return;
            }
            emit.continueResizeShape(coords);
            return;
        }
        if (pendingShapeDrag) {
            const coords = getNormalizedCoords(event);
            if (!coords) {
                return;
            }

            if (!pointerDraggingShapeId) {
                if (!hasPointerMovedPastThreshold(pendingShapeDrag, event, 6)) {
                    return;
                }

                pointerDraggingShapeId = pendingShapeDrag.shapeId;
                emit.startDragShape({
                    shapeId: pendingShapeDrag.shapeId,
                    x: pendingShapeDrag.x,
                    y: pendingShapeDrag.y,
                });
            }

            emit.continueDragShape(coords);
            return;
        }
        if (!pointerDrawing) {
            return;
        }
        const coords = getNormalizedCoords(event);
        if (!coords) {
            return;
        }
        emit.continueDrawing(coords);
    }

    function handlePointerUp(event?: PointerEvent) {
        if (event?.type === 'pointerleave' && event.pointerId && svgRef.value?.hasPointerCapture?.(event.pointerId)) {
            return;
        }
        if (event && svgRef.value?.hasPointerCapture?.(event.pointerId)) {
            svgRef.value.releasePointerCapture(event.pointerId);
        }
        pendingShapeDrag = null;
        if (pointerResizingShapeId) {
            pointerResizingShapeId = null;
            emit.finishResizeShape();
            return;
        }
        if (pointerDraggingShapeId) {
            pointerDraggingShapeId = null;
            emit.finishDragShape();
            return;
        }
        if (!pointerDrawing) {
            return;
        }
        pointerDrawing = false;
        suppressPostDrawSelection();
        emit.finishDrawing();
    }

    function handleShapeClick(id: string) {
        if (!props.selectionEnabled) {
            return;
        }
        if (suppressSelectionAfterDraw) {
            return;
        }
        emit.selectShape(id);
    }

    function handleShapePointerDown(shape: IShapeAnnotation, event: PointerEvent) {
        if (!props.selectionEnabled) {
            return;
        }
        if (event.button !== 0) {
            return;
        }
        const coords = getNormalizedCoords(event);
        if (!coords) {
            return;
        }

        beginPendingShapeInteraction(shape, coords, event);
    }

    function handleShapeContextMenu(id: string, event: MouseEvent) {
        if (!props.selectionEnabled) {
            return;
        }
        emit.selectShape(id);
        emit.shapeContextmenu({
            shapeId: id,
            clientX: event.clientX,
            clientY: event.clientY,
        });
    }

    function handleContextMenu(event: MouseEvent) {
        if (!props.selectionEnabled) {
            return;
        }
        if (props.isActive || props.tool) {
            return;
        }

        const hit = findInteractiveShape(event);
        if (!hit) {
            return;
        }
        event.preventDefault();
        emit.selectShape(hit.shape.id);
        emit.shapeContextmenu({
            shapeId: hit.shape.id,
            clientX: event.clientX,
            clientY: event.clientY,
        });
    }

    function handleSelectedShapeBoundsContextMenu(event: MouseEvent) {
        if (!props.selectionEnabled) {
            return;
        }
        if (!props.selectedShapeId) {
            return;
        }
        emit.selectShape(props.selectedShapeId);
        emit.shapeContextmenu({
            shapeId: props.selectedShapeId,
            clientX: event.clientX,
            clientY: event.clientY,
        });
    }

    function handleResizeHandlePointerDown(handle: TShapeResizeHandle, event: PointerEvent) {
        if (!props.selectionEnabled) {
            return;
        }
        if (event.button !== 0 || !selectedShape.value) {
            return;
        }

        const coords = getNormalizedCoords(event);
        if (!coords) {
            return;
        }

        pendingShapeDrag = null;
        pointerDraggingShapeId = null;
        pointerDrawing = false;
        pointerResizingShapeId = selectedShape.value.id;
        emit.selectShape(selectedShape.value.id);
        emit.startResizeShape({
            shapeId: selectedShape.value.id,
            handle,
            x: coords.x,
            y: coords.y,
        });
        if (canCapturePointer(event)) {
            svgRef.value?.setPointerCapture?.(event.pointerId);
        }
    }

    onUnmounted(clearPostDrawSelectionSuppression);

    return {
        handleContextMenu,
        handlePointerDown,
        handlePointerMove,
        handlePointerUp,
        handleResizeHandlePointerDown,
        handleSelectedShapeBoundsContextMenu,
        handleShapeClick,
        handleShapeContextMenu,
        handleShapePointerDown,
    };
};
