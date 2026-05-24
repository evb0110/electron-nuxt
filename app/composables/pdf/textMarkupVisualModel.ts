import type { TMarkupSubtype } from '@app/types/annotations';
import type { IPdfjsHighlightBox } from '@app/types/pdfjs';
import { meanBy } from 'es-toolkit/math';

export const PDF_TEXT_MARKUP_NATIVE_APPEARANCE = {
    underlineStrokeWidth: 0.571,
    underlineYOffset: 1.3,
    strikeOutStrokeWidth: 1,
    squigglyStrokeWidth: 1,
    squigglyStep: 2,
    squigglyHeightRatio: 6,
} as const;

const SAME_TEXT_MARKUP_LINE_CENTER_TOLERANCE_RATIO = 0.35;
const MIN_TEXT_MARKUP_BOX_SIZE = 0.0005;
const MIN_TEXT_MARKUP_QUAD_HEIGHT = 0.01;

export type TPdfTextMarkupRect = [number, number, number, number];

export interface ITextMarkupRect {
    height: number;
    left: number;
    top: number;
    width: number;
}

interface IIndexedHighlightBox {
    box: IPdfjsHighlightBox;
    centerY: number;
    index: number;
}

interface IHighlightLineGroup {
    averageHeight: number;
    bottom: number;
    boxes: IIndexedHighlightBox[];
    centerY: number;
    top: number;
}

interface IPdfTextMarkupQuad {
    bottom: number;
    centerY: number;
    index: number;
    left: number;
    right: number;
    top: number;
}

interface IPdfTextMarkupQuadLineGroup {
    averageHeight: number;
    bottom: number;
    centerY: number;
    quads: IPdfTextMarkupQuad[];
    top: number;
}

export interface ITextMarkupLivePath {
    d: string;
    strokeWidthPdfUnits: number;
}

export interface ITextMarkupLiveVisualPlan {
    paths: ITextMarkupLivePath[];
    viewBox: string;
}

export function isFinitePositiveTextMarkupBox(box: IPdfjsHighlightBox) {
    return Number.isFinite(box.x)
        && Number.isFinite(box.y)
        && Number.isFinite(box.width)
        && Number.isFinite(box.height)
        && box.width > 0
        && box.height > 0;
}

function createHighlightLineGroup(indexedBox: IIndexedHighlightBox): IHighlightLineGroup {
    const { box } = indexedBox;
    return {
        averageHeight: box.height,
        bottom: box.y + box.height,
        boxes: [indexedBox],
        centerY: indexedBox.centerY,
        top: box.y,
    };
}

function addBoxToHighlightLineGroup(group: IHighlightLineGroup, indexedBox: IIndexedHighlightBox) {
    const { box } = indexedBox;
    group.boxes.push(indexedBox);
    group.top = Math.min(group.top, box.y);
    group.bottom = Math.max(group.bottom, box.y + box.height);
    group.centerY = meanBy(group.boxes, item => item.centerY);
    group.averageHeight = meanBy(group.boxes, item => item.box.height);
}

function belongsToHighlightLineGroup(group: IHighlightLineGroup, indexedBox: IIndexedHighlightBox) {
    const tolerance = Math.max(group.averageHeight, indexedBox.box.height) * SAME_TEXT_MARKUP_LINE_CENTER_TOLERANCE_RATIO;
    return Math.abs(indexedBox.centerY - group.centerY) <= tolerance;
}

function groupHighlightBoxesByLine(boxes: readonly IPdfjsHighlightBox[]) {
    const sortedBoxes = boxes
        .map((box, index) => ({
            box: { ...box },
            centerY: box.y + (box.height / 2),
            index,
        }))
        .filter(indexedBox => isFinitePositiveTextMarkupBox(indexedBox.box))
        .sort((left, right) => left.centerY - right.centerY || left.box.x - right.box.x);
    const groups: IHighlightLineGroup[] = [];

    for (const indexedBox of sortedBoxes) {
        const previousGroup = groups.at(-1);
        if (previousGroup && belongsToHighlightLineGroup(previousGroup, indexedBox)) {
            addBoxToHighlightLineGroup(previousGroup, indexedBox);
            continue;
        }
        groups.push(createHighlightLineGroup(indexedBox));
    }

    return groups;
}

