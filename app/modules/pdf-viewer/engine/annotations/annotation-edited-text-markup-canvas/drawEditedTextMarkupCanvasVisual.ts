import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    TMarkupSubtype,
} from '@app/types/annotations';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import { ANNOTATION_COLOR_SWATCHES } from '@app/constants/pdfColors';
import { parseCssRgbColor } from '@app/modules/pdf-viewer/engine/text-markup-color/parseCssRgbColor';
import { rgbToHex } from '@app/modules/pdf-viewer/engine/text-markup-color/rgbToHex';
import { toOpaqueHighlightDisplayColor } from '@app/modules/pdf-viewer/engine/text-markup-color/toOpaqueHighlightDisplayColor';

interface IEditedTextMarkupCanvasOptions { highlightOpacity?: number | null | undefined; }

const EDITED_TEXT_MARKUP_THUMBNAIL_STROKE_WIDTH = 1;

const DEFAULT_EDITED_HIGHLIGHT_OVERLAY_OPACITY = 0.35;

function toTextMarkupSubtype(subtype: string | null | undefined): TMarkupSubtype | null {
    const normalized = (subtype ?? '').trim().toLowerCase();
    if (normalized === 'highlight') {
        return 'Highlight';
    }
    if (normalized === 'underline') {
        return 'Underline';
    }
    if (normalized === 'squiggly') {
        return 'Squiggly';
    }
    if (normalized === 'strikeout') {
        return 'StrikeOut';
    }
    return null;
}

function normalizeEditedHighlightOverlayOpacity(value: number | null | undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return DEFAULT_EDITED_HIGHLIGHT_OVERLAY_OPACITY;
    }
    return Math.min(1, Math.max(0, value));
}

function normalizeComparableColor(value: string | null | undefined) {
    const parsed = parseCssRgbColor(value);
    return parsed ? rgbToHex(parsed).toLowerCase() : (value?.trim().toLowerCase() ?? '');
}

function normalizeEditedHighlightOverlayColor(color: string, opacity: number) {
    const normalizedColor = normalizeComparableColor(color);
    const matchingRawSwatch = ANNOTATION_COLOR_SWATCHES.find((swatch) => (
        normalizeComparableColor(toOpaqueHighlightDisplayColor(swatch, opacity)) === normalizedColor
    ));
    return matchingRawSwatch ?? color;
}

function toCanvasRect(canvas: HTMLCanvasElement, rect: IAnnotationMarkerRect) {
    return {
        left: rect.left * canvas.width,
        top: rect.top * canvas.height,
        width: rect.width * canvas.width,
        height: rect.height * canvas.height,
    };
}

export function drawEditedTextMarkupCanvasVisual(
    canvas: HTMLCanvasElement,
    context: CanvasRenderingContext2D,
    comment: IAnnotationCommentSummary,
    color: string,
    options: IEditedTextMarkupCanvasOptions = {},
) {
    const subtype = toTextMarkupSubtype(comment.subtype);
    const rect = normalizeMarkerRect(comment.markerRect);
    const normalizedColor = color.trim();
    if (!subtype || !rect || !normalizedColor || canvas.width <= 0 || canvas.height <= 0) {
        return false;
    }

    const canvasRect = toCanvasRect(canvas, rect);
    context.save();
    try {
        if (subtype === 'Highlight') {
            const highlightOpacity = normalizeEditedHighlightOverlayOpacity(options.highlightOpacity);
            context.fillStyle = normalizeEditedHighlightOverlayColor(normalizedColor, highlightOpacity);
            context.globalAlpha = highlightOpacity;
            context.globalCompositeOperation = 'multiply';
            context.fillRect(canvasRect.left, canvasRect.top, canvasRect.width, canvasRect.height);
            return true;
        }

        context.beginPath();
        context.strokeStyle = normalizedColor;
        context.globalAlpha = 1;
        context.lineWidth = EDITED_TEXT_MARKUP_THUMBNAIL_STROKE_WIDTH;
        context.lineCap = subtype === 'Squiggly' ? 'round' : 'butt';
        context.lineJoin = subtype === 'Squiggly' ? 'round' : 'miter';

        if (subtype === 'Underline' || subtype === 'StrikeOut') {
            const y = canvasRect.top + canvasRect.height * (subtype === 'Underline' ? 1 : 0.52);
            context.moveTo(canvasRect.left, y);
            context.lineTo(canvasRect.left + canvasRect.width, y);
        } else {
            const amplitude = Math.max(canvasRect.height * 0.09, 0.75);
            const baseline = canvasRect.top + canvasRect.height * 0.84;
            const step = Math.max(canvasRect.height * 0.16, canvasRect.width / 28, 1.5);
            let x = canvasRect.left;
            let up = true;
            const right = canvasRect.left + canvasRect.width;
            context.moveTo(x, baseline - amplitude);
            while (x < right) {
                x = Math.min(right, x + step);
                context.lineTo(x, up ? baseline + amplitude : baseline - amplitude);
                up = !up;
            }
        }
        context.stroke();
        return true;
    } finally {
        context.restore();
    }
}
