import type {
    TPageSnapAnchor,
    TWheelDirection,
} from '@app/utils/document-viewer/single-page-wheel/singlePageWheelTypes';

export function resolveSnapAnchorForWheelDirection(
    direction: TWheelDirection,
): TPageSnapAnchor {
    return direction > 0 ? 'top' : 'bottom';
}