export function normalizeTextMarkupBoxesByLine(
    boxes: readonly IPdfjsHighlightBox[],
): IPdfjsHighlightBox[] {
    const groups = groupHighlightBoxesByLine(boxes);
    if (groups.length === 0) {
        return [];
    }
    if (groups.length === 1) {
        return groups[0]!.boxes
            .sort((left, right) => left.index - right.index)
            .map(({ box }) => ({ ...box }));
    }

    const normalizedBoxes = new Map<number, IPdfjsHighlightBox>();
    groups.forEach((group, groupIndex) => {
        const previousGroup = groups[groupIndex - 1] ?? null;
        const nextGroup = groups[groupIndex + 1] ?? null;
        let lineTop = group.top;
        let lineBottom = group.bottom;

        if (previousGroup) {
            lineTop = Math.max(lineTop, (previousGroup.centerY + group.centerY) / 2);
        }
        if (nextGroup) {
            lineBottom = Math.min(lineBottom, (group.centerY + nextGroup.centerY) / 2);
        }
        if (lineBottom - lineTop < MIN_TEXT_MARKUP_BOX_SIZE) {
            lineTop = group.top;
            lineBottom = group.bottom;
        }

        for (const {
            box,
            index,
        } of group.boxes) {
            normalizedBoxes.set(index, {
                ...box,
                y: lineTop,
                height: lineBottom - lineTop,
            });
        }
    });

    return [...normalizedBoxes]
        .sort((left, right) => left[0] - right[0])
        .map(([
            ,
            box,
        ]) => box);
}

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

function toUnitBox(box: IPdfjsHighlightBox, rect: ITextMarkupRect) {
    return {
        bottom: (box.y + box.height - rect.top) / rect.height,
        left: (box.x - rect.left) / rect.width,
        right: (box.x + box.width - rect.left) / rect.width,
        top: (box.y - rect.top) / rect.height,
    };
}

export function getNativeTextMarkupStrokeWidth(subtype: TMarkupSubtype) {
    if (subtype === 'Highlight') {
        return 0;
    }
    if (subtype === 'Underline') {
        return PDF_TEXT_MARKUP_NATIVE_APPEARANCE.underlineStrokeWidth;
    }
    if (subtype === 'Squiggly') {
        return PDF_TEXT_MARKUP_NATIVE_APPEARANCE.squigglyStrokeWidth;
    }
    return PDF_TEXT_MARKUP_NATIVE_APPEARANCE.strikeOutStrokeWidth;
}

function createUnderlineLivePath(box: IPdfjsHighlightBox, editorRect: ITextMarkupRect, pageHeight: number): ITextMarkupLivePath {
    const local = toLocalBox(box, editorRect);
    const y = local.bottom - (PDF_TEXT_MARKUP_NATIVE_APPEARANCE.underlineYOffset / pageHeight);
    return {
        d: [
            `M ${formatMarkupNumber(local.left)} ${formatMarkupNumber(y)}`,
            `L ${formatMarkupNumber(local.right)} ${formatMarkupNumber(y)}`,
        ].join(' '),
        strokeWidthPdfUnits: PDF_TEXT_MARKUP_NATIVE_APPEARANCE.underlineStrokeWidth,
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
        strokeWidthPdfUnits: PDF_TEXT_MARKUP_NATIVE_APPEARANCE.strikeOutStrokeWidth,
    };
}

function createSquigglyLivePath(
    box: IPdfjsHighlightBox,
    editorRect: ITextMarkupRect,
    pageWidth: number,
): ITextMarkupLivePath {
    const local = toLocalBox(box, editorRect);
    const dy = box.height / PDF_TEXT_MARKUP_NATIVE_APPEARANCE.squigglyHeightRatio;
    const step = PDF_TEXT_MARKUP_NATIVE_APPEARANCE.squigglyStep / pageWidth;
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
        strokeWidthPdfUnits: PDF_TEXT_MARKUP_NATIVE_APPEARANCE.squigglyStrokeWidth,
    };
}

function createUnderlineDrawLayerPath(
    box: IPdfjsHighlightBox,
    drawLayerRect: ITextMarkupRect,
    pageHeight: number,
): ITextMarkupLivePath {
    const local = toUnitBox(box, drawLayerRect);
    const y = local.bottom - (PDF_TEXT_MARKUP_NATIVE_APPEARANCE.underlineYOffset / pageHeight / drawLayerRect.height);
    return {
        d: [
            `M ${formatMarkupNumber(local.left)} ${formatMarkupNumber(y)}`,
            `L ${formatMarkupNumber(local.right)} ${formatMarkupNumber(y)}`,
        ].join(' '),
        strokeWidthPdfUnits: PDF_TEXT_MARKUP_NATIVE_APPEARANCE.underlineStrokeWidth,
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
        strokeWidthPdfUnits: PDF_TEXT_MARKUP_NATIVE_APPEARANCE.strikeOutStrokeWidth,
    };
}

function createSquigglyDrawLayerPath(
    box: IPdfjsHighlightBox,
    drawLayerRect: ITextMarkupRect,
    pageWidth: number,
): ITextMarkupLivePath {
    const local = toUnitBox(box, drawLayerRect);
    const dy = box.height / PDF_TEXT_MARKUP_NATIVE_APPEARANCE.squigglyHeightRatio / drawLayerRect.height;
    const step = PDF_TEXT_MARKUP_NATIVE_APPEARANCE.squigglyStep / pageWidth / drawLayerRect.width;
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
        strokeWidthPdfUnits: PDF_TEXT_MARKUP_NATIVE_APPEARANCE.squigglyStrokeWidth,
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

    const paths = normalizeTextMarkupBoxesByLine(boxes)
        .map(box => createTextMarkupLivePath(subtype, box, editorRect, pageDimensions))
        .filter((path): path is ITextMarkupLivePath => Boolean(path));
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

    const paths = normalizeTextMarkupBoxesByLine(boxes)
        .map(box => createTextMarkupDrawLayerPath(subtype, box, drawLayerRect, pageDimensions))
        .filter((path): path is ITextMarkupLivePath => Boolean(path));
    if (paths.length === 0) {
        return null;
    }

    return {
        paths,
        viewBox: '0 0 1 1',
    };
}

