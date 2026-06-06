import { meanBy } from 'es-toolkit/math';

const SAME_TEXT_MARKUP_LINE_CENTER_TOLERANCE_RATIO = 0.35;

const MIN_TEXT_MARKUP_QUAD_HEIGHT = 0.01;

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
