import type {
    PDFDict,
    PDFDocument,
    PDFRef,
} from 'pdf-lib';
import {
    PDFArray,
    PDFName,
    PDFNumber,
} from 'pdf-lib';
import type {
    IAnnotationMarkerRect,
    TMarkupSubtype,
} from '@app/types/annotations';
import { meanBy } from 'es-toolkit/math';
import type { normalizePageRotation} from '@app/composables/pdf/annotationGeometry';
import {
    markerRectIoU,
    toMarkerRectFromPdfRect,
} from '@app/composables/pdf/annotationGeometry';
import type { IMarkupSubtypeHint } from '@app/composables/pdf/pdfSerializationSubtypeHints';
import { formatPdfJsAnnotationRef } from '@app/composables/pdf/pdfSerializationRefs';
import { readPdfRectFromDict } from '@app/composables/pdf/pdfPageBoxes';
import {
    iterateAnnotationRefDicts,
    resolvePageAnnotationContext,
} from '@app/composables/pdf/pdfPageAnnotationIteration';

const MARKUP_SUBTYPE_TO_PDF_NAME: Record<TMarkupSubtype, string> = {
    Highlight: 'Highlight',
    Underline: 'Underline',
    StrikeOut: 'StrikeOut',
    Squiggly: 'Squiggly',
};
const SAME_MARKUP_QUAD_LINE_CENTER_TOLERANCE_RATIO = 0.35;
const MIN_MARKUP_QUAD_HEIGHT = 0.01;

interface IPdfMarkupQuad {
    bottom: number;
    centerY: number;
    index: number;
    left: number;
    right: number;
    top: number;
}

interface IPdfMarkupQuadLineGroup {
    averageHeight: number;
    bottom: number;
    centerY: number;
    quads: IPdfMarkupQuad[];
    top: number;
}

interface IMarkupRewriteInputs {
    overridesMap: Map<string, TMarkupSubtype>;
    hintsByPage: Map<number, IMarkupSubtypeHint[]>;
}

function buildMarkupRewriteInputs(
    overrides: Array<readonly [string, TMarkupSubtype]>,
    subtypeHints: IMarkupSubtypeHint[],
): IMarkupRewriteInputs | null {
    const overridesMap = new Map<string, TMarkupSubtype>(overrides);
    if (overridesMap.size === 0 && subtypeHints.length === 0) {
        return null;
    }

    const hintsByPage = new Map<number, IMarkupSubtypeHint[]>();
    subtypeHints.forEach((hint) => {
        const pageHints = hintsByPage.get(hint.pageIndex);
        const cloned: IMarkupSubtypeHint = {
            ...hint,
            consumed: false,
        };
        if (pageHints) {
            pageHints.push(cloned);
            return;
        }
        hintsByPage.set(hint.pageIndex, [cloned]);
    });

    return {
        overridesMap,
        hintsByPage,
    };
}

function findBestUnconsumedSubtypeHint(
    pageHints: IMarkupSubtypeHint[],
    markerRect: IAnnotationMarkerRect | null,
): IMarkupSubtypeHint | null {
    let best: {
        score: number;
        hint: IMarkupSubtypeHint;
    } | null = null;
    for (const hint of pageHints) {
        if (hint.consumed) {
            continue;
        }
        const score = markerRectIoU(markerRect, hint.markerRect);
        if (score <= 0) {
            continue;
        }
        if (!best || score > best.score) {
            best = {
                score,
                hint,
            };
        }
    }
    return best && best.score >= 0.2 ? best.hint : null;
}

function resolveMarkupSubtypeForAnnotation(
    dict: PDFDict,
    ref: PDFRef,
    overridesMap: Map<string, TMarkupSubtype>,
    pageHints: IMarkupSubtypeHint[],
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
): TMarkupSubtype | null {
    const overrideSubtype = overridesMap.get(formatPdfJsAnnotationRef(ref)) ?? null;
    if (overrideSubtype) {
        return overrideSubtype;
    }
    if (pageHints.length === 0) {
        return null;
    }

    const markerRect = toMarkerRectFromPdfRect(
        readPdfRectFromDict(dict),
        pageView,
        pageRotation,
    );
    const matchedHint = findBestUnconsumedSubtypeHint(pageHints, markerRect);
    if (!matchedHint) {
        return null;
    }
    matchedHint.consumed = true;
    return matchedHint.subtype;
}

function readPdfMarkupQuadPoints(dict: PDFDict) {
    const quadPoints = dict.lookupMaybe(PDFName.of('QuadPoints'), PDFArray);
    if (!(quadPoints instanceof PDFArray) || quadPoints.size() === 0 || quadPoints.size() % 8 !== 0) {
        return null;
    }

    const values: number[] = [];
    for (let index = 0; index < quadPoints.size(); index += 1) {
        const value = quadPoints.get(index);
        if (!(value instanceof PDFNumber)) {
            return null;
        }
        values.push(value.asNumber());
    }
    return {
        quadPoints,
        values,
    };
}