function toPdfTextMarkupQuads(values: readonly number[]): IPdfTextMarkupQuad[] | null {
    const quads: IPdfTextMarkupQuad[] = [];
    for (let index = 0; index < values.length; index += 8) {
        const xs = [
            values[index]!,
            values[index + 2]!,
            values[index + 4]!,
            values[index + 6]!,
        ];
        const ys = [
            values[index + 1]!,
            values[index + 3]!,
            values[index + 5]!,
            values[index + 7]!,
        ];
        if (xs.some(value => !Number.isFinite(value)) || ys.some(value => !Number.isFinite(value))) {
            return null;
        }

        const left = Math.min(...xs);
        const right = Math.max(...xs);
        const bottom = Math.min(...ys);
        const top = Math.max(...ys);
        if (right <= left || top <= bottom) {
            return null;
        }
        quads.push({
            bottom,
            centerY: (top + bottom) / 2,
            index: index / 8,
            left,
            right,
            top,
        });
    }
    return quads;
}

function createPdfTextMarkupQuadLineGroup(quad: IPdfTextMarkupQuad): IPdfTextMarkupQuadLineGroup {
    return {
        averageHeight: quad.top - quad.bottom,
        bottom: quad.bottom,
        centerY: quad.centerY,
        quads: [quad],
        top: quad.top,
    };
}

function addPdfTextMarkupQuadToLineGroup(group: IPdfTextMarkupQuadLineGroup, quad: IPdfTextMarkupQuad) {
    group.quads.push(quad);
    group.bottom = Math.min(group.bottom, quad.bottom);
    group.top = Math.max(group.top, quad.top);
    group.centerY = meanBy(group.quads, item => item.centerY);
    group.averageHeight = meanBy(group.quads, item => item.top - item.bottom);
}

function belongsToPdfTextMarkupQuadLineGroup(group: IPdfTextMarkupQuadLineGroup, quad: IPdfTextMarkupQuad) {
    const tolerance = Math.max(group.averageHeight, quad.top - quad.bottom) * SAME_TEXT_MARKUP_LINE_CENTER_TOLERANCE_RATIO;
    return Math.abs(quad.centerY - group.centerY) <= tolerance;
}

function groupPdfTextMarkupQuadsByLine(quads: readonly IPdfTextMarkupQuad[]) {
    const groups: IPdfTextMarkupQuadLineGroup[] = [];
    const sortedQuads = [...quads].sort((left, right) => right.centerY - left.centerY || left.left - right.left);

    for (const quad of sortedQuads) {
        const previousGroup = groups.at(-1);
        if (previousGroup && belongsToPdfTextMarkupQuadLineGroup(previousGroup, quad)) {
            addPdfTextMarkupQuadToLineGroup(previousGroup, quad);
            continue;
        }
        groups.push(createPdfTextMarkupQuadLineGroup(quad));
    }
    return groups;
}

export function normalizePdfTextMarkupQuadPoints(values: readonly number[]) {
    const quads = toPdfTextMarkupQuads(values);
    if (!quads || quads.length === 0) {
        return null;
    }

    const groups = groupPdfTextMarkupQuadsByLine(quads);
    if (groups.length <= 1) {
        return values;
    }

    const normalized = [...values];
    groups.forEach((group, groupIndex) => {
        const previousGroup = groups[groupIndex - 1] ?? null;
        const nextGroup = groups[groupIndex + 1] ?? null;
        let lineTop = group.top;
        let lineBottom = group.bottom;

        if (previousGroup) {
            lineTop = Math.min(lineTop, (previousGroup.centerY + group.centerY) / 2);
        }
        if (nextGroup) {
            lineBottom = Math.max(lineBottom, (group.centerY + nextGroup.centerY) / 2);
        }
        if (lineTop - lineBottom < MIN_TEXT_MARKUP_QUAD_HEIGHT) {
            lineTop = group.top;
            lineBottom = group.bottom;
        }

        for (const quad of group.quads) {
            const offset = quad.index * 8;
            normalized[offset] = quad.left;
            normalized[offset + 1] = lineTop;
            normalized[offset + 2] = quad.right;
            normalized[offset + 3] = lineTop;
            normalized[offset + 4] = quad.left;
            normalized[offset + 5] = lineBottom;
            normalized[offset + 6] = quad.right;
            normalized[offset + 7] = lineBottom;
        }
    });

    return normalized;
}
