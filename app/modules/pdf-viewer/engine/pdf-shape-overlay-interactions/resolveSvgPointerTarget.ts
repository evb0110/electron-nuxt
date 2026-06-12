
import type { IPointerEventLike } from '@app/modules/pdf-viewer/engine/pdf-shape-overlay-interactions/pdfShapeOverlayInteractionTypes';


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
