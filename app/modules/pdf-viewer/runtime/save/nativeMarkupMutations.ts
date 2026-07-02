import type {
    IAnnotationCommentSummary,
    TMarkupSubtype,
} from '@app/types/annotations';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import { collectMarkupSubtypeHints } from '@app/modules/pdf-viewer/engine/pdf-serialization-subtype-hints/collectMarkupSubtypeHints';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/engine/pdf-serialization-subtype-hints/pdfSerializationSubtypeHintsTypes';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import type { IPdfNativeMarkupSubtypeHint } from '@contracts/electronApiDocuments';
import { toPageIndex } from '@contracts/pageNumbers';
import { PDF_ANNOTATION_MARKUP_SUBTYPES } from '@contracts/annotations';
import { isOneOf } from '@contracts/runtimeGuards';

function isNativeMarkupSubtype(value: unknown): value is TMarkupSubtype {
    return isOneOf(PDF_ANNOTATION_MARKUP_SUBTYPES, value);
}

function addMarkupTargetKey(keys: Set<string>, value: string | null | undefined) {
    const normalized = value?.trim();
    if (normalized) {
        keys.add(normalized);
    }
}

function buildCurrentMarkupTargetKeys(hints: IMarkupSubtypeHint[]) {
    const keys = new Set<string>();
    for (const hint of hints) {
        addMarkupTargetKey(keys, hint.id);
        addMarkupTargetKey(keys, hint.annotationId);
        const normalizedAnnotationId = normalizePdfJsAnnotationId(hint.annotationId);
        addMarkupTargetKey(keys, normalizedAnnotationId);
        if (normalizedAnnotationId) {
            addMarkupTargetKey(keys, `ann:${hint.pageIndex}:${normalizedAnnotationId}`);
        }
    }
    return keys;
}

function hasCurrentMarkupTargetKey(keys: Set<string>, value: string | null | undefined) {
    const normalized = value?.trim();
    if (!normalized) {
        return false;
    }
    const normalizedAnnotationId = normalizePdfJsAnnotationId(normalized);
    return keys.has(normalized) || Boolean(normalizedAnnotationId && keys.has(normalizedAnnotationId));
}

function isCurrentMarkupHint(hint: IMarkupSubtypeHint, keys: Set<string>) {
    return hasCurrentMarkupTargetKey(keys, hint.annotationId)
        || hasCurrentMarkupTargetKey(keys, hint.id);
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
        pageIndex: toPageIndex(hint.pageIndex),
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
    const currentMarkupHints = collectMarkupSubtypeHints(opts.annotationCommentsSnapshot);
    const currentMarkupTargetKeys = buildCurrentMarkupTargetKeys(currentMarkupHints);
    const overrides: Array<readonly [string, TMarkupSubtype]> = [];
    for (const [
        id,
        subtype,
    ] of opts.markupSubtypeOverrides?.entries() ?? []) {
        if (
            id.trim().length > 0
            && isNativeMarkupSubtype(subtype)
            && hasCurrentMarkupTargetKey(currentMarkupTargetKeys, id)
        ) {
            overrides.push([
                id.trim(),
                subtype,
            ]);
        }
    }
    const liveHints = opts.markupSubtypeHints
        .filter(hint => isCurrentMarkupHint(hint, currentMarkupTargetKeys))
        .flatMap((hint) => {
            const nativeHint = toNativeMarkupHint(hint);
            return nativeHint ? [nativeHint] : [];
        });
    const editedCommentHints = currentMarkupHints
        // Full rewrites need all preservation hints; incremental native markup should touch
        // only hints that represent a user-visible markup edit.
        .filter(hint => hint.color !== null || hint.source === 'editor')
        .flatMap((hint) => {
            const nativeHint = toNativeMarkupHint(hint);
            return nativeHint ? [nativeHint] : [];
        });
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