function toPdfMarkupQuads(values: readonly number[]): IPdfMarkupQuad[] | null {
    const quads: IPdfMarkupQuad[] = [];
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

function createPdfMarkupQuadLineGroup(quad: IPdfMarkupQuad): IPdfMarkupQuadLineGroup {
    return {
        averageHeight: quad.top - quad.bottom,
        bottom: quad.bottom,
        centerY: quad.centerY,
        quads: [quad],
        top: quad.top,
    };
}

function addPdfMarkupQuadToLineGroup(group: IPdfMarkupQuadLineGroup, quad: IPdfMarkupQuad) {
    group.quads.push(quad);
    group.bottom = Math.min(group.bottom, quad.bottom);
    group.top = Math.max(group.top, quad.top);
    group.centerY = meanBy(group.quads, item => item.centerY);
    group.averageHeight = meanBy(group.quads, item => item.top - item.bottom);
}

function belongsToPdfMarkupQuadLineGroup(group: IPdfMarkupQuadLineGroup, quad: IPdfMarkupQuad) {
    const tolerance = Math.max(group.averageHeight, quad.top - quad.bottom) * SAME_MARKUP_QUAD_LINE_CENTER_TOLERANCE_RATIO;
    return Math.abs(quad.centerY - group.centerY) <= tolerance;
}

function groupPdfMarkupQuadsByLine(quads: readonly IPdfMarkupQuad[]) {
    const groups: IPdfMarkupQuadLineGroup[] = [];
    const sortedQuads = [...quads].sort((left, right) => right.centerY - left.centerY || left.left - right.left);

    for (const quad of sortedQuads) {
        const previousGroup = groups.at(-1);
        if (previousGroup && belongsToPdfMarkupQuadLineGroup(previousGroup, quad)) {
            addPdfMarkupQuadToLineGroup(previousGroup, quad);
            continue;
        }
        groups.push(createPdfMarkupQuadLineGroup(quad));
    }
    return groups;
}

function normalizePdfMarkupQuadPoints(values: readonly number[]) {
    const quads = toPdfMarkupQuads(values);
    if (!quads || quads.length === 0) {
        return null;
    }

    const groups = groupPdfMarkupQuadsByLine(quads);
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
        if (lineTop - lineBottom < MIN_MARKUP_QUAD_HEIGHT) {
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

function normalizeMarkupQuadPointsForSubtypeRewrite(dict: PDFDict) {
    const quadPointData = readPdfMarkupQuadPoints(dict);
    if (!quadPointData) {
        return false;
    }

    const normalizedValues = normalizePdfMarkupQuadPoints(quadPointData.values);
    if (!normalizedValues) {
        return false;
    }

    let changed = false;
    for (const [
        index,
        value,
    ] of normalizedValues.entries()) {
        if (Math.abs(value - quadPointData.values[index]!) > Number.EPSILON) {
            changed = true;
        }
        quadPointData.quadPoints.set(index, PDFNumber.of(value));
    }
    return changed;
}

function applySubtypeRewriteToDict(
    dict: PDFDict,
    subtypeName: PDFName,
    targetSubtype: TMarkupSubtype,
): boolean {
    const pdfSubtypeName = MARKUP_SUBTYPE_TO_PDF_NAME[targetSubtype];
    if (!pdfSubtypeName || pdfSubtypeName === 'Highlight') {
        return false;
    }
    normalizeMarkupQuadPointsForSubtypeRewrite(dict);
    dict.set(subtypeName, PDFName.of(pdfSubtypeName));
    // PDF.js stores the selected-text editor as a Highlight appearance stream.
    // Once we rewrite the subtype, that stale appearance would still render as a highlight.
    dict.delete(PDFName.of('AP'));
    return true;
}

function forEachPageAnnotationContext(
    doc: PDFDocument,
    callback: (
        pageIndex: number,
        context: NonNullable<ReturnType<typeof resolvePageAnnotationContext>>,
    ) => void,
) {
    const pages = doc.getPages();
    for (const [
        pageIndex,
        page,
    ] of pages.entries()) {
        const context = resolvePageAnnotationContext(page);
        if (!context) {
            continue;
        }
        callback(pageIndex, context);
    }
}

export function applyMarkupSubtypeRewrites(
    doc: PDFDocument,
    overrides: Array<readonly [string, TMarkupSubtype]>,
    subtypeHints: IMarkupSubtypeHint[],
) {
    const inputs = buildMarkupRewriteInputs(overrides, subtypeHints);
    if (!inputs) {
        return false;
    }

    const subtypeName = PDFName.of('Subtype');
    const highlightName = PDFName.of('Highlight');
    let rewritten = false;

    forEachPageAnnotationContext(doc, (pageIndex, context) => {
        const pageHints = inputs.hintsByPage.get(pageIndex) ?? [];

        for (const {
            dict,
            ref,
        } of iterateAnnotationRefDicts(doc, context.annots)) {
            const currentSubtype = dict.get(subtypeName);
            if (!(currentSubtype instanceof PDFName) || currentSubtype !== highlightName) {
                continue;
            }

            const targetSubtype = resolveMarkupSubtypeForAnnotation(
                dict,
                ref,
                inputs.overridesMap,
                pageHints,
                context.pageView,
                context.pageRotation,
            );
            if (!targetSubtype) {
                continue;
            }

            if (applySubtypeRewriteToDict(dict, subtypeName, targetSubtype)) {
                rewritten = true;
            }
        }
    });

    return rewritten;
}
