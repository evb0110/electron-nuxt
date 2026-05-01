import type { Ref } from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { isTextMarkupSubtype } from '@app/composables/pdf/pdfAnnotationUtils';
import {
    normalizeMarkerRect,
    markerRectIoU,
} from '@app/composables/pdf/annotationGeometry';
import { annotationCommentsMatch } from '@app/composables/pdf/annotationCommentMatching';

interface ISummaryMemoryEntry {
    text: string;
    modifiedAt: number | null;
    author: string | null;
    kindLabel: string | null;
    subtype: string | null;
    color: string | null;
    markerRect: IAnnotationMarkerRect | null;
}

export function computeSummaryStableKey(params: {
    pageIndex: number;
    id: string;
    source: IAnnotationCommentSummary['source'];
    uid?: string | null;
    annotationId?: string | null;
}) {
    if (params.annotationId) {
        return `ann:${params.pageIndex}:${params.annotationId}`;
    }
    if (params.uid) {
        return `uid:${params.pageIndex}:${params.uid}`;
    }
    return `src:${params.source}:${params.pageIndex}:${params.id}`;
}

export function toCanonicalStableKey(
    summary: Pick<IAnnotationCommentSummary, 'id' | 'pageIndex' | 'source' | 'uid' | 'annotationId'>,
) {
    return computeSummaryStableKey({
        id: summary.id,
        pageIndex: summary.pageIndex,
        source: summary.source,
        uid: summary.uid,
        annotationId: summary.annotationId,
    });
}

export function normalizeSummaryStableKey(
    summary: IAnnotationCommentSummary,
): IAnnotationCommentSummary {
    return {
        ...summary,
        stableKey: toCanonicalStableKey(summary),
    };
}

export function getSummaryMemoryKeys(
    summary: Pick<IAnnotationCommentSummary, 'stableKey' | 'pageIndex' | 'annotationId' | 'uid' | 'id'>,
) {
    const keys = new Set<string>();
    if (summary.stableKey) {
        keys.add(`stable:${summary.stableKey}`);
    }
    if (summary.annotationId) {
        keys.add(`ann:${summary.pageIndex}:${summary.annotationId}`);
        keys.add(`ann:any:${summary.annotationId}`);
    }
    if (summary.uid) {
        keys.add(`uid:${summary.pageIndex}:${summary.uid}`);
        keys.add(`uid:any:${summary.uid}`);
    }
    if (summary.id) {
        keys.add(`id:${summary.pageIndex}:${summary.id}`);
        keys.add(`id:any:${summary.id}`);
    }
    return Array.from(keys);
}

