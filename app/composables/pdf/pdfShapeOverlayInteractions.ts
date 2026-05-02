import type {
    IShapeAnnotation,
    IShapePoint,
    TDrawableShapeType,
    TShapeResizeHandle,
} from '@app/types/annotations';
import { getShapeStrokePointSets } from '@app/composables/pdf/pdfShapeStrokes';
import { clamp } from 'es-toolkit/math';
import type { Ref } from 'vue';

interface IRectLike {
    left: number;
    top: number;
    width: number;
    height: number;
}

interface IClosestElementLike { closest: (selector: string) => unknown; }

interface IRectElementLike extends IClosestElementLike {
    getBoundingClientRect: () => IRectLike;
    setPointerCapture?: (pointerId: number) => void;
}

interface IPointerEventLike {
    currentTarget: EventTarget | null;
    target: EventTarget | null;
    clientX: number;
    clientY: number;
}

interface IPointerMoveLike {
    clientX: number;
    clientY: number;
}

function isRectElementLike(value: unknown): value is IRectElementLike {
    return Boolean(
        value
        && typeof value === 'object'
        && 'closest' in value
        && typeof (value as IClosestElementLike).closest === 'function'
        && 'getBoundingClientRect' in value
        && typeof (value as IRectElementLike).getBoundingClientRect === 'function',
    );
}

function resolveSvgElement(target: EventTarget | null) {
    if (!isRectElementLike(target)) {
        return null;
    }

    const svg = target.closest('svg');
    return isRectElementLike(svg) ? svg : null;
}

export function resolveSvgPointerTarget(event: Pick<IPointerEventLike, 'currentTarget' | 'target'>) {
    return resolveSvgElement(event.currentTarget) ?? resolveSvgElement(event.target);
}

export function getNormalizedSvgPointerCoords(event: IPointerEventLike) {
    const svg = resolveSvgPointerTarget(event);
    if (!svg) {
        return null;
    }

    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        return null;
    }

    return {
        x: (event.clientX - rect.left) / rect.width,
        y: (event.clientY - rect.top) / rect.height,
    };
}

export function hasPointerMovedPastThreshold(
    origin: IPointerMoveLike,
    next: IPointerMoveLike,
    thresholdPx = 4,
) {
    return Math.hypot(next.clientX - origin.clientX, next.clientY - origin.clientY) >= thresholdPx;
}

interface IFindShapeAtPointOptions {
    shapes: IShapeAnnotation[];
    x: number;
    y: number;
    svgWidth: number;
    svgHeight: number;
    thresholdPx?: number;
}

function toPxX(x: number, svgWidth: number) {
    return x * Math.max(svgWidth, 1);
}

function toPxY(y: number, svgHeight: number) {
    return y * Math.max(svgHeight, 1);
}

function pointInExpandedRect(
    x: number,
    y: number,
    left: number,
    top: number,
    right: number,
    bottom: number,
    padX: number,
    padY: number,
) {
    return (
        x >= left - padX
        && x <= right + padX
        && y >= top - padY
        && y <= bottom + padY
    );
}

function pointToSegmentDistancePx(
    point: IShapePoint,
    start: IShapePoint,
    end: IShapePoint,
    svgWidth: number,
    svgHeight: number,
) {
    const pointX = toPxX(point.x, svgWidth);
    const pointY = toPxY(point.y, svgHeight);
    const startX = toPxX(start.x, svgWidth);
    const startY = toPxY(start.y, svgHeight);
    const endX = toPxX(end.x, svgWidth);
    const endY = toPxY(end.y, svgHeight);
    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const lengthSquared = deltaX * deltaX + deltaY * deltaY;

    if (lengthSquared <= Number.EPSILON) {
        return Math.hypot(pointX - startX, pointY - startY);
    }

    const projection = ((pointX - startX) * deltaX + (pointY - startY) * deltaY) / lengthSquared;
    const t = Math.max(0, Math.min(1, projection));
    const closestX = startX + deltaX * t;
    const closestY = startY + deltaY * t;

    return Math.hypot(pointX - closestX, pointY - closestY);
}

