export interface IImagePlacementDimensions {
    width: number;
    height: number;
}

export interface IImagePlacementContainerRect {
    width: number;
    height: number;
}

export interface IImagePlacementRectPx {
    left: number;
    top: number;
    width: number;
    height: number;
}

export type TImagePlacementResizeHandle =
    | 'nw'
    | 'n'
    | 'ne'
    | 'e'
    | 'se'
    | 's'
    | 'sw'
    | 'w';

interface IImagePlacementPointerResizeOptions {
    originRectPx: IImagePlacementRectPx;
    containerRect: IImagePlacementContainerRect;
    handle: TImagePlacementResizeHandle;
    startClientX: number;
    startClientY: number;
    clientX: number;
    clientY: number;
    rotationDegrees?: number;
    minSizePx?: number;
}

interface IImagePlacementMoveOptions {
    originRectPx: IImagePlacementRectPx;
    containerRect: IImagePlacementContainerRect;
    deltaX: number;
    deltaY: number;
    rotationDegrees?: number;
}

interface IImagePlacementPointerRotateOptions {
    originRectPx: IImagePlacementRectPx;
    originRotationDegrees?: number;
    startClientX: number;
    startClientY: number;
    clientX: number;
    clientY: number;
    snapStepDegrees?: number;
    snapThresholdDegrees?: number;
}

interface IPoint2D {
    x: number;
    y: number;
}

const DEFAULT_MIN_IMAGE_PLACEMENT_SIZE_PX = 32;
const DEFAULT_ROTATION_SNAP_STEP_DEGREES = 90;
const DEFAULT_ROTATION_SNAP_THRESHOLD_DEGREES = 5;
const EPSILON = 0.0001;
const IMAGE_PLACEMENT_CURSOR_SIZE_PX = 32;
const IMAGE_PLACEMENT_CURSOR_HOTSPOT_PX = 16;

const IMAGE_PLACEMENT_HANDLE_ANGLES: Record<TImagePlacementResizeHandle, number> = {
    n: -90,
    ne: -45,
    e: 0,
    se: 45,
    s: 90,
    sw: 135,
    w: 180,
    nw: 225,
};

interface IComputeInitialImagePlacementDimensionsOptions {
    pageWidthPx: number;
    pageHeightPx: number;
    imageCssWidth: number;
    imageCssHeight: number;
}

export function computeInitialImagePlacementDimensions(
    options: IComputeInitialImagePlacementDimensionsOptions,
): IImagePlacementDimensions | null {
    const {
        pageWidthPx,
        pageHeightPx,
        imageCssWidth,
        imageCssHeight,
    } = options;
    if (
        pageWidthPx <= 0
        || pageHeightPx <= 0
        || imageCssWidth <= 0
        || imageCssHeight <= 0
    ) {
        return null;
    }

    const maxCssWidth = pageWidthPx * 0.4;
    const maxCssHeight = pageHeightPx * 0.4;
    const minCssWidth = Math.min(pageWidthPx * 0.12, maxCssWidth);
    const minCssHeight = Math.min(pageHeightPx * 0.12, maxCssHeight);

    const fitScale = Math.min(
        1,
        maxCssWidth / imageCssWidth,
        maxCssHeight / imageCssHeight,
    );
    let targetCssWidth = imageCssWidth * fitScale;
    let targetCssHeight = imageCssHeight * fitScale;

    const minScaleFactor = Math.max(
        targetCssWidth < minCssWidth ? minCssWidth / targetCssWidth : 1,
        targetCssHeight < minCssHeight ? minCssHeight / targetCssHeight : 1,
    );
    const maxScaleFactor = Math.min(
        maxCssWidth / targetCssWidth,
        maxCssHeight / targetCssHeight,
    );
    if (minScaleFactor > 1 && maxScaleFactor >= 1) {
        const scaleUpFactor = Math.min(minScaleFactor, maxScaleFactor);
        targetCssWidth *= scaleUpFactor;
        targetCssHeight *= scaleUpFactor;
    }

    return {
        width: targetCssWidth / pageWidthPx,
        height: targetCssHeight / pageHeightPx,
    };
}

function toRadians(degrees: number) {
    return (degrees * Math.PI) / 180;
}

function rotateLocalVector(point: IPoint2D, rotationDegrees: number): IPoint2D {
    const radians = toRadians(rotationDegrees);
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);

    return {
        x: (point.x * cos) - (point.y * sin),
        y: (point.x * sin) + (point.y * cos),
    };
}

function dot(a: IPoint2D, b: IPoint2D) {
    return (a.x * b.x) + (a.y * b.y);
}

