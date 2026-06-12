import type { TMarkupSubtype } from '@app/types/annotations';
import type { IPdfjsHighlightBox } from '@app/types/pdfjs';
import { normalizeTextMarkupBoxesByLine } from '@app/modules/pdf-viewer/engine/text-markup-visual-model/normalizeTextMarkupBoxesByLine';
import { pdfTextMarkupNativeAppearance } from '@app/modules/pdf-viewer/engine/text-markup-visual-model/pdfTextMarkupNativeAppearance';
import type {
    ITextMarkupLivePath,
    ITextMarkupLiveVisualPlan,
    ITextMarkupRect,
} from '@app/modules/pdf-viewer/engine/text-markup-visual-model/textMarkupVisualModelTypes';

function isFinitePositiveRect(rect: ITextMarkupRect) {
    return Number.isFinite(rect.left)
        && Number.isFinite(rect.top)
        && Number.isFinite(rect.width)
        && Number.isFinite(rect.height)
        && rect.width > 0
        && rect.height > 0;
}

function formatMarkupNumber(value: number) {
    const normalized = Math.abs(value) < 0.000001 ? 0 : value;
    if (Number.isInteger(normalized)) {
        return String(normalized);
    }
    return normalized
        .toFixed(6)
        .replace(/0+$/, '')
        .replace(/\.$/, '');
}

function toUnitBox(box: IPdfjsHighlightBox, rect: ITextMarkupRect) {
    return {
        bottom: (box.y + box.height - rect.top) / rect.height,
        left: (box.x - rect.left) / rect.width,
        right: (box.x + box.width - rect.left) / rect.width,
        top: (box.y - rect.top) / rect.height,
    };
}

function createUnderlineDrawLayerPath(
    box: IPdfjsHighlightBox,
    drawLayerRect: ITextMarkupRect,
    pageHeight: number,
): ITextMarkupLivePath {
    const local = toUnitBox(box, drawLayerRect);
    const y = local.bottom - (pdfTextMarkupNativeAppearance.underlineYOffset / pageHeight / drawLayerRect.height);
    return {
        d: [
            `M ${formatMarkupNumber(local.left)} ${formatMarkupNumber(y)}`,
            `L ${formatMarkupNumber(local.right)} ${formatMarkupNumber(y)}`,
        ].join(' '),
        strokeWidthPdfUnits: pdfTextMarkupNativeAppearance.underlineStrokeWidth,
    };
}

function createStrikeOutDrawLayerPath(
    box: IPdfjsHighlightBox,
    drawLayerRect: ITextMarkupRect,
): ITextMarkupLivePath {
    const local = toUnitBox(box, drawLayerRect);
    const y = (local.top + local.bottom) / 2;
    return {
        d: [
            `M ${formatMarkupNumber(local.left)} ${formatMarkupNumber(y)}`,
            `L ${formatMarkupNumber(local.right)} ${formatMarkupNumber(y)}`,
        ].join(' '),
        strokeWidthPdfUnits: pdfTextMarkupNativeAppearance.strikeOutStrokeWidth,
    };
}

function createSquigglyDrawLayerPath(
    box: IPdfjsHighlightBox,
    drawLayerRect: ITextMarkupRect,
    pageWidth: number,
): ITextMarkupLivePath {
    const local = toUnitBox(box, drawLayerRect);
    const dy = box.height / pdfTextMarkupNativeAppearance.squigglyHeightRatio / drawLayerRect.height;
    const step = pdfTextMarkupNativeAppearance.squigglyStep / pageWidth / drawLayerRect.width;
    let shift = dy;
    let x = local.left;
    const commands = [`M ${formatMarkupNumber(x)} ${formatMarkupNumber(local.bottom - shift)}`];

    do {
        x += step;
        shift = shift === 0 ? dy : 0;
        commands.push(`L ${formatMarkupNumber(x)} ${formatMarkupNumber(local.bottom - shift)}`);
    } while (x < local.right);

    return {
        d: commands.join(' '),
        strokeWidthPdfUnits: pdfTextMarkupNativeAppearance.squigglyStrokeWidth,
    };
}

function createTextMarkupDrawLayerPath(
    subtype: TMarkupSubtype,
    box: IPdfjsHighlightBox,
    drawLayerRect: ITextMarkupRect,
    pageDimensions: readonly [number, number],
) {
    if (subtype === 'Underline') {
        return createUnderlineDrawLayerPath(box, drawLayerRect, pageDimensions[1]);
    }
    if (subtype === 'Squiggly') {
        return createSquigglyDrawLayerPath(box, drawLayerRect, pageDimensions[0]);
    }
    if (subtype === 'StrikeOut') {
        return createStrikeOutDrawLayerPath(box, drawLayerRect);
    }
    return null;
}

export function createTextMarkupDrawLayerVisualPlan(options: {
    boxes: readonly IPdfjsHighlightBox[];
    drawLayerRect: ITextMarkupRect;
    pageDimensions: readonly [number, number];
    subtype: TMarkupSubtype;
}): ITextMarkupLiveVisualPlan | null {
    const {
        boxes,
        drawLayerRect,
        pageDimensions,
        subtype,
    } = options;
    if (
        subtype === 'Highlight'
        || !isFinitePositiveRect(drawLayerRect)
        || pageDimensions.some(dimension => !Number.isFinite(dimension) || dimension <= 0)
    ) {
        return null;
    }

    const paths = normalizeTextMarkupBoxesByLine(boxes).flatMap((box) => {
        const path = createTextMarkupDrawLayerPath(subtype, box, drawLayerRect, pageDimensions);
        return path ? [path] : [];
    });
    if (paths.length === 0) {
        return null;
    }

    return {
        paths,
        viewBox: '0 0 1 1',
    };
}
