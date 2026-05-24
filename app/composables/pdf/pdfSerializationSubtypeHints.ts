import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    TMarkupSubtype,
} from '@app/types/annotations';
import { groupBy } from 'es-toolkit/array';

export type TMarkupSubtypeHintSource = 'editor-live' | IAnnotationCommentSummary['source'];

export interface IMarkupSubtypeHint {
    subtype: TMarkupSubtype;
    pageIndex: number;
    markerRect: IAnnotationMarkerRect;
    consumed: boolean;
    annotationId?: string | null;
    color?: string | null;
    id?: string | null;
    pageMarkupIndex?: number | null;
    source?: TMarkupSubtypeHintSource | null;
}

const REWRITABLE_SUBTYPE_HINTS = new Set<TMarkupSubtype>([
    'Underline',
    'StrikeOut',
    'Squiggly',
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

function shouldCollectMarkupSubtypeHint(comment: IAnnotationCommentSummary, subtype: TMarkupSubtype) {
    if (subtype === 'Highlight') {
        return true;
    }
    return REWRITABLE_SUBTYPE_HINTS.has(subtype);
}

export function collectMarkupSubtypeHints(comments: IAnnotationCommentSummary[]): IMarkupSubtypeHint[] {
    const hints: IMarkupSubtypeHint[] = [];
    const pageMarkupIndexes = new Map<number, number>();
    for (const comment of comments) {
        if (!isMarkupSubtype(comment.subtype)) {
            continue;
        }
        if (!isValidMarkerRect(comment.markerRect)) {
            continue;
        }
        const pageMarkupIndex = pageMarkupIndexes.get(comment.pageIndex) ?? 0;
        pageMarkupIndexes.set(comment.pageIndex, pageMarkupIndex + 1);
        if (!shouldCollectMarkupSubtypeHint(comment, comment.subtype)) {
            continue;
        }
        hints.push({
            annotationId: comment.annotationId,
            color: comment.color,
            id: comment.id,
            subtype: comment.subtype,
            pageIndex: comment.pageIndex,
            markerRect: comment.markerRect,
            consumed: false,
            pageMarkupIndex,
            source: comment.source,
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
