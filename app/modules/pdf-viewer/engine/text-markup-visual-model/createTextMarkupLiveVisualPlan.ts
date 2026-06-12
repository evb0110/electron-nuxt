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

function toLocalBox(box: IPdfjsHighlightBox, editorRect: ITextMarkupRect) {
    return {
        bottom: box.y + box.height - editorRect.top,
        left: box.x - editorRect.left,
        right: box.x + box.width - editorRect.left,
        top: box.y - editorRect.top,
    };
}

function createUnderlineLivePath(box: IPdfjsHighlightBox, editorRect: ITextMarkupRect, pageHeight: number): ITextMarkupLivePath {
    const local = toLocalBox(box, editorRect);
    const y = local.bottom - (pdfTextMarkupNativeAppearance.underlineYOffset / pageHeight);
    return {
        d: [
            `M ${formatMarkupNumber(local.left)} ${formatMarkupNumber(y)}`,
            `L ${formatMarkupNumber(local.right)} ${formatMarkupNumber(y)}`,
        ].join(' '),
        strokeWidthPdfUnits: pdfTextMarkupNativeAppearance.underlineStrokeWidth,
    };
}

function createStrikeOutLivePath(box: IPdfjsHighlightBox, editorRect: ITextMarkupRect): ITextMarkupLivePath {
    const local = toLocalBox(box, editorRect);
    const y = (local.top + local.bottom) / 2;
    return {
        d: [
            `M ${formatMarkupNumber(local.left)} ${formatMarkupNumber(y)}`,
            `L ${formatMarkupNumber(local.right)} ${formatMarkupNumber(y)}`,
        ].join(' '),
        strokeWidthPdfUnits: pdfTextMarkupNativeAppearance.strikeOutStrokeWidth,
    };
}

function createSquigglyLivePath(
    box: IPdfjsHighlightBox,
    editorRect: ITextMarkupRect,
    pageWidth: number,
): ITextMarkupLivePath {
    const local = toLocalBox(box, editorRect);
    const dy = box.height / pdfTextMarkupNativeAppearance.squigglyHeightRatio;
    const step = pdfTextMarkupNativeAppearance.squigglyStep / pageWidth;
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

function createTextMarkupLivePath(
    subtype: TMarkupSubtype,
    box: IPdfjsHighlightBox,
    editorRect: ITextMarkupRect,
    pageDimensions: readonly [number, number],
) {
    if (subtype === 'Underline') {
        return createUnderlineLivePath(box, editorRect, pageDimensions[1]);
    }
    if (subtype === 'Squiggly') {
        return createSquigglyLivePath(box, editorRect, pageDimensions[0]);
    }
    if (subtype === 'StrikeOut') {
        return createStrikeOutLivePath(box, editorRect);
    }
    return null;
}

export function createTextMarkupLiveVisualPlan(options: {
    boxes: readonly IPdfjsHighlightBox[];
    editorRect: ITextMarkupRect;
    pageDimensions: readonly [number, number];
    subtype: TMarkupSubtype;
}): ITextMarkupLiveVisualPlan | null {
    const {
        boxes,
        editorRect,
        pageDimensions,
        subtype,
    } = options;
    if (
        subtype === 'Highlight'
        || !isFinitePositiveRect(editorRect)
        || pageDimensions.some(dimension => !Number.isFinite(dimension) || dimension <= 0)
    ) {
        return null;
    }

    const paths = normalizeTextMarkupBoxesByLine(boxes).flatMap((box) => {
        const path = createTextMarkupLivePath(subtype, box, editorRect, pageDimensions);
        return path ? [path] : [];
    });
    if (paths.length === 0) {
        return null;
    }

    return {
        paths,
        viewBox: [
            '0',
            '0',
            formatMarkupNumber(editorRect.width),
            formatMarkupNumber(editorRect.height),
        ].join(' '),
    };
}