function getRectCenter(rect: IImagePlacementRectPx): IPoint2D {
    return {
        x: rect.left + (rect.width / 2),
        y: rect.top + (rect.height / 2),
    };
}

function getRotatedBoundingSize(
    width: number,
    height: number,
    rotationDegrees: number,
) {
    const radians = toRadians(rotationDegrees);
    const absCos = Math.abs(Math.cos(radians));
    const absSin = Math.abs(Math.sin(radians));

    return {
        width: (width * absCos) + (height * absSin),
        height: (width * absSin) + (height * absCos),
    };
}

function getMaxWidthForHeight(
    containerRect: IImagePlacementContainerRect,
    height: number,
    rotationDegrees: number,
) {
    const radians = toRadians(rotationDegrees);
    const absCos = Math.abs(Math.cos(radians));
    const absSin = Math.abs(Math.sin(radians));
    let maxWidth = Number.POSITIVE_INFINITY;

    if (absCos > EPSILON) {
        maxWidth = Math.min(maxWidth, (containerRect.width - (height * absSin)) / absCos);
    }
    if (absSin > EPSILON) {
        maxWidth = Math.min(maxWidth, (containerRect.height - (height * absCos)) / absSin);
    }

    if (!Number.isFinite(maxWidth)) {
        return containerRect.width;
    }

    return Math.max(0, maxWidth);
}

function getMaxHeightForWidth(
    containerRect: IImagePlacementContainerRect,
    width: number,
    rotationDegrees: number,
) {
    const radians = toRadians(rotationDegrees);
    const absCos = Math.abs(Math.cos(radians));
    const absSin = Math.abs(Math.sin(radians));
    let maxHeight = Number.POSITIVE_INFINITY;

    if (absSin > EPSILON) {
        maxHeight = Math.min(maxHeight, (containerRect.width - (width * absCos)) / absSin);
    }
    if (absCos > EPSILON) {
        maxHeight = Math.min(maxHeight, (containerRect.height - (width * absSin)) / absCos);
    }

    if (!Number.isFinite(maxHeight)) {
        return containerRect.height;
    }

    return Math.max(0, maxHeight);
}

function clampCenterToContainer(
    center: IPoint2D,
    containerRect: IImagePlacementContainerRect,
    width: number,
    height: number,
    rotationDegrees: number,
) {
    const bounding = getRotatedBoundingSize(width, height, rotationDegrees);

    return {
        x: Math.min(
            Math.max(center.x, bounding.width / 2),
            containerRect.width - (bounding.width / 2),
        ),
        y: Math.min(
            Math.max(center.y, bounding.height / 2),
            containerRect.height - (bounding.height / 2),
        ),
    };
}

function toRectFromCenter(
    center: IPoint2D,
    width: number,
    height: number,
): IImagePlacementRectPx {
    return {
        left: center.x - (width / 2),
        top: center.y - (height / 2),
        width,
        height,
    };
}

function getLocalDelta(
    deltaX: number,
    deltaY: number,
    rotationDegrees: number,
) {
    const radians = toRadians(rotationDegrees);
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);

    return {
        x: (deltaX * cos) + (deltaY * sin),
        y: (-deltaX * sin) + (deltaY * cos),
    };
}

function resolveLockedAspectSize(
    width: number,
    height: number,
    aspectRatio: number,
    minSizePx: number,
) {
    const direction = {
        x: aspectRatio,
        y: 1,
    };
    const t = Math.max(EPSILON, dot({
        x: width,
        y: height,
    }, direction) / dot(direction, direction));

    let resolvedWidth = t * direction.x;
    let resolvedHeight = t * direction.y;
    const minScale = Math.max(
        minSizePx / Math.max(EPSILON, resolvedWidth),
        minSizePx / Math.max(EPSILON, resolvedHeight),
        1,
    );

    resolvedWidth *= minScale;
    resolvedHeight *= minScale;

    return {
        width: resolvedWidth,
        height: resolvedHeight,
    };
}

function clampLockedAspectSizeToContainer(
    containerRect: IImagePlacementContainerRect,
    width: number,
    height: number,
    rotationDegrees: number,
    minSizePx: number,
) {
    let nextWidth = width;
    let nextHeight = height;
    const bounding = getRotatedBoundingSize(nextWidth, nextHeight, rotationDegrees);
    const fitScale = Math.min(
        bounding.width > EPSILON ? containerRect.width / bounding.width : 1,
        bounding.height > EPSILON ? containerRect.height / bounding.height : 1,
        1,
    );

    nextWidth *= fitScale;
    nextHeight *= fitScale;

    if (nextWidth < minSizePx || nextHeight < minSizePx) {
        const minScale = Math.max(
            minSizePx / Math.max(EPSILON, nextWidth),
            minSizePx / Math.max(EPSILON, nextHeight),
            1,
        );
        nextWidth *= minScale;
        nextHeight *= minScale;
    }

    return {
        width: nextWidth,
        height: nextHeight,
    };
}

