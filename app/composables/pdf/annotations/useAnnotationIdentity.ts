import type { Ref } from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { areTextMarkupCommentsLikelySame } from '@app/utils/pdf-viewer/annotations/annotation-identity-matching/areTextMarkupCommentsLikelySame';
import { commentMergePriority } from '@app/utils/pdf-viewer/annotations/annotation-identity-matching/commentMergePriority';
import { commentsAreSameLogicalAnnotation } from '@app/utils/pdf-viewer/annotations/annotation-identity-matching/commentsAreSameLogicalAnnotation';
import { commentsMatchForEditorLookup } from '@app/utils/pdf-viewer/annotations/annotation-identity-matching/commentsMatchForEditorLookup';
import { compareAnnotationComments } from '@app/utils/pdf-viewer/annotations/annotation-identity-matching/compareAnnotationComments';
import { computeSummaryStableKey } from '@app/utils/pdf-viewer/annotations/annotation-identity-matching/computeSummaryStableKey';
import { dedupeAnnotationCommentSummaries } from '@app/utils/pdf-viewer/annotations/annotation-identity-matching/dedupeAnnotationCommentSummaries';
import { getSummaryMemoryKeys } from '@app/utils/pdf-viewer/annotations/annotation-identity-matching/getSummaryMemoryKeys';
import { mergeCommentSummaries } from '@app/utils/pdf-viewer/annotations/annotation-identity-matching/mergeCommentSummaries';
import { mergeDuplicateCommentSummary } from '@app/utils/pdf-viewer/annotations/annotation-identity-matching/mergeDuplicateCommentSummary';
import { normalizeSummaryStableKey } from '@app/utils/pdf-viewer/annotations/annotation-identity-matching/normalizeSummaryStableKey';
import { toCanonicalStableKey } from '@app/utils/pdf-viewer/annotations/annotation-identity-matching/toCanonicalStableKey';

interface ISummaryMemoryEntry {
    text: string;
    displayText: string | null;
    previewText: string | null;
    pageIndex: number;
    createdAt: number | null;
    modifiedAt: number | null;
    author: string | null;
    kindLabel: string | null;
    subtype: string | null;
    color: string | null;
    markerRect: IAnnotationMarkerRect | null;
}

function shouldHydrateSummaryFromMemory(summary: IAnnotationCommentSummary) {
    return !summary.text.trim() && !summary.hasNote;
}

function getSelectedMarkupPreviewText(summary: IAnnotationCommentSummary) {
    if (!isTextMarkupSubtype(summary.subtype)) {
        return '';
    }
    return summary.displayText?.trim()
        || summary.previewText?.trim()
        || '';
}

function getSelectedMarkupPreviewTextFromMemory(entry: ISummaryMemoryEntry) {
    if (!isTextMarkupSubtype(entry.subtype)) {
        return '';
    }
    return entry.displayText?.trim()
        || entry.previewText?.trim()
        || '';
}

function normalizePreviewForMatching(text: string) {
    return text.replace(/\s+/gu, ' ').trim().toLowerCase();
}

function rectAxisOverlap(
    leftStart: number,
    leftSize: number,
    rightStart: number,
    rightSize: number,
) {
    return Math.max(0, Math.min(leftStart + leftSize, rightStart + rightSize) - Math.max(leftStart, rightStart));
}

function markerRectsShareTextLine(
    left: IAnnotationMarkerRect | null,
    right: IAnnotationMarkerRect | null | undefined,
) {
    if (!left || !right) {
        return false;
    }

    const verticalOverlap = rectAxisOverlap(left.top, left.height, right.top, right.height);
    const minHeight = Math.min(left.height, right.height);
    if (minHeight <= 0 || verticalOverlap / minHeight < 0.45) {
        return false;
    }

    return rectAxisOverlap(left.left, left.width, right.left, right.width) > 0;
}

function toMemorySummary(entry: ISummaryMemoryEntry): IAnnotationCommentSummary {
    return {
        id: 'memory',
        stableKey: 'memory',
        pageIndex: entry.pageIndex,
        pageNumber: entry.pageIndex + 1,
        text: entry.text,
        displayText: entry.displayText,
        previewText: entry.previewText,
        kindLabel: entry.kindLabel,
        subtype: entry.subtype,
        author: entry.author,
        createdAt: entry.createdAt,
        modifiedAt: entry.modifiedAt,
        color: entry.color,
        uid: null,
        annotationId: null,
        source: 'editor',
        hasNote: Boolean(entry.text.trim()),
        markerRect: entry.markerRect,
    };
}

