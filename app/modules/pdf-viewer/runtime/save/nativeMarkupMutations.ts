import type {
    IAnnotationCommentSummary,
    TMarkupSubtype,
} from '@app/types/annotations';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import { collectMarkupSubtypeHints } from '@app/modules/pdf-viewer/engine/pdf-serialization-subtype-hints/collectMarkupSubtypeHints';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/engine/pdf-serialization-subtype-hints/pdfSerializationSubtypeHintsTypes';
import type { IPdfNativeMarkupSubtypeHint } from '@contracts/electronApiDocuments';

const NATIVE_MARKUP_SUBTYPES = new Set<TMarkupSubtype>([
    'Highlight',
    'Underline',
    'StrikeOut',
    'Squiggly',
]);

function isNativeMarkupSubtype(value: unknown): value is TMarkupSubtype {
    return typeof value === 'string' && NATIVE_MARKUP_SUBTYPES.has(value as TMarkupSubtype);
}

function isNativeMarkupHintEligible(hint: IMarkupSubtypeHint) {
    return isNativeMarkupSubtype(hint.subtype)
        && Number.isSafeInteger(hint.pageIndex)
        && hint.pageIndex >= 0
        && Boolean(normalizeMarkerRect(hint.markerRect));
}

export function toNativeMarkupHint(hint: IMarkupSubtypeHint): IPdfNativeMarkupSubtypeHint | null {
    if (!isNativeMarkupHintEligible(hint)) {
        return null;
    }
    const markerRect = normalizeMarkerRect(hint.markerRect);
    if (!markerRect) {
        return null;
    }
    return {
        subtype: hint.subtype,
        pageIndex: hint.pageIndex,
        markerRect,
        annotationId: hint.annotationId ?? null,
        color: hint.color ?? null,
        id: hint.id ?? null,
        pageMarkupIndex: typeof hint.pageMarkupIndex === 'number' && Number.isSafeInteger(hint.pageMarkupIndex)
            ? hint.pageMarkupIndex
            : null,
        source: hint.source ?? null,
    };
}

export function buildNativeMarkupMutationForSave(opts: {
    annotationCommentsSnapshot: IAnnotationCommentSummary[];
    annotationWorkDirty: boolean;
    markupSubtypeOverrides: Map<string, TMarkupSubtype> | undefined;
    markupSubtypeHints: IMarkupSubtypeHint[];
}) {
    if (!opts.annotationWorkDirty) {
        return null;
    }
    const overrides = Array.from(opts.markupSubtypeOverrides?.entries() ?? [])
        .filter((entry): entry is [string, TMarkupSubtype] =>
            typeof entry[0] === 'string'
            && entry[0].trim().length > 0
            && isNativeMarkupSubtype(entry[1]))
        .map(([
            id,
            subtype,
        ]) => [
            id.trim(),
            subtype,
        ] as const);
    const liveHints = opts.markupSubtypeHints
        .map(toNativeMarkupHint)
        .filter((hint): hint is IPdfNativeMarkupSubtypeHint => hint !== null);
    const editedCommentHints = collectMarkupSubtypeHints(opts.annotationCommentsSnapshot)
        // Full rewrites need all preservation hints; incremental native markup should touch
        // only hints that represent a user-visible markup edit.
        .filter(hint => hint.color !== null || hint.source === 'editor')
        .map(toNativeMarkupHint)
        .filter((hint): hint is IPdfNativeMarkupSubtypeHint => hint !== null);
    if (overrides.length + liveHints.length + editedCommentHints.length === 0) {
        return null;
    }
    return {
        overrides,
        hints: [
            ...liveHints,
            ...editedCommentHints,
        ],
    };
}