function isTextLikeNoteSubtype(subtype: IAnnotationCommentSummary['subtype']) {
    const normalized = (subtype ?? '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }
    return (
        normalized.includes('text')
        || normalized.includes('popup')
        || normalized.includes('note')
        || isTextMarkupSubtype(subtype)
    );
}

function intervalOverlap(
    leftStart: number,
    leftEnd: number,
    rightStart: number,
    rightEnd: number,
) {
    return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
}

function rectContainsPoint(
    rect: {
        left: number;
        top: number;
        width: number;
        height: number 
    },
    x: number,
    y: number,
) {
    return (
        x >= rect.left
        && x <= rect.left + rect.width
        && y >= rect.top
        && y <= rect.top + rect.height
    );
}

function markerRectLineMirrorSignal(
    left: IAnnotationCommentSummary['markerRect'],
    right: IAnnotationCommentSummary['markerRect'],
) {
    const normalizedLeft = normalizeMarkerRect(left);
    const normalizedRight = normalizeMarkerRect(right);
    if (!normalizedLeft || !normalizedRight) {
        return false;
    }

    const minHeight = Math.max(1e-6, Math.min(normalizedLeft.height, normalizedRight.height));
    const minWidth = Math.max(1e-6, Math.min(normalizedLeft.width, normalizedRight.width));
    const maxWidth = Math.max(normalizedLeft.width, normalizedRight.width);
    const widthRatio = maxWidth / minWidth;

    const yOverlap = intervalOverlap(
        normalizedLeft.top,
        normalizedLeft.top + normalizedLeft.height,
        normalizedRight.top,
        normalizedRight.top + normalizedRight.height,
    ) / minHeight;
    const xOverlap = intervalOverlap(
        normalizedLeft.left,
        normalizedLeft.left + normalizedLeft.width,
        normalizedRight.left,
        normalizedRight.left + normalizedRight.width,
    ) / minWidth;

    const leftCenterX = normalizedLeft.left + normalizedLeft.width / 2;
    const leftCenterY = normalizedLeft.top + normalizedLeft.height / 2;
    const rightCenterX = normalizedRight.left + normalizedRight.width / 2;
    const rightCenterY = normalizedRight.top + normalizedRight.height / 2;
    const centerContainment = rectContainsPoint(normalizedLeft, rightCenterX, rightCenterY)
        || rectContainsPoint(normalizedRight, leftCenterX, leftCenterY);

    return (
        yOverlap >= 0.72
        && (
            centerContainment
            || xOverlap >= 0.18
            || (widthRatio >= 3.2 && xOverlap >= 0.08)
        )
    );
}

function markerRectCenterDistanceLocal(
    left: IAnnotationCommentSummary['markerRect'],
    right: IAnnotationCommentSummary['markerRect'],
) {
    const normalizedLeft = normalizeMarkerRect(left);
    const normalizedRight = normalizeMarkerRect(right);
    if (!normalizedLeft || !normalizedRight) {
        return Number.POSITIVE_INFINITY;
    }
    const leftCx = normalizedLeft.left + normalizedLeft.width / 2;
    const leftCy = normalizedLeft.top + normalizedLeft.height / 2;
    const rightCx = normalizedRight.left + normalizedRight.width / 2;
    const rightCy = normalizedRight.top + normalizedRight.height / 2;
    return Math.hypot(leftCx - rightCx, leftCy - rightCy);
}

export function likelyEditorPdfMirror(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    if (left.pageIndex !== right.pageIndex) {
        return false;
    }
    if (left.source === right.source) {
        return false;
    }
    if (!(left.hasNote && right.hasNote)) {
        return false;
    }

    const leftText = left.text.trim();
    const rightText = right.text.trim();
    const hasLeftText = leftText.length > 0;
    const hasRightText = rightText.length > 0;
    if (hasLeftText && hasRightText && leftText !== rightText) {
        return false;
    }

    if (!isTextLikeNoteSubtype(left.subtype) || !isTextLikeNoteSubtype(right.subtype)) {
        return false;
    }

    if (left.annotationId && right.annotationId && left.annotationId === right.annotationId) {
        return true;
    }
    if (left.uid && right.uid && left.uid === right.uid) {
        return true;
    }

    const hasLeftStableRef = Boolean(left.annotationId || left.uid);
    const hasRightStableRef = Boolean(right.annotationId || right.uid);
    const stableRefCount = Number(hasLeftStableRef) + Number(hasRightStableRef);
    if (stableRefCount === 0) {
        return false;
    }

    const iou = markerRectIoU(left.markerRect, right.markerRect);
    const centerDistance = markerRectCenterDistanceLocal(left.markerRect, right.markerRect);
    const lineMirror = markerRectLineMirrorSignal(left.markerRect, right.markerRect);
    const leftTs = left.modifiedAt ?? 0;
    const rightTs = right.modifiedAt ?? 0;
    const modifiedClose = Boolean(leftTs && rightTs && Math.abs(leftTs - rightTs) <= 3_000);

    if (hasLeftStableRef && hasRightStableRef) {
        if (hasLeftText && hasRightText) {
            return lineMirror || iou >= 0.18 || centerDistance <= 0.08 || modifiedClose;
        }
        return modifiedClose && (iou >= 0.28 || centerDistance <= 0.04);
    }

    const strongGeometry = (
        iou >= 0.45
        || centerDistance <= 0.028
        || (lineMirror && centerDistance <= 0.038)
    );
    if (!strongGeometry) {
        return false;
    }

    if (hasLeftText && hasRightText) {
        if (leftText !== rightText) {
            return false;
        }
        return modifiedClose || iou >= 0.62 || centerDistance <= 0.018;
    }

    return modifiedClose || iou >= 0.62 || centerDistance <= 0.018;
}

export function areTextMarkupCommentsLikelySame(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    if (left.pageIndex !== right.pageIndex) {
        return false;
    }
    if (!isTextMarkupSubtype(left.subtype) || !isTextMarkupSubtype(right.subtype)) {
        return false;
    }

    const iou = markerRectIoU(left.markerRect, right.markerRect);
    if (iou >= 0.46) {
        return true;
    }

    const leftRect = normalizeMarkerRect(left.markerRect);
    const rightRect = normalizeMarkerRect(right.markerRect);
    if (!leftRect || !rightRect) {
        return false;
    }

    const leftCenterX = leftRect.left + leftRect.width / 2;
    const leftCenterY = leftRect.top + leftRect.height / 2;
    const rightCenterX = rightRect.left + rightRect.width / 2;
    const rightCenterY = rightRect.top + rightRect.height / 2;
    const dx = leftCenterX - rightCenterX;
    const dy = leftCenterY - rightCenterY;
    const centerDistance = Math.hypot(dx, dy);

    const leftArea = leftRect.width * leftRect.height;
    const rightArea = rightRect.width * rightRect.height;
    const largerArea = Math.max(leftArea, rightArea);
    const smallerArea = Math.max(1e-6, Math.min(leftArea, rightArea));
    const areaRatio = largerArea / smallerArea;

    return centerDistance <= 0.045 && areaRatio <= 2.8;
}

export function commentsAreSameLogicalAnnotation(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    if (left.pageIndex !== right.pageIndex) {
        return false;
    }

    if (left.annotationId && right.annotationId) {
        return left.annotationId === right.annotationId;
    }

    if (left.uid && right.uid) {
        return left.uid === right.uid;
    }

    if (left.id === right.id && left.source === right.source) {
        return true;
    }

    if (likelyEditorPdfMirror(left, right)) {
        return true;
    }

    if (
        !left.hasNote
        && !right.hasNote
        && areTextMarkupCommentsLikelySame(left, right)
    ) {
        return true;
    }

    return false;
}

export function commentMergePriority(comment: IAnnotationCommentSummary) {
    let score = 0;
    if (comment.annotationId) {
        score += 110;
    }
    if (comment.uid) {
        score += 55;
    }
    if (comment.source === 'editor') {
        score += 22;
    }
    if (comment.text.trim()) {
        score += 12;
    }
    if (comment.hasNote) {
        score += 8;
    }
    if (comment.modifiedAt) {
        score += 5;
    }
    if (comment.markerRect) {
        score += 3;
    }
    return score;
}

function markerRectConfidenceScore(
    comment: Pick<IAnnotationCommentSummary, 'source' | 'modifiedAt'>,
    rect: {
        width: number;
        height: number 
    },
) {
    let score = 0;
    if (comment.source === 'editor') {
        score += 4;
    }
    if (typeof comment.modifiedAt === 'number' && comment.modifiedAt > 0) {
        score += 2;
    }
    if (rect.width * rect.height > 0.00001) {
        score += 1;
    }
    return score;
}

function pickPreferredMarkerRect(
    left: Pick<IAnnotationCommentSummary, 'markerRect' | 'source' | 'modifiedAt'>,
    right: Pick<IAnnotationCommentSummary, 'markerRect' | 'source' | 'modifiedAt'>,
) {
    const leftRect = normalizeMarkerRect(left.markerRect);
    const rightRect = normalizeMarkerRect(right.markerRect);
    if (!leftRect) {
        return rightRect ?? null;
    }
    if (!rightRect) {
        return leftRect;
    }

    const leftScore = markerRectConfidenceScore(left, leftRect);
    const rightScore = markerRectConfidenceScore(right, rightRect);
    if (leftScore !== rightScore) {
        return rightScore > leftScore ? rightRect : leftRect;
    }

    const leftTs = left.modifiedAt ?? 0;
    const rightTs = right.modifiedAt ?? 0;
    if (leftTs !== rightTs) {
        return rightTs > leftTs ? rightRect : leftRect;
    }

    if (left.source !== right.source) {
        return right.source === 'editor' ? rightRect : leftRect;
    }

    const leftArea = leftRect.width * leftRect.height;
    const rightArea = rightRect.width * rightRect.height;
    return rightArea > leftArea ? rightRect : leftRect;
}

export function mergeCommentSummaries(
    existing: IAnnotationCommentSummary,
    incoming: IAnnotationCommentSummary,
): IAnnotationCommentSummary {
    const existingText = existing.text.trim();
    const text = existingText.length > 0 ? existing.text : incoming.text;

    const author = existing.author?.trim() ? existing.author : incoming.author;

    const kindLabel = (() => {
        if (existing.kindLabel?.trim() && existing.subtype !== 'Highlight') {
            return existing.kindLabel;
        }
        if (incoming.kindLabel?.trim() && incoming.subtype !== 'Highlight') {
            return incoming.kindLabel;
        }
        return existing.kindLabel?.trim() ? existing.kindLabel : incoming.kindLabel;
    })();

    const modifiedAt = (() => {
        const existingTs = existing.modifiedAt ?? null;
        const incomingTs = incoming.modifiedAt ?? null;
        if (existingTs && incomingTs) {
            return Math.max(existingTs, incomingTs);
        }
        return existingTs ?? incomingTs;
    })();

    const source = existing.source === 'editor' ? 'editor' : incoming.source;
    const existingSortIndex = typeof existing.sortIndex === 'number' ? existing.sortIndex : null;
    const incomingSortIndex = typeof incoming.sortIndex === 'number' ? incoming.sortIndex : null;
    const sortIndex = (
        existingSortIndex !== null && incomingSortIndex !== null
            ? Math.min(existingSortIndex, incomingSortIndex)
            : (existingSortIndex ?? incomingSortIndex)
    );
    const hasNote = Boolean(existing.hasNote || incoming.hasNote);
    const subtype = (() => {
        const existingSubtype = existing.subtype ?? null;
        const incomingSubtype = incoming.subtype ?? null;
        if (existingSubtype && existingSubtype !== 'Highlight') {
            return existingSubtype;
        }
        if (incomingSubtype && incomingSubtype !== 'Highlight') {
            return incomingSubtype;
        }
        return existingSubtype ?? incomingSubtype;
    })();

    return {
        ...existing,
        text,
        author,
        kindLabel,
        modifiedAt,
        sortIndex,
        annotationId: existing.annotationId ?? incoming.annotationId,
        uid: existing.uid ?? incoming.uid,
        subtype,
        color: existing.color ?? incoming.color,
        source,
        hasNote,
        markerRect: pickPreferredMarkerRect(existing, incoming),
    };
}

export function mergeDuplicateCommentSummary(
    primary: IAnnotationCommentSummary,
    secondary: IAnnotationCommentSummary,
): IAnnotationCommentSummary {
    const merged = mergeCommentSummaries(primary, secondary);
    const annotationId = primary.annotationId ?? secondary.annotationId ?? null;
    const uid = primary.uid ?? secondary.uid ?? null;
    const markerRect = pickPreferredMarkerRect(primary, secondary);
    const source: IAnnotationCommentSummary['source'] = (
        primary.source === 'editor' || secondary.source === 'editor'
            ? 'editor'
            : 'pdf'
    );
    const primarySortIndex = typeof primary.sortIndex === 'number' ? primary.sortIndex : null;
    const secondarySortIndex = typeof secondary.sortIndex === 'number' ? secondary.sortIndex : null;
    const sortIndex = (
        primarySortIndex !== null && secondarySortIndex !== null
            ? Math.min(primarySortIndex, secondarySortIndex)
            : (primarySortIndex ?? secondarySortIndex)
    );

    const id = annotationId
        ? (primary.annotationId ? primary.id : secondary.id)
        : (uid
            ? (primary.uid ? primary.id : secondary.id)
            : merged.id);

    const normalized: IAnnotationCommentSummary = {
        ...merged,
        id,
        sortIndex,
        annotationId,
        uid,
        source,
        markerRect,
    };
    return normalizeSummaryStableKey(normalized);
}

export function dedupeAnnotationCommentSummaries(comments: IAnnotationCommentSummary[]) {
    const sorted = comments
        .map(comment => normalizeSummaryStableKey(comment))
        .sort((left, right) => {
            const priorityDelta = commentMergePriority(right) - commentMergePriority(left);
            if (priorityDelta !== 0) {
                return priorityDelta;
            }
            const leftTs = left.modifiedAt ?? 0;
            const rightTs = right.modifiedAt ?? 0;
            if (leftTs !== rightTs) {
                return rightTs - leftTs;
            }
            return left.stableKey.localeCompare(right.stableKey);
        });

    const merged: IAnnotationCommentSummary[] = [];
    for (const candidate of sorted) {
        const existingIndex = merged.findIndex(existing => commentsAreSameLogicalAnnotation(existing, candidate));
        if (existingIndex === -1) {
            merged.push(candidate);
            continue;
        }
        const primary = merged[existingIndex];
        if (!primary) {
            merged.push(candidate);
            continue;
        }
        merged[existingIndex] = mergeDuplicateCommentSummary(primary, candidate);
    }

    return merged.sort((a, b) => {
        if (a.pageIndex !== b.pageIndex) {
            return a.pageIndex - b.pageIndex;
        }
        const aSort = typeof a.sortIndex === 'number' ? a.sortIndex : null;
        const bSort = typeof b.sortIndex === 'number' ? b.sortIndex : null;
        if (aSort !== null && bSort !== null && aSort !== bSort) {
            return aSort - bSort;
        }
        if (aSort !== null && bSort === null) {
            return -1;
        }
        if (aSort === null && bSort !== null) {
            return 1;
        }
        const aTime = a.modifiedAt ?? 0;
        const bTime = b.modifiedAt ?? 0;
        if (aTime !== bTime) {
            return bTime - aTime;
        }
        return a.stableKey.localeCompare(b.stableKey);
    });
}

export function commentsMatchForEditorLookup(
    left: Pick<IAnnotationCommentSummary, 'stableKey' | 'annotationId' | 'uid' | 'id' | 'pageIndex' | 'source'>,
    right: Pick<IAnnotationCommentSummary, 'stableKey' | 'annotationId' | 'uid' | 'id' | 'pageIndex' | 'source'>,
) {
    return annotationCommentsMatch(left, right);
}

export function useAnnotationIdentity(
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>,
) {
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
        if (!text) {
            getSummaryMemoryKeys(summary).forEach((key) => {
                commentSummaryMemory.delete(key);
            });
            return;
        }
        const payload: ISummaryMemoryEntry = {
            text: summary.text,
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
        if (summary.text.trim()) {
            return summary;
        }
        if (summary.hasNote) {
            return summary;
        }

        for (const key of getSummaryMemoryKeys(summary)) {
            const cached = commentSummaryMemory.get(key);
            if (!cached || !cached.text.trim()) {
                continue;
            }
            return {
                ...summary,
                text: cached.text,
                modifiedAt: summary.modifiedAt ?? cached.modifiedAt,
                author: summary.author ?? cached.author,
                kindLabel: summary.kindLabel ?? cached.kindLabel,
                subtype: summary.subtype ?? cached.subtype,
                color: summary.color ?? cached.color,
                markerRect: summary.markerRect ?? cached.markerRect,
            };
        }

        return summary;
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
        compareAnnotationComments: (a: IAnnotationCommentSummary, b: IAnnotationCommentSummary) => {
            if (a.pageIndex !== b.pageIndex) {
                return a.pageIndex - b.pageIndex;
            }
            const sortIndexA = typeof a.sortIndex === 'number' ? a.sortIndex : null;
            const sortIndexB = typeof b.sortIndex === 'number' ? b.sortIndex : null;
            if (sortIndexA !== null && sortIndexB !== null && sortIndexA !== sortIndexB) {
                return sortIndexA - sortIndexB;
            }
            if (sortIndexA !== null && sortIndexB === null) {
                return -1;
            }
            if (sortIndexA === null && sortIndexB !== null) {
                return 1;
            }
            const aTime = a.modifiedAt ?? 0;
            const bTime = b.modifiedAt ?? 0;
            if (aTime !== bTime) {
                return bTime - aTime;
            }
            return a.stableKey.localeCompare(b.stableKey);
        },
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
}
