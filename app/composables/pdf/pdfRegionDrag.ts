import type {
    IClientPoint,
    IClientRect,
    IOverlayRect,
} from '@app/composables/pdf/pdfRegionGeometry';
import {
    clampClientPointToRect,
    normalizeClientRect,
    toLocalRect,
} from '@app/composables/pdf/pdfRegionGeometry';

export interface ISnipPointerPayload {
    clientX: number;
    clientY: number;
    overlayRect: IOverlayRect;
}

interface ISelectionPointerDragHandlersOptions {
    getState: () => string;
    getStartPoint: () => IClientPoint | null;
    setStartPoint: (point: IClientPoint) => void;
    updateSelection: (payload: ISnipPointerPayload, startPoint: IClientPoint) => void;
    onStart?: (payload: ISnipPointerPayload, startPoint: IClientPoint) => void;
    onEnd: (payload: ISnipPointerPayload, startPoint: IClientPoint) => void;
}

export function toClientPoint(payload: IClientPoint): IClientPoint {
    return {
        clientX: payload.clientX,
        clientY: payload.clientY,
    };
}

export function hasActiveSelectionDrag(
    state: string,
    startPoint: IClientPoint | null,
): startPoint is IClientPoint {
    return state === 'selecting' && startPoint !== null;
}

export function createSelectionPointerDragHandlers(
    options: ISelectionPointerDragHandlersOptions,
) {
    function getActiveStartPoint() {
        const startPoint = options.getStartPoint();
        return hasActiveSelectionDrag(options.getState(), startPoint)
            ? startPoint
            : null;
    }

    return {
        onPointerStart(payload: ISnipPointerPayload) {
            if (options.getState() !== 'selecting') {
                return;
            }

            const startPoint = toClientPoint(payload);
            options.setStartPoint(startPoint);
            options.onStart?.(payload, startPoint);
            options.updateSelection(payload, startPoint);
        },
        onPointerMove(payload: ISnipPointerPayload) {
            const startPoint = getActiveStartPoint();
            if (!startPoint) {
                return;
            }

            options.updateSelection(payload, startPoint);
        },
        onPointerEnd(payload: ISnipPointerPayload) {
            const startPoint = getActiveStartPoint();
            if (!startPoint) {
                return;
            }

            options.onEnd(payload, startPoint);
        },
    };
}

export function createSelectionRectFromPointerDrag(
    payload: ISnipPointerPayload,
    startPoint: IClientPoint,
    clampRect?: IClientRect,
) {
    const start = clampRect
        ? clampClientPointToRect(startPoint, clampRect)
        : startPoint;
    const end = clampRect
        ? clampClientPointToRect(payload, clampRect)
        : payload;
    const clientRect = normalizeClientRect(
        start.clientX,
        start.clientY,
        end.clientX,
        end.clientY,
    );

    return {
        clientRect,
        localRect: toLocalRect(clientRect, payload.overlayRect),
    };
}