function memoryEntryMatchesTextMarkupSummary(
    entry: ISummaryMemoryEntry,
    summary: IAnnotationCommentSummary,
) {
    if (
        entry.pageIndex !== summary.pageIndex
        || !isTextMarkupSubtype(entry.subtype)
        || !isTextMarkupSubtype(summary.subtype)
        || (entry.subtype ?? '').toLowerCase() !== (summary.subtype ?? '').toLowerCase()
    ) {
        return false;
    }

    const cachedPreview = normalizePreviewForMatching(getSelectedMarkupPreviewTextFromMemory(entry));
    if (!cachedPreview) {
        return false;
    }

    const geometryMatches = markerRectsShareTextLine(entry.markerRect, summary.markerRect)
        || areTextMarkupCommentsLikelySame(toMemorySummary(entry), summary);
    if (geometryMatches) {
        return true;
    }

    const summaryPreview = normalizePreviewForMatching(getSelectedMarkupPreviewText(summary));
    const modifiedDelta = Math.abs((entry.modifiedAt ?? 0) - (summary.modifiedAt ?? 0));
    const modifiedClose = Boolean(entry.modifiedAt && summary.modifiedAt && modifiedDelta <= 15_000);
    return modifiedClose && Boolean(summaryPreview && summaryPreview.includes(cachedPreview));
}

function findTextMarkupMemoryEntry(
    summary: IAnnotationCommentSummary,
    commentSummaryMemory: Map<string, ISummaryMemoryEntry>,
) {
    if (!isTextMarkupSubtype(summary.subtype)) {
        return null;
    }

    const candidates = Array.from(commentSummaryMemory.values())
        .filter(entry => memoryEntryMatchesTextMarkupSummary(entry, summary));
    if (candidates.length === 0) {
        return null;
    }

    return candidates.sort((left, right) => {
        const leftModifiedDelta = Math.abs((left.modifiedAt ?? 0) - (summary.modifiedAt ?? 0));
        const rightModifiedDelta = Math.abs((right.modifiedAt ?? 0) - (summary.modifiedAt ?? 0));
        if (leftModifiedDelta !== rightModifiedDelta) {
            return leftModifiedDelta - rightModifiedDelta;
        }
        return getSelectedMarkupPreviewTextFromMemory(left).length
            - getSelectedMarkupPreviewTextFromMemory(right).length;
    })[0] ?? null;
}

function findSummaryMemoryEntry(
    summary: IAnnotationCommentSummary,
    commentSummaryMemory: Map<string, ISummaryMemoryEntry>,
) {
    for (const key of getSummaryMemoryKeys(summary)) {
        const cached = commentSummaryMemory.get(key);
        if (cached && (cached.text.trim() || getSelectedMarkupPreviewTextFromMemory(cached))) {
            return cached;
        }
    }
    return findTextMarkupMemoryEntry(summary, commentSummaryMemory);
}

function applySummaryMemory(
    summary: IAnnotationCommentSummary,
    cached: ISummaryMemoryEntry,
) {
    const selectedMarkupPreview = getSelectedMarkupPreviewTextFromMemory(cached);
    return {
        ...summary,
        text: cached.text.trim() ? cached.text : summary.text,
        displayText: summary.displayText ?? (selectedMarkupPreview || null),
        previewText: summary.previewText ?? cached.previewText,
        createdAt: summary.createdAt ?? cached.createdAt,
        modifiedAt: summary.modifiedAt ?? cached.modifiedAt,
        author: summary.author ?? cached.author,
        kindLabel: summary.kindLabel ?? cached.kindLabel,
        subtype: summary.subtype ?? cached.subtype,
        color: summary.color ?? cached.color,
        markerRect: summary.markerRect ?? cached.markerRect,
    };
}

