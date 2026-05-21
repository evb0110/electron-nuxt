import type { IPdfjsHighlightBox } from '@app/types/pdfjs';

function boxesOverlapVertically(left: IPdfjsHighlightBox, right: IPdfjsHighlightBox) {
    return Math.min(left.y + left.height, right.y + right.height) > Math.max(left.y, right.y);
}

function subtractOverlappingBoxes(
    sourceBox: IPdfjsHighlightBox,
    replacementBoxes: readonly IPdfjsHighlightBox[],
) {
    const intervals: Array<[number, number]> = [[
        sourceBox.x,
        sourceBox.x + sourceBox.width,
    ]];

    for (const replacementBox of replacementBoxes) {
        if (!boxesOverlapVertically(sourceBox, replacementBox)) {
            continue;
        }
        const overlapLeft = Math.max(sourceBox.x, replacementBox.x);
        const overlapRight = Math.min(sourceBox.x + sourceBox.width, replacementBox.x + replacementBox.width);
        if (overlapRight <= overlapLeft) {
            continue;
        }

        for (let index = intervals.length - 1; index >= 0; index -= 1) {
            const [
                intervalLeft,
                intervalRight,
            ] = intervals[index]!;
            if (overlapRight <= intervalLeft || overlapLeft >= intervalRight) {
                continue;
            }
            const nextIntervals: Array<[number, number]> = [];
            if (overlapLeft > intervalLeft) {
                nextIntervals.push([
                    intervalLeft,
                    overlapLeft,
                ]);
            }
            if (overlapRight < intervalRight) {
                nextIntervals.push([
                    overlapRight,
                    intervalRight,
                ]);
            }
            intervals.splice(index, 1, ...nextIntervals);
        }
    }

    const MIN_FRAGMENT_WIDTH = 0.0005;
    return intervals
        .filter(([
            left,
            right,
        ]) => right - left >= MIN_FRAGMENT_WIDTH)
        .map(([
            left,
            right,
        ]) => ({
            ...sourceBox,
            x: left,
            width: right - left,
        }));
}

export function subtractMarkupBoxes(
    sourceBoxes: readonly IPdfjsHighlightBox[],
    replacementBoxes: readonly IPdfjsHighlightBox[],
) {
    return sourceBoxes.flatMap(box => subtractOverlappingBoxes(box, replacementBoxes));
}

export function areMarkupBoxesEqual(
    leftBoxes: readonly IPdfjsHighlightBox[],
    rightBoxes: readonly IPdfjsHighlightBox[],
) {
    if (leftBoxes.length !== rightBoxes.length) {
        return false;
    }
    return leftBoxes.every((leftBox, index) => {
        const rightBox = rightBoxes[index];
        return Boolean(
            rightBox
            && leftBox.x === rightBox.x
            && leftBox.y === rightBox.y
            && leftBox.width === rightBox.width
            && leftBox.height === rightBox.height,
        );
    });
}
