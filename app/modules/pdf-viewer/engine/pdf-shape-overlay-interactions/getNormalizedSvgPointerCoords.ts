import { resolveSvgPointerTarget } from '@app/modules/pdf-viewer/engine/pdf-shape-overlay-interactions/resolveSvgPointerTarget';

interface IPointerEventLike {
    currentTarget: EventTarget | null;
    target: EventTarget | null;
    clientX: number;
    clientY: number;
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