export function normalizeImagePlacementRotationDegrees(value: number) {
    if (!Number.isFinite(value)) {
        return 0;
    }

    let normalized = ((value % 360) + 360) % 360;
    if (normalized > 180) {
        normalized -= 360;
    }
    if (Math.abs(normalized) < EPSILON) {
        return 0;
    }
    return normalized;
}

export function snapImagePlacementRotationDegrees(
    value: number,
    stepDegrees: number = DEFAULT_ROTATION_SNAP_STEP_DEGREES,
    thresholdDegrees: number = DEFAULT_ROTATION_SNAP_THRESHOLD_DEGREES,
) {
    const normalized = normalizeImagePlacementRotationDegrees(value);
    if (!Number.isFinite(stepDegrees) || stepDegrees <= 0 || thresholdDegrees < 0) {
        return normalized;
    }

    const snapped = Math.round(normalized / stepDegrees) * stepDegrees;
    const snappedNormalized = normalizeImagePlacementRotationDegrees(snapped);
    const distanceToSnap = Math.abs(normalizeImagePlacementRotationDegrees(normalized - snappedNormalized));
    if (distanceToSnap <= thresholdDegrees) {
        return snappedNormalized;
    }

    return normalized;
}

export function moveImagePlacementRect(
    options: IImagePlacementMoveOptions,
): IImagePlacementRectPx {
    const {
        originRectPx,
        containerRect,
        deltaX,
        deltaY,
        rotationDegrees = 0,
    } = options;
    const originCenter = getRectCenter(originRectPx);
    const nextCenter = clampCenterToContainer({
        x: originCenter.x + deltaX,
        y: originCenter.y + deltaY,
    }, containerRect, originRectPx.width, originRectPx.height, rotationDegrees);

    return toRectFromCenter(nextCenter, originRectPx.width, originRectPx.height);
}

