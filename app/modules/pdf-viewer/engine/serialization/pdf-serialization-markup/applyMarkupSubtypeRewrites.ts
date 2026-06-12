import type {
    PDFDict,
    PDFDocument,
    PDFRef,
} from 'pdf-lib';
import {
    PDFHexString,
    LineCapStyle,
    PDFArray,
    PDFName,
    PDFNumber,
    lineTo,
    moveTo,
    popGraphicsState,
    pushGraphicsState,
    rgb,
    setLineCap,
    setLineWidth,
    setStrokingColor,
    stroke,
} from 'pdf-lib';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import type {
    IAnnotationMarkerRect,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { normalizePageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizePageRotation';
import { markerRectIoU } from '@app/modules/pdf-viewer/engine/annotation-geometry/markerRectIoU';
import { toMarkerRectFromPdfRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/toMarkerRectFromPdfRect';
import { normalizePdfTextMarkupQuadPoints } from '@app/modules/pdf-viewer/engine/text-markup-visual-model/normalizePdfTextMarkupQuadPoints';
import type { TPdfTextMarkupRect } from '@app/modules/pdf-viewer/engine/text-markup-visual-model/textMarkupVisualModelTypes';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/engine/pdf-serialization-subtype-hints/pdfSerializationSubtypeHintsTypes';
import {
    formatPdfJsAnnotationRef,
    normalizePdfJsAnnotationId,
} from '@app/utils/pdfAnnotationRefs';
import { getPdfStringValue } from '@app/utils/pdfDict';
import { readPdfRectFromDict } from '@pdf-core';
import { iterateAnnotationRefDicts } from '@app/modules/pdf-viewer/engine/pdf-page-annotation-iteration/iterateAnnotationRefDicts';
import { resolvePageAnnotationContext } from '@app/modules/pdf-viewer/engine/pdf-page-annotation-iteration/resolvePageAnnotationContext';
import { clampRgbChannel } from '@app/modules/pdf-viewer/engine/text-markup-color/clampRgbChannel';
import { parseCssRgbColor } from '@app/modules/pdf-viewer/engine/text-markup-color/parseCssRgbColor';
import type { IRgbColor } from '@app/modules/pdf-viewer/engine/text-markup-color/rgbColor';
import { toOpaqueHighlightDisplayRgbColor } from '@app/modules/pdf-viewer/engine/text-markup-color/toOpaqueHighlightDisplayRgbColor';

const MARKUP_SUBTYPE_TO_PDF_NAME: Record<TMarkupSubtype, string> = {
    Highlight: 'Highlight',
    Underline: 'Underline',
    StrikeOut: 'StrikeOut',
    Squiggly: 'Squiggly',
};

const MIN_MARKUP_SUBTYPE_HINT_IOU = 0.45;

const DUPLICATE_MARKUP_SUBTYPE_HINT_IOU = 0.92;

const EXPLICIT_REF_MATCH_SCORE = 100;

const GEOMETRY_MATCH_WEIGHT = 10;

const COLOR_MATCH_WEIGHT = 1.5;

const PAGE_MARKUP_INDEX_MATCH_BONUS = 0.25;

const PAGE_MARKUP_INDEX_MISMATCH_PENALTY = 0.08;

const MARKUP_ANNOTATION_NAME_PREFIX = 'evb-markup:';
const ANNOTATION_NAME = PDFName.of('NM');

const MAX_RGB_DISTANCE = Math.sqrt((255 ** 2) * 3);

interface IMarkupAnnotationCandidate {
    color: IRgbColor | null;
    dict: PDFDict;
    markerRect: IAnnotationMarkerRect | null;
    pageMarkupIndex: number;
    ref: PDFRef;
    refTag: string;
}

function buildMarkupRewriteInputs(
    overrides: Array<readonly [string, TMarkupSubtype]>,
    subtypeHints: IMarkupSubtypeHint[],
) {
    const overridesMap = new Map<string, TMarkupSubtype>(overrides);
    if (overridesMap.size === 0 && subtypeHints.length === 0) {
        return null;
    }

    const hintsByPage = new Map<number, IMarkupSubtypeHint[]>();
    dedupeMarkupSubtypeHints(subtypeHints).forEach((hint) => {
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

function mergeSubtypeHints(existing: IMarkupSubtypeHint, incoming: IMarkupSubtypeHint): IMarkupSubtypeHint {
    return {
        ...existing,
        annotationId: existing.annotationId ?? incoming.annotationId ?? null,
        color: existing.color ?? incoming.color ?? null,
        id: existing.id ?? incoming.id ?? null,
        pageMarkupIndex: existing.pageMarkupIndex ?? incoming.pageMarkupIndex ?? null,
        consumed: false,
    };
}

function subtypeHintsShareIdentity(left: IMarkupSubtypeHint, right: IMarkupSubtypeHint) {
    if (left.subtype !== right.subtype) {
        return false;
    }
    const leftRef = normalizeHintAnnotationRef(left);
    const rightRef = normalizeHintAnnotationRef(right);
    return (
        Boolean(left.id) && left.id === right.id
    ) || (
        Boolean(leftRef) && leftRef === rightRef
    );
}

function subtypeHintsShareGeometry(left: IMarkupSubtypeHint, right: IMarkupSubtypeHint) {
    return (
        left.pageIndex === right.pageIndex
        && left.subtype === right.subtype
        && !hintColorsConflict(left, right)
        && markerRectIoU(left.markerRect, right.markerRect) >= DUPLICATE_MARKUP_SUBTYPE_HINT_IOU
    );
}

function subtypeHintsAreDuplicates(left: IMarkupSubtypeHint, right: IMarkupSubtypeHint) {
    return subtypeHintsShareIdentity(left, right) || subtypeHintsShareGeometry(left, right);
}

function dedupeMarkupSubtypeHints(subtypeHints: IMarkupSubtypeHint[]) {
    const deduped: IMarkupSubtypeHint[] = [];
    subtypeHints.forEach((hint) => {
        const existingIndex = deduped.findIndex(existing => subtypeHintsAreDuplicates(existing, hint));
        const existing = deduped[existingIndex];
        if (!existing) {
            deduped.push(hint);
            return;
        }
        deduped[existingIndex] = mergeSubtypeHints(existing, hint);
    });
    return deduped;
}

function toHintPageMarkupIndex(hint: IMarkupSubtypeHint) {
    return typeof hint.pageMarkupIndex === 'number' && Number.isInteger(hint.pageMarkupIndex)
        ? hint.pageMarkupIndex
        : null;
}

function toPdfColorChannel(value: number, allChannelsAreUnitRange: boolean) {
    return clampRgbChannel(allChannelsAreUnitRange ? value * 255 : value);
}

function readPdfMarkupColor(dict: PDFDict): IRgbColor | null {
    const color = dict.lookupMaybe(PDFName.of('C'), PDFArray);
    if (!(color instanceof PDFArray) || color.size() < 3) {
        return null;
    }

    const channels: number[] = [];
    for (let index = 0; index < 3; index += 1) {
        const value = color.get(index);
        if (!(value instanceof PDFNumber)) {
            return null;
        }
        const channel = value.asNumber();
        if (!Number.isFinite(channel)) {
            return null;
        }
        channels.push(channel);
    }

    const allChannelsAreUnitRange = channels.every(channel => channel >= 0 && channel <= 1);
    return {
        r: toPdfColorChannel(channels[0]!, allChannelsAreUnitRange),
        g: toPdfColorChannel(channels[1]!, allChannelsAreUnitRange),
        b: toPdfColorChannel(channels[2]!, allChannelsAreUnitRange),
    };
}

function parseHintColor(value: string | null | undefined): IRgbColor | null {
    return parseCssRgbColor(value);
}

function resolveHintTargetColor(targetSubtype: TMarkupSubtype, color: string | null | undefined) {
    const parsed = parseHintColor(color);
    if (!parsed) {
        return null;
    }
    if (targetSubtype !== 'Highlight') {
        return parsed;
    }
    return toOpaqueHighlightDisplayRgbColor(
        color,
        DEFAULT_ANNOTATION_SETTINGS.highlightOpacity,
    ) ?? parsed;
}

function writePdfMarkupColor(doc: PDFDocument, dict: PDFDict, color: IRgbColor) {
    dict.set(
        PDFName.of('C'),
        doc.context.obj([
            color.r / 255,
            color.g / 255,
            color.b / 255,
        ]),
    );
}

function colorSimilarity(left: IRgbColor | null, right: IRgbColor | null) {
    if (!left || !right) {
        return null;
    }
    const distance = Math.sqrt(
        ((left.r - right.r) ** 2)
        + ((left.g - right.g) ** 2)
        + ((left.b - right.b) ** 2),
    );
    return Math.max(0, 1 - (distance / MAX_RGB_DISTANCE));
}

function hintColorsConflict(left: IMarkupSubtypeHint, right: IMarkupSubtypeHint) {
    if (!left.color || !right.color) {
        return false;
    }
    const similarity = colorSimilarity(parseHintColor(left.color), parseHintColor(right.color));
    return similarity !== null && similarity < 0.98;
}

function normalizeHintAnnotationRef(hint: IMarkupSubtypeHint) {
    return normalizePdfJsAnnotationId(hint.annotationId);
}

function scoreSubtypeHintForCandidate(
    hint: IMarkupSubtypeHint,
    candidate: IMarkupAnnotationCandidate,
) {
    if (hint.consumed || hint.pageIndex < 0) {
        return null;
    }

    const hintRef = normalizeHintAnnotationRef(hint);
    const refMatched = hintRef === candidate.refTag;
    const geometryScore = markerRectIoU(candidate.markerRect, hint.markerRect);
    if (
        !refMatched
        && (
            hintRef
            || !canUseGeometryOnlySubtypeHint(hint)
            || geometryScore < MIN_MARKUP_SUBTYPE_HINT_IOU
        )
    ) {
        return null;
    }

    const hintPageMarkupIndex = toHintPageMarkupIndex(hint);
    const indexDelta = hintPageMarkupIndex === null
        ? 0
        : Math.abs(hintPageMarkupIndex - candidate.pageMarkupIndex);
    const indexScore = hintPageMarkupIndex === null
        ? 0
        : hintPageMarkupIndex === candidate.pageMarkupIndex
            ? PAGE_MARKUP_INDEX_MATCH_BONUS
            : -(Math.min(indexDelta, 3) * PAGE_MARKUP_INDEX_MISMATCH_PENALTY);
    const colorScore = colorSimilarity(parseHintColor(hint.color), candidate.color) ?? 0;

    return (
        (refMatched ? EXPLICIT_REF_MATCH_SCORE : 0)
        + (geometryScore * GEOMETRY_MATCH_WEIGHT)
        + (colorScore * COLOR_MATCH_WEIGHT)
        + indexScore
    );
}

function canUseGeometryOnlySubtypeHint(hint: IMarkupSubtypeHint) {
    if (hint.subtype === 'Highlight') {
        return true;
    }
    return !hint.source || hint.source === 'editor-live';
}

function assignSubtypeHintsToCandidates(
    pageHints: IMarkupSubtypeHint[],
    candidates: IMarkupAnnotationCandidate[],
) {
    const matches: Array<{
        candidate: IMarkupAnnotationCandidate;
        hint: IMarkupSubtypeHint;
        score: number;
    }> = [];
    candidates.forEach((candidate) => {
        pageHints.forEach((hint) => {
            const score = scoreSubtypeHintForCandidate(hint, candidate);
            if (score === null) {
                return;
            }
            matches.push({
                candidate,
                hint,
                score,
            });
        });
    });

    matches.sort((left, right) => right.score - left.score);

    const assignedCandidates = new Set<IMarkupAnnotationCandidate>();
    const assignedHints = new Set<IMarkupSubtypeHint>();
    const assignments = new Map<IMarkupAnnotationCandidate, IMarkupSubtypeHint>();
    matches.forEach((match) => {
        if (assignedCandidates.has(match.candidate) || assignedHints.has(match.hint)) {
            return;
        }
        assignedCandidates.add(match.candidate);
        assignedHints.add(match.hint);
        match.hint.consumed = true;
        assignments.set(match.candidate, match.hint);
    });
    return assignments;
}

function findBestExactRefHintForCandidate(
    pageHints: IMarkupSubtypeHint[],
    candidate: IMarkupAnnotationCandidate,
) {
    let best: {
        hint: IMarkupSubtypeHint;
        score: number;
    } | null = null;

    for (const hint of pageHints) {
        if (normalizeHintAnnotationRef(hint) !== candidate.refTag) {
            continue;
        }
        const score = scoreSubtypeHintForCandidate(hint, candidate);
        if (score === null) {
            continue;
        }
        if (!best || score > best.score) {
            best = {
                hint,
                score,
            };
        }
    }

    return best?.hint ?? null;
}

function findExactRefHighlightPreservationHint(
    pageHints: IMarkupSubtypeHint[],
    candidate: IMarkupAnnotationCandidate,
) {
    for (const hint of pageHints) {
        if (hint.consumed || hint.subtype !== 'Highlight') {
            continue;
        }
        if (normalizeHintAnnotationRef(hint) === candidate.refTag) {
            return hint;
        }
    }
    return null;
}

function consumeExactRefHints(
    pageHints: IMarkupSubtypeHint[],
    candidate: IMarkupAnnotationCandidate,
) {
    pageHints.forEach((hint) => {
        if (normalizeHintAnnotationRef(hint) === candidate.refTag) {
            hint.consumed = true;
        }
    });
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

function normalizeMarkupQuadPointsForSubtypeRewrite(dict: PDFDict) {
    const quadPointData = readPdfMarkupQuadPoints(dict);
    if (!quadPointData) {
        return false;
    }

    const normalizedValues = normalizePdfTextMarkupQuadPoints(quadPointData.values);
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

function normalizePdfRect(rect: readonly number[]): TPdfTextMarkupRect | null {
    if (rect.length < 4 || rect.some(value => !Number.isFinite(value))) {
        return null;
    }
    const left = Math.min(rect[0]!, rect[2]!);
    const right = Math.max(rect[0]!, rect[2]!);
    const bottom = Math.min(rect[1]!, rect[3]!);
    const top = Math.max(rect[1]!, rect[3]!);
    if (right <= left || top <= bottom) {
        return null;
    }
    return [
        left,
        bottom,
        right,
        top,
    ];
}

function rectToFallbackQuadPoints(rect: TPdfTextMarkupRect) {
    const [
        left,
        bottom,
        right,
        top,
    ] = rect;
    return [
        left,
        top,
        right,
        top,
        left,
        bottom,
        right,
        bottom,
    ];
}

function ensureMarkupQuadPointsForSubtypeRewrite(doc: PDFDocument, dict: PDFDict) {
    if (readPdfMarkupQuadPoints(dict)) {
        return normalizeMarkupQuadPointsForSubtypeRewrite(dict);
    }
    const rect = normalizePdfRect(readPdfRectFromDict(dict) ?? []);
    if (!rect) {
        return false;
    }
    dict.set(
        PDFName.of('QuadPoints'),
        doc.context.obj(rectToFallbackQuadPoints(rect).map(value => PDFNumber.of(value))),
    );
    return true;
}

function toMarkupSubtypeName(name: PDFName): TMarkupSubtype | null {
    switch (name.toString()) {
        case '/Highlight':
            return 'Highlight';
        case '/Underline':
            return 'Underline';
        case '/StrikeOut':
            return 'StrikeOut';
        case '/Squiggly':
            return 'Squiggly';
        default:
            return null;
    }
}

const SQUIGGLY_APPEARANCE_STROKE_WIDTH = 1;

const SQUIGGLY_APPEARANCE_MAX_AMPLITUDE = 2;

const SQUIGGLY_APPEARANCE_MIN_AMPLITUDE = 0.6;

const SQUIGGLY_APPEARANCE_AMPLITUDE_RATIO = 0.07;

function buildSquigglyAppearanceOperators(values: readonly number[], color: IRgbColor) {
    const operators = [
        pushGraphicsState(),
        setStrokingColor(rgb(color.r / 255, color.g / 255, color.b / 255)),
        setLineWidth(SQUIGGLY_APPEARANCE_STROKE_WIDTH),
        setLineCap(LineCapStyle.Round),
    ];

    let hasPath = false;
    for (let offset = 0; offset + 8 <= values.length; offset += 8) {
        const xs = [
            values[offset]!,
            values[offset + 2]!,
            values[offset + 4]!,
            values[offset + 6]!,
        ];
        const ys = [
            values[offset + 1]!,
            values[offset + 3]!,
            values[offset + 5]!,
            values[offset + 7]!,
        ];
        const left = Math.min(...xs);
        const right = Math.max(...xs);
        const bottom = Math.min(...ys);
        const top = Math.max(...ys);
        const height = top - bottom;
        if (right - left <= 0 || height <= 0) {
            continue;
        }
        const amplitude = Math.min(
            SQUIGGLY_APPEARANCE_MAX_AMPLITUDE,
            Math.max(SQUIGGLY_APPEARANCE_MIN_AMPLITUDE, height * SQUIGGLY_APPEARANCE_AMPLITUDE_RATIO),
        );
        const center = bottom + amplitude;
        const halfStep = Math.max(1.5, amplitude * 1.5);
        operators.push(moveTo(left, center - amplitude));
        let x = left;
        let up = true;
        while (x < right) {
            x = Math.min(right, x + halfStep);
            operators.push(lineTo(x, up ? center + amplitude : center - amplitude));
            up = !up;
        }
        hasPath = true;
    }
    if (!hasPath) {
        return null;
    }
    operators.push(stroke(), popGraphicsState());
    return operators;
}

// Squiggly needs an explicit appearance stream. Highlight/Underline/StrikeOut are
// re-synthesised from QuadPoints by readers (including Apple Preview / Quartz),
// but Squiggly is not, so without an /AP the annotation renders invisibly there.
function writeSquigglyAppearanceStream(doc: PDFDocument, dict: PDFDict, color: IRgbColor) {
    const quad = readPdfMarkupQuadPoints(dict);
    const rect = normalizePdfRect(readPdfRectFromDict(dict) ?? []);
    if (!quad || !rect) {
        return false;
    }
    const operators = buildSquigglyAppearanceOperators(quad.values, color);
    if (!operators) {
        return false;
    }
    const appearanceRef = doc.context.register(
        doc.context.formXObject(operators, {
            BBox: doc.context.obj([
                rect[0],
                rect[1],
                rect[2],
                rect[3],
            ]),
            Matrix: doc.context.obj([
                1,
                0,
                0,
                1,
                0,
                0,
            ]),
        }),
    );
    dict.set(PDFName.of('AP'), doc.context.obj({ N: appearanceRef }));
    return true;
}

function applySubtypeRewriteToDict(
    doc: PDFDocument,
    dict: PDFDict,
    subtypeName: PDFName,
    targetSubtype: TMarkupSubtype,
    color?: string | null,
) {
    let modified = ensureMarkupAnnotationName(dict);
    const targetColor = resolveHintTargetColor(targetSubtype, color);
    if (targetColor) {
        writePdfMarkupColor(doc, dict, targetColor);
        if (targetSubtype === 'Highlight') {
            dict.set(PDFName.of('CA'), PDFNumber.of(1));
        }
        dict.delete(PDFName.of('AP'));
        modified = true;
    }

    const pdfSubtypeName = MARKUP_SUBTYPE_TO_PDF_NAME[targetSubtype];
    if (!pdfSubtypeName || pdfSubtypeName === 'Highlight') {
        return modified;
    }
    const currentSubtype = dict.get(subtypeName);
    const subtypeAlreadyApplied = currentSubtype instanceof PDFName
        && currentSubtype.toString() === `/${pdfSubtypeName}`;
    if (subtypeAlreadyApplied) {
        modified = ensureMarkupQuadPointsForSubtypeRewrite(doc, dict) || modified;
    } else {
        ensureMarkupQuadPointsForSubtypeRewrite(doc, dict);
        dict.set(subtypeName, PDFName.of(pdfSubtypeName));
        dict.delete(PDFName.of('AP'));
        modified = true;
    }

    if (targetSubtype === 'Squiggly') {
        const appearanceColor = targetColor ?? readPdfMarkupColor(dict);
        if (appearanceColor && writeSquigglyAppearanceStream(doc, dict, appearanceColor)) {
            modified = true;
        }
    }

    return modified;
}

function ensureMarkupAnnotationName(dict: PDFDict) {
    const currentName = getPdfStringValue(dict.get(ANNOTATION_NAME)).trim();
    if (currentName) {
        return false;
    }

    dict.set(
        ANNOTATION_NAME,
        PDFHexString.fromText(`${MARKUP_ANNOTATION_NAME_PREFIX}${crypto.randomUUID()}`),
    );
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

function createMarkupAnnotationCandidate(
    dict: PDFDict,
    ref: PDFRef,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
    pageMarkupIndex: number,
): IMarkupAnnotationCandidate {
    return {
        color: readPdfMarkupColor(dict),
        dict,
        markerRect: toMarkerRectFromPdfRect(
            readPdfRectFromDict(dict),
            pageView,
            pageRotation,
        ),
        pageMarkupIndex,
        ref,
        refTag: formatPdfJsAnnotationRef(ref),
    };
}

function rewritePageMarkupSubtypes(
    doc: PDFDocument,
    candidates: IMarkupAnnotationCandidate[],
    overridesMap: Map<string, TMarkupSubtype>,
    pageHints: IMarkupSubtypeHint[],
    subtypeName: PDFName,
) {
    let rewritten = false;
    const unmatchedCandidates: IMarkupAnnotationCandidate[] = [];

    candidates.forEach((candidate) => {
        const exactRefHighlightHint = findExactRefHighlightPreservationHint(pageHints, candidate);
        if (exactRefHighlightHint) {
            consumeExactRefHints(pageHints, candidate);
            if (applySubtypeRewriteToDict(doc, candidate.dict, subtypeName, exactRefHighlightHint.subtype, exactRefHighlightHint.color)) {
                rewritten = true;
            }
            return;
        }

        const exactRefHint = findBestExactRefHintForCandidate(pageHints, candidate);
        if (exactRefHint) {
            exactRefHint.consumed = true;
            if (applySubtypeRewriteToDict(doc, candidate.dict, subtypeName, exactRefHint.subtype, exactRefHint.color)) {
                rewritten = true;
            }
            return;
        }

        const overrideSubtype = overridesMap.get(candidate.refTag) ?? null;
        if (!overrideSubtype) {
            unmatchedCandidates.push(candidate);
            return;
        }
        pageHints.forEach((hint) => {
            if (normalizeHintAnnotationRef(hint) === candidate.refTag) {
                hint.consumed = true;
            }
        });
        if (applySubtypeRewriteToDict(doc, candidate.dict, subtypeName, overrideSubtype)) {
            rewritten = true;
        }
    });

    if (pageHints.length === 0 || unmatchedCandidates.length === 0) {
        return rewritten;
    }

    const assignments = assignSubtypeHintsToCandidates(pageHints, unmatchedCandidates);
    assignments.forEach((hint, candidate) => {
        if (applySubtypeRewriteToDict(doc, candidate.dict, subtypeName, hint.subtype, hint.color)) {
            rewritten = true;
        }
    });
    return rewritten;
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
    let rewritten = false;

    forEachPageAnnotationContext(doc, (pageIndex, context) => {
        const pageHints = inputs.hintsByPage.get(pageIndex) ?? [];
        let pageMarkupIndex = 0;
        const candidates: IMarkupAnnotationCandidate[] = [];

        for (const {
            dict,
            ref,
        } of iterateAnnotationRefDicts(doc, context.annots)) {
            const currentSubtype = dict.get(subtypeName);
            if (!(currentSubtype instanceof PDFName)) {
                continue;
            }

            const currentMarkupSubtype = toMarkupSubtypeName(currentSubtype);
            if (!currentMarkupSubtype) {
                continue;
            }
            candidates.push(createMarkupAnnotationCandidate(
                dict,
                ref,
                context.pageView,
                context.pageRotation,
                pageMarkupIndex,
            ));
            pageMarkupIndex += 1;
        }

        rewritten = rewritePageMarkupSubtypes(
            doc,
            candidates,
            inputs.overridesMap,
            pageHints,
            subtypeName,
        ) || rewritten;
    });

    return rewritten;
}