export const useAnnotationIdentity = (
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>,
) => {
    const editorRuntimeIds = new WeakMap<IPdfjsEditor, string>();
    let editorRuntimeIdCounter = 0;
    let commentSummaryMemory = new Map<string, ISummaryMemoryEntry>();

    tryOnScopeDispose(() => {
        commentSummaryMemory.clear();
    });

    function getEditorRuntimeId(editor: IPdfjsEditor, pageIndex: number) {
        let runtimeId = editorRuntimeIds.get(editor);
        if (!runtimeId) {
            editorRuntimeIdCounter += 1;
            runtimeId = `runtime-${pageIndex}-${editorRuntimeIdCounter}`;
            editorRuntimeIds.set(editor, runtimeId);
        }
        return runtimeId;
    }

    function getEditorIdentity(editor: IPdfjsEditor, pageIndex: number) {
        const rawEditorId = typeof editor.id === 'string' || typeof editor.id === 'number'
            ? String(editor.id)
            : '';
        return editor.uid
            ?? editor.annotationElementId
            ?? (rawEditorId ? `editor:${pageIndex}:${rawEditorId}` : null)
            ?? getEditorRuntimeId(editor, pageIndex);
    }

    function getEditorPendingKey(editor: IPdfjsEditor, pageIndex: number) {
        return `p${pageIndex}:${getEditorIdentity(editor, pageIndex)}`;
    }

    function toSummaryKey(summary: IAnnotationCommentSummary) {
        return summary.stableKey;
    }

    function rememberSummaryText(summary: IAnnotationCommentSummary) {
        const text = summary.text.trim();
        const selectedMarkupPreview = getSelectedMarkupPreviewText(summary);
        if (!text && !selectedMarkupPreview) {
            getSummaryMemoryKeys(summary).forEach((key) => {
                commentSummaryMemory.delete(key);
            });
            return;
        }
        const payload: ISummaryMemoryEntry = {
            text: summary.text,
            displayText: summary.displayText?.trim() || null,
            previewText: summary.previewText?.trim() || null,
            pageIndex: summary.pageIndex,
            createdAt: summary.createdAt ?? null,
            modifiedAt: summary.modifiedAt ?? null,
            author: summary.author ?? null,
            kindLabel: summary.kindLabel ?? null,
            subtype: summary.subtype ?? null,
            color: summary.color ?? null,
            markerRect: summary.markerRect ?? null,
        };
        getSummaryMemoryKeys(summary).forEach((key) => {
            commentSummaryMemory.set(key, payload);
        });
    }

    function forgetSummaryText(summary: IAnnotationCommentSummary) {
        getSummaryMemoryKeys(summary).forEach((key) => {
            commentSummaryMemory.delete(key);
        });
    }

    function hydrateSummaryFromMemory(summary: IAnnotationCommentSummary) {
        if (!shouldHydrateSummaryFromMemory(summary)) {
            return summary;
        }

        const cached = findSummaryMemoryEntry(summary, commentSummaryMemory);
        return cached ? applySummaryMemory(summary, cached) : summary;
    }

    function findCommentByStableKey(stableKey: string) {
        return annotationCommentsCache.value.find(comment => comment.stableKey === stableKey) ?? null;
    }

    function findCommentByAnnotationId(annotationId: string | null | undefined, pageNumber: number | null = null) {
        const normalized = (annotationId ?? '').trim();
        if (!normalized) {
            return null;
        }

        if (Number.isFinite(pageNumber)) {
            const byPage = annotationCommentsCache.value.find(comment => (
                comment.annotationId === normalized
                && comment.pageNumber === pageNumber
            ));
            if (byPage) {
                return byPage;
            }
        }

        return annotationCommentsCache.value.find(comment => comment.annotationId === normalized) ?? null;
    }

    function resolveCommentFromCache(comment: IAnnotationCommentSummary) {
        const direct = findCommentByStableKey(comment.stableKey);
        if (direct) {
            return direct;
        }
        return annotationCommentsCache.value.find(candidate => commentsMatchForEditorLookup(candidate, comment)) ?? null;
    }

    function clearMemory() {
        commentSummaryMemory = new Map();
    }

    return {
        getEditorRuntimeId,
        getEditorIdentity,
        getEditorPendingKey,
        computeSummaryStableKey,
        toCanonicalStableKey,
        normalizeSummaryStableKey,
        compareAnnotationComments,
        dedupeAnnotationCommentSummaries,
        commentMergePriority,
        mergeDuplicateCommentSummary,
        mergeCommentSummaries,
        commentsAreSameLogicalAnnotation,
        areTextMarkupCommentsLikelySame,
        toSummaryKey,
        rememberSummaryText,
        hydrateSummaryFromMemory,
        forgetSummaryText,
        getSummaryMemoryKeys,
        commentsMatchForEditorLookup,
        resolveCommentFromCache,
        findCommentByStableKey,
        findCommentByAnnotationId,
        clearMemory,
    };
};
