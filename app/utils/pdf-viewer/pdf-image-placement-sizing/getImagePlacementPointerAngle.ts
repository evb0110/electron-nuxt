import type { IImagePlacementRectPx } from '@app/utils/pdf-viewer/pdf-image-placement-sizing/pdfImagePlacementSizingTypes';

interface IPoint2D {
    x: number;
    y: number;
}

function getRectCenter(rect: IImagePlacementRectPx): IPoint2D {
    return {
        x: rect.left + (rect.width / 2),
        y: rect.top + (rect.height / 2),
    };
}

function getPointerAngleFromCenter(
    center: IPoint2D,
    clientX: number,
    clientY: number,
) {
    return (Math.atan2(clientY - center.y, clientX - center.x) * 180) / Math.PI;
}

export function getImagePlacementPointerAngle(
    rectPx: IImagePlacementRectPx,
    clientX: number,
    clientY: number,
) {
    return getPointerAngleFromCenter(getRectCenter(rectPx), clientX, clientY);
}
