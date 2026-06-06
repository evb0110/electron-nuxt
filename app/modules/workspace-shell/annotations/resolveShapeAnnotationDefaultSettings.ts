import type {
    IAnnotationSettings,
    IShapeAnnotation,
} from '@app/types/annotations';

function updateShapeColorDefault(
    settings: IAnnotationSettings,
    isInkShape: boolean | undefined,
    color: string | null | undefined,
) {
    if (typeof color !== 'string' || !color.trim()) {
        return false;
    }
    if (isInkShape) {
        settings.inkColor = color;
    } else {
        settings.shapeColor = color;
    }
    return true;
}

function updateShapeStrokeWidthDefault(
    settings: IAnnotationSettings,
    isInkShape: boolean | undefined,
    strokeWidth: number | null | undefined,
) {
    if (typeof strokeWidth !== 'number' || !Number.isFinite(strokeWidth)) {
        return false;
    }
    if (isInkShape) {
        settings.inkThickness = strokeWidth;
    } else {
        settings.shapeStrokeWidth = strokeWidth;
    }
    return true;
}

function updateShapeOpacityDefault(
    settings: IAnnotationSettings,
    isInkShape: boolean | undefined,
    opacity: number | null | undefined,
) {
    if (typeof opacity !== 'number' || !Number.isFinite(opacity)) {
        return false;
    }
    if (isInkShape) {
        settings.inkOpacity = opacity;
    } else {
        settings.shapeOpacity = opacity;
    }
    return true;
}

function updateShapeFillColorDefault(
    settings: IAnnotationSettings,
    fillColor: string | null | undefined,
) {
    settings.shapeFillColor = fillColor ?? 'transparent';
    return true;
}

export function resolveShapeAnnotationDefaultSettings(
    currentSettings: IAnnotationSettings,
    updates: Partial<IShapeAnnotation>,
    isInkShape: boolean | undefined,
) {
    const settings: IAnnotationSettings = { ...currentSettings };
    const didUpdate = [
        updateShapeColorDefault(settings, isInkShape, updates.color),
        updateShapeStrokeWidthDefault(settings, isInkShape, updates.strokeWidth),
        updateShapeOpacityDefault(settings, isInkShape, updates.opacity),
        'fillColor' in updates
            ? updateShapeFillColorDefault(settings, updates.fillColor)
            : false,
    ].some(Boolean);

    return {
        didUpdate,
        settings,
    };
}
