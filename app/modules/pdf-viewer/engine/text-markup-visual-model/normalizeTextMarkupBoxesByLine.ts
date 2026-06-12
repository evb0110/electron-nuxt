import type { IPdfjsHighlightBox } from '@app/types/pdfjs';
import { meanBy } from 'es-toolkit/math';
import { isFinitePositiveTextMarkupBox } from '@app/modules/pdf-viewer/engine/text-markup-visual-model/isFinitePositiveTextMarkupBox';

const SAME_TEXT_MARKUP_LINE_CENTER_TOLERANCE_RATIO = 0.35;

const MIN_TEXT_MARKUP_BOX_SIZE = 0.0005;

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
