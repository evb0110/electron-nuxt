import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    TMarkupSubtype,
} from '@app/types/annotations';
import { groupBy } from 'es-toolkit/array';

export interface IMarkupSubtypeHint {
    subtype: TMarkupSubtype;
    pageIndex: number;
    markerRect: IAnnotationMarkerRect;
    consumed: boolean;
}

const SUBTYPE_HINTS = new Set<TMarkupSubtype>([
    'Underline',
    'StrikeOut',
]);

function isMarkupSubtype(value: unknown): value is TMarkupSubtype {
    return value === 'Highlight'
        || value === 'Underline'
        || value === 'StrikeOut'
        || value === 'Squiggly';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isValidMarkerRect(value: unknown): value is IAnnotationMarkerRect {
    if (!isRecord(value)) {
        return false;
    }

    const {
        left,
        top,
        width,
        height,
    } = value;

    return typeof left === 'number'
        && typeof top === 'number'
        && typeof width === 'number'
        && typeof height === 'number'
        && Number.isFinite(left)
        && Number.isFinite(top)
        && Number.isFinite(width)
        && Number.isFinite(height)
        && width > 0
        && height > 0;
}

export function collectMarkupSubtypeHints(comments: IAnnotationCommentSummary[]): IMarkupSubtypeHint[] {
    const hints: IMarkupSubtypeHint[] = [];
    for (const comment of comments) {
        if (comment.source !== 'editor') {
            continue;
        }
        if (!isMarkupSubtype(comment.subtype) || !SUBTYPE_HINTS.has(comment.subtype)) {
            continue;
        }
        if (!isValidMarkerRect(comment.markerRect)) {
            continue;
        }
        hints.push({
            subtype: comment.subtype,
            pageIndex: comment.pageIndex,
            markerRect: comment.markerRect,
            consumed: false,
        });
    }
    return hints;
}

export function groupMarkupSubtypeHintsByPage(hints: IMarkupSubtypeHint[]) {
    return new Map(
        Object.entries(groupBy(hints, hint => hint.pageIndex))
            .map(([
                pageIndex,
                pageHints,
            ]) => ([
                Number(pageIndex),
                pageHints,
            ])),
    );
}