export function resizeImagePlacementRect(
    options: IImagePlacementPointerResizeOptions,
): IImagePlacementRectPx {
    const {
        originRectPx,
        containerRect,
        handle,
        startClientX,
        startClientY,
        clientX,
        clientY,
        rotationDegrees = 0,
        minSizePx = DEFAULT_MIN_IMAGE_PLACEMENT_SIZE_PX,
    } = options;
    const originCenter = getRectCenter(originRectPx);
    const localDelta = getLocalDelta(
        clientX - startClientX,
        clientY - startClientY,
        rotationDegrees,
    );
    const aspectRatio = originRectPx.width / Math.max(EPSILON, originRectPx.height);
    let width = originRectPx.width;
    let height = originRectPx.height;
    let centerShiftLocal: IPoint2D = {
        x: 0,
        y: 0,
    };

    switch (handle) {
        case 'e':
        case 'w': {
            const direction = handle === 'e' ? 1 : -1;
            width = Math.max(minSizePx, originRectPx.width + (localDelta.x * direction));
            width = Math.min(width, Math.max(minSizePx, getMaxWidthForHeight(containerRect, height, rotationDegrees)));
            centerShiftLocal = {
                x: ((width - originRectPx.width) / 2) * direction,
                y: 0,
            };
            break;
        }
        case 'n':
        case 's': {
            const direction = handle === 's' ? 1 : -1;
            height = Math.max(minSizePx, originRectPx.height + (localDelta.y * direction));
            height = Math.min(height, Math.max(minSizePx, getMaxHeightForWidth(containerRect, width, rotationDegrees)));
            centerShiftLocal = {
                x: 0,
                y: ((height - originRectPx.height) / 2) * direction,
            };
            break;
        }
        default: {
            const xDirection = handle.endsWith('e') ? 1 : -1;
            const yDirection = handle.startsWith('s') ? 1 : -1;
            const rawWidth = Math.max(minSizePx, originRectPx.width + (localDelta.x * xDirection));
            const rawHeight = Math.max(minSizePx, originRectPx.height + (localDelta.y * yDirection));
            const locked = resolveLockedAspectSize(rawWidth, rawHeight, aspectRatio, minSizePx);
            const clamped = clampLockedAspectSizeToContainer(
                containerRect,
                locked.width,
                locked.height,
                rotationDegrees,
                minSizePx,
            );

            width = clamped.width;
            height = clamped.height;
            centerShiftLocal = {
                x: ((width - originRectPx.width) / 2) * xDirection,
                y: ((height - originRectPx.height) / 2) * yDirection,
            };
            break;
        }
    }

    const centerShift = rotateLocalVector(centerShiftLocal, rotationDegrees);
    const nextCenter = clampCenterToContainer({
        x: originCenter.x + centerShift.x,
        y: originCenter.y + centerShift.y,
    }, containerRect, width, height, rotationDegrees);

    return toRectFromCenter(nextCenter, width, height);
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

export function getShortestImagePlacementAngleDelta(deltaDegrees: number) {
    let normalized = ((deltaDegrees + 180) % 360 + 360) % 360 - 180;
    if (normalized === -180 && deltaDegrees > 0) {
        normalized = 180;
    }
    return normalized;
}

export function getImagePlacementResizeCursor(
    handle: TImagePlacementResizeHandle,
    rotationDegrees: number,
) {
    const handleAngle = IMAGE_PLACEMENT_HANDLE_ANGLES[handle] ?? 0;
    const normalizedAngle = ((handleAngle + rotationDegrees) % 360 + 360) % 360;
    const snappedAngle = (Math.round(normalizedAngle / 45) * 45) % 360;

    switch (snappedAngle) {
        case 0:
        case 180:
            return 'ew-resize';
        case 45:
        case 225:
            return 'nwse-resize';
        case 90:
        case 270:
            return 'ns-resize';
        case 135:
        case 315:
            return 'nesw-resize';
        default:
            return 'move';
    }
}

function buildImagePlacementResizeCursorSvg(angleDegrees: number) {
    const size = IMAGE_PLACEMENT_CURSOR_SIZE_PX;
    const center = IMAGE_PLACEMENT_CURSOR_HOTSPOT_PX;
    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <g transform="rotate(${angleDegrees} ${center} ${center})">
    <line x1="8" y1="${center}" x2="24" y2="${center}" stroke="white" stroke-width="5" stroke-linecap="round" />
    <path d="M11 12 L7 16 L11 20" fill="none" stroke="white" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M21 12 L25 16 L21 20" fill="none" stroke="white" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />
    <line x1="8" y1="${center}" x2="24" y2="${center}" stroke="#0f172a" stroke-width="2.5" stroke-linecap="round" />
    <path d="M11 12 L7 16 L11 20" fill="none" stroke="#0f172a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M21 12 L25 16 L21 20" fill="none" stroke="#0f172a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
  </g>
</svg>`.trim();

    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${IMAGE_PLACEMENT_CURSOR_HOTSPOT_PX} ${IMAGE_PLACEMENT_CURSOR_HOTSPOT_PX}`;
}

export function getImagePlacementResizeCursorStyle(
    handle: TImagePlacementResizeHandle,
    rotationDegrees: number,
) {
    const handleAngle = IMAGE_PLACEMENT_HANDLE_ANGLES[handle] ?? 0;
    const normalizedAngle = ((handleAngle + rotationDegrees) % 360 + 360) % 360;
    const fallbackCursor = getImagePlacementResizeCursor(handle, rotationDegrees);

    return `${buildImagePlacementResizeCursorSvg(normalizedAngle)}, ${fallbackCursor}`;
}

export function rotateImagePlacementRect(
    options: IImagePlacementPointerRotateOptions,
) {
    const {
        originRectPx,
        originRotationDegrees = 0,
        startClientX,
        startClientY,
        clientX,
        clientY,
        snapStepDegrees = DEFAULT_ROTATION_SNAP_STEP_DEGREES,
        snapThresholdDegrees = DEFAULT_ROTATION_SNAP_THRESHOLD_DEGREES,
    } = options;
    const center = getRectCenter(originRectPx);
    const startAngle = getPointerAngleFromCenter(center, startClientX, startClientY);
    const nextAngle = getPointerAngleFromCenter(center, clientX, clientY);
    const angleDelta = getShortestImagePlacementAngleDelta(nextAngle - startAngle);
    const rotationDegrees = snapImagePlacementRotationDegrees(
        normalizeImagePlacementRotationDegrees(originRotationDegrees + angleDelta),
        snapStepDegrees,
        snapThresholdDegrees,
    );

    return {
        rectPx: toRectFromCenter(center, originRectPx.width, originRectPx.height),
        rotationDegrees,
    };
}