function pointInPolygon(point: IShapePoint, polygon: IShapePoint[]) {
    if (polygon.length < 3) {
        return false;
    }

    let inside = false;
    for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index++) {
        const current = polygon[index]!;
        const previous = polygon[previousIndex]!;
        const intersects = (
            ((current.y > point.y) !== (previous.y > point.y))
            && (point.x < ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x)
        );
        if (intersects) {
            inside = !inside;
        }
    }
    return inside;
}

function segmentThresholdPx(shape: IShapeAnnotation, fallbackPx: number) {
    return Math.max(fallbackPx, shape.strokeWidth / 2 + 10);
}

function isPointNearPolyline(
    point: IShapePoint,
    points: IShapePoint[],
    shape: IShapeAnnotation,
    svgWidth: number,
    svgHeight: number,
    fallbackPx: number,
) {
    if (points.length === 0) {
        return false;
    }

    const thresholdPx = segmentThresholdPx(shape, fallbackPx);
    for (let index = 1; index < points.length; index += 1) {
        const start = points[index - 1]!;
        const end = points[index]!;
        if (pointToSegmentDistancePx(point, start, end, svgWidth, svgHeight) <= thresholdPx) {
            return true;
        }
    }

    return false;
}

function shapeContainsPoint(
    shape: IShapeAnnotation,
    point: IShapePoint,
    svgWidth: number,
    svgHeight: number,
    fallbackPx: number,
) {
    const padX = fallbackPx / Math.max(svgWidth, 1);
    const padY = fallbackPx / Math.max(svgHeight, 1);

    switch (shape.type) {
        case 'rectangle': {
            const left = shape.x;
            const top = shape.y;
            const right = shape.x + shape.width;
            const bottom = shape.y + shape.height;
            return pointInExpandedRect(point.x, point.y, left, top, right, bottom, padX, padY);
        }
        case 'circle': {
            const radiusX = Math.max(shape.width / 2, padX);
            const radiusY = Math.max(shape.height / 2, padY);
            const centerX = shape.x + shape.width / 2;
            const centerY = shape.y + shape.height / 2;
            const normalizedX = (point.x - centerX) / (radiusX + padX);
            const normalizedY = (point.y - centerY) / (radiusY + padY);
            return normalizedX * normalizedX + normalizedY * normalizedY <= 1;
        }
        case 'line':
        case 'arrow':
            return pointToSegmentDistancePx(
                point,
                {
                    x: shape.x,
                    y: shape.y,
                },
                {
                    x: shape.x2 ?? shape.x,
                    y: shape.y2 ?? shape.y,
                },
                svgWidth,
                svgHeight,
            ) <= segmentThresholdPx(shape, fallbackPx);
        case 'polyline':
            return getShapeStrokePointSets(shape).some(points => (
                isPointNearPolyline(point, points, shape, svgWidth, svgHeight, fallbackPx)
            ));
        case 'polygon': {
            const points = shape.points ?? getShapeStrokePointSets(shape)[0] ?? [];
            if (pointInPolygon(point, points)) {
                return true;
            }
            return isPointNearPolyline(point, [
                ...points,
                points[0]!,
            ].filter(Boolean), shape, svgWidth, svgHeight, fallbackPx);
        }
        default:
            return false;
    }
}

export function findShapeAtPoint(options: IFindShapeAtPointOptions) {
    const {
        shapes,
        x,
        y,
        svgWidth,
        svgHeight,
        thresholdPx = 24,
    } = options;

    const point = {
        x,
        y,
    };

    for (let index = shapes.length - 1; index >= 0; index -= 1) {
        const shape = shapes[index];
        if (!shape) {
            continue;
        }
        if (shapeContainsPoint(shape, point, svgWidth, svgHeight, thresholdPx)) {
            return shape;
        }
    }

    return null;
}

interface IShapeBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

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
    selectedShapeBounds: Ref<IShapeBounds | null>;
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

    function boundsContainCoords(bounds: IShapeBounds, coords: IShapePoint) {
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
