import type { Ref } from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import { annotationCommentsMatch } from '@app/modules/pdf-viewer/engine/annotations/annotation-identity/annotationCommentsMatch';
import { selectPreferredAnnotationComment } from '@app/modules/pdf-viewer/engine/annotations/annotation-identity/selectPreferredAnnotationComment';
import { isNoteEligibleComment } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isNoteEligibleComment';
import { markerRectCenterDistance } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/markerRectCenterDistance';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import { compareAnnotationCommentSummaries } from '@app/utils/pdfAnnotationComments';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {
    IPdfAnnotationCommentModel,
    IPendingAnnotationMarkerMove,
} from '@app/modules/pdf-viewer/annotations/pdfAnnotationCommentModel.types';

interface IUsePdfAnnotationCommentModelOptions {
    isAnySaving: Ref<boolean>;
    getShapeAnnotationCommentSummaries: () => IAnnotationCommentSummary[];
    emitAnnotationComments: (comments: IAnnotationCommentSummary[]) => void;
    shouldSuppressSidebarComment?: (comment: IAnnotationCommentSummary) => boolean;
    suppressAnnotationStableKey: (stableKey: string) => void;
    unsuppressAnnotationStableKey: (stableKey: string) => void;
    suppressAnnotationId: (annotationId: string) => void;
    unsuppressAnnotationId: (annotationId: string) => void;
}

const ANNOTATION_RELOAD_CACHE_GRACE_MS = 5_000;

function commentsShareTransientPlacement(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    return left.pageIndex === right.pageIndex
        && isNoteEligibleComment(left)
        && isNoteEligibleComment(right)
        && markerRectCenterDistance(left.markerRect, right.markerRect) < 0.01;
}

function isTransientEditorOnlyComment(comment: IAnnotationCommentSummary) {
    return comment.source === 'editor' && !comment.annotationId;
}

function normalizeAnnotationNoteText(comment: IAnnotationCommentSummary) {
    return comment.text.trim().replace(/[\u200B\uFEFF]/gu, '');
}

function getAnnotationDisplayText(comment: IAnnotationCommentSummary) {
    const displayText = comment.displayText?.trim();
    if (displayText) {
        return displayText;
    }
    const text = comment.text.trim();
    if (text) {
        return text;
    }
    return comment.previewText?.trim() ?? '';
}

function isTextMarkupComment(comment: IAnnotationCommentSummary) {
    return isTextMarkupSubtype(comment.subtype);
}

function toPdfTextMarkupSubtype(comment: IAnnotationCommentSummary): TMarkupSubtype | null {
    const subtype = (comment.subtype ?? '').trim().toLowerCase();
    if (subtype === 'highlight') {
        return 'Highlight';
    }
    if (subtype === 'underline') {
        return 'Underline';
    }
    if (subtype === 'strikeout' || subtype === 'strikethrough') {
        return 'StrikeOut';
    }
    if (subtype === 'squiggly') {
        return 'Squiggly';
    }
    return null;
}

function markerRectAxisOverlap(
    leftStart: number,
    leftSize: number,
    rightStart: number,
    rightSize: number,
) {
    return Math.max(0, Math.min(leftStart + leftSize, rightStart + rightSize) - Math.max(leftStart, rightStart));
}

function commentsShareTextMarkupLinePlacement(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    const leftRect = left.markerRect;
    const rightRect = right.markerRect;
    if (!leftRect || !rightRect) {
        return false;
    }

    const verticalOverlap = markerRectAxisOverlap(leftRect.top, leftRect.height, rightRect.top, rightRect.height);
    const minHeight = Math.min(leftRect.height, rightRect.height);
    if (minHeight <= 0 || verticalOverlap / minHeight < 0.45) {
        return false;
    }

    return markerRectAxisOverlap(leftRect.left, leftRect.width, rightRect.left, rightRect.width) > 0;
}

function commentsShareTextMarkupReloadPlacement(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    return left.pageIndex === right.pageIndex
        && isTextMarkupComment(left)
        && isTextMarkupComment(right)
        && (left.subtype ?? '').toLowerCase() === (right.subtype ?? '').toLowerCase()
        && (
            markerRectCenterDistance(left.markerRect, right.markerRect) < 0.02
            || commentsShareTextMarkupLinePlacement(left, right)
        );
}

function withReloadStableDisplayText(
    comment: IAnnotationCommentSummary,
    previous: IAnnotationCommentSummary | null | undefined,
) {
    const displayText = previous ? getAnnotationDisplayText(previous) : '';
    if (!displayText) {
        return comment;
    }
    return {
        ...comment,
        displayText,
    };
}

function withReloadStableCreatedAt(
    comment: IAnnotationCommentSummary,
    previous: IAnnotationCommentSummary | null | undefined,
) {
    if (comment.createdAt || !previous?.createdAt) {
        return comment;
    }
    return {
        ...comment,
        createdAt: previous.createdAt,
    };
}

function withReloadStableTextMarkupColor(
    comment: IAnnotationCommentSummary,
    previous: IAnnotationCommentSummary | null | undefined,
) {
    if (
        !previous?.colorEdited
        || !isTextMarkupComment(comment)
        || !isTextMarkupComment(previous)
        || !previous.color
    ) {
        return comment;
    }
    return {
        ...comment,
        color: previous.color,
        colorEdited: true,
    };
}

function withReloadStableSummaryFields(
    comment: IAnnotationCommentSummary,
    previous: IAnnotationCommentSummary | null | undefined,
) {
    return withReloadStableTextMarkupColor(
        withReloadStableCreatedAt(withReloadStableDisplayText(comment, previous), previous),
        previous,
    );
}

function commentsShareNonEmptyNoteText(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
) {
    const leftText = normalizeAnnotationNoteText(left);
    const rightText = normalizeAnnotationNoteText(right);
    return leftText.length > 0 && leftText === rightText;
}

function markerMoveTouchesComment(
    move: IPendingAnnotationMarkerMove | null,
    comment: IAnnotationCommentSummary,
) {
    if (!move) {
        return false;
    }
    return markerRectCenterDistance(move.markerRect, comment.markerRect) < 0.015
        || markerRectCenterDistance(move.previousMarkerRect, comment.markerRect) < 0.015;
}

function cloneAnnotationCommentSnapshot(comment: IAnnotationCommentSummary): IAnnotationCommentSummary {
    return {
        ...comment,
        markerRect: comment.markerRect ? { ...comment.markerRect } : comment.markerRect,
    };
}

export const usePdfAnnotationCommentModel = (options: IUsePdfAnnotationCommentModelOptions): IPdfAnnotationCommentModel => {
    const annotationCommentsCache = shallowRef<IAnnotationCommentSummary[]>([]);
    const activeCommentStableKey = ref<string | null>(null);
    const pendingMarkerMoves = new Map<string, IPendingAnnotationMarkerMove>();
    const locallyDeletedAnnotationComments: IAnnotationCommentSummary[] = [];
    let annotationReloadCacheGraceUntil = 0;
    let annotationReloadTimer: ReturnType<typeof setTimeout> | null = null;
    let annotationReloadGeneration = 0;

    function clearAnnotationReloadTimer() {
        if (annotationReloadTimer === null) {
            return;
        }
        clearTimeout(annotationReloadTimer);
        annotationReloadTimer = null;
    }

    function isAnnotationReloadCacheGraceActive() {
        return options.isAnySaving.value || Date.now() <= annotationReloadCacheGraceUntil;
    }

    function getPendingMarkerMove(comment: IAnnotationCommentSummary) {
        return pendingMarkerMoves.get(comment.stableKey) ?? null;
    }

    function commentsShareTransientTransitionIdentity(
        left: IAnnotationCommentSummary,
        right: IAnnotationCommentSummary,
    ) {
        if (
            left.pageIndex !== right.pageIndex
            || !isNoteEligibleComment(left)
            || !isNoteEligibleComment(right)
            || isTransientEditorOnlyComment(left) === isTransientEditorOnlyComment(right)
        ) {
            return false;
        }

        if (commentsShareNonEmptyNoteText(left, right)) {
            return true;
        }

        const leftMove = getPendingMarkerMove(left);
        const rightMove = getPendingMarkerMove(right);
        return markerMoveTouchesComment(leftMove, right)
            || markerMoveTouchesComment(rightMove, left);
    }

    function commentsShareActiveTransientTransitionIdentity(
        left: IAnnotationCommentSummary,
        right: IAnnotationCommentSummary,
    ) {
        return commentsShareTransientTransitionIdentity(left, right)
            && (
                isAnnotationReloadCacheGraceActive()
                || Boolean(getPendingMarkerMove(left))
                || Boolean(getPendingMarkerMove(right))
            );
    }

    function findPreviousReloadDisplayTextComment(
        comment: IAnnotationCommentSummary,
        previousComments: IAnnotationCommentSummary[],
    ) {
        if (!isAnnotationReloadCacheGraceActive() || !isTextMarkupComment(comment)) {
            return null;
        }

        const candidates = previousComments.filter(previous =>
            isTextMarkupComment(previous)
            && getAnnotationDisplayText(previous).length > 0
            && (
                annotationCommentsMatch(previous, comment)
                || commentsShareTextMarkupReloadPlacement(previous, comment)
            ),
        );
        if (candidates.length === 0) {
            return null;
        }
        if (candidates.length === 1) {
            return candidates[0]!;
        }
        return [...candidates].sort((left, right) =>
            markerRectCenterDistance(left.markerRect, comment.markerRect)
            - markerRectCenterDistance(right.markerRect, comment.markerRect),
        )[0] ?? null;
    }

    function findPreviousTransientTransitionComment(
        comment: IAnnotationCommentSummary,
        previousComments: IAnnotationCommentSummary[],
    ) {
        if (!isAnnotationReloadCacheGraceActive() || !isNoteEligibleComment(comment)) {
            return null;
        }

        const candidates = previousComments.filter(previous =>
            isTransientEditorOnlyComment(previous)
            && commentsShareTransientTransitionIdentity(previous, comment),
        );
        if (candidates.length === 0) {
            return null;
        }
        if (candidates.length === 1) {
            return candidates[0]!;
        }

        const ordered = [...candidates].sort((left, right) => {
            const leftMove = getPendingMarkerMove(left);
            const rightMove = getPendingMarkerMove(right);
            const leftDistance = markerRectCenterDistance(
                leftMove?.markerRect ?? left.markerRect,
                comment.markerRect,
            );
            const rightDistance = markerRectCenterDistance(
                rightMove?.markerRect ?? right.markerRect,
                comment.markerRect,
            );
            return leftDistance - rightDistance;
        });

        const best = ordered[0] ?? null;
        const secondBest = ordered[1] ?? null;
        if (!best || !secondBest) {
            return best;
        }

        const bestDistance = markerRectCenterDistance(
            getPendingMarkerMove(best)?.markerRect ?? best.markerRect,
            comment.markerRect,
        );
        const secondBestDistance = markerRectCenterDistance(
            getPendingMarkerMove(secondBest)?.markerRect ?? secondBest.markerRect,
            comment.markerRect,
        );
        return secondBestDistance - bestDistance > 0.02 ? best : null;
    }

    function clearLocalDeletionForNewTransientComment(comment: IAnnotationCommentSummary) {
        if (!isTransientEditorOnlyComment(comment)) {
            return;
        }
        for (let index = locallyDeletedAnnotationComments.length - 1; index >= 0; index -= 1) {
            const deleted = locallyDeletedAnnotationComments[index];
            if (!deleted || !commentsShareTransientPlacement(deleted, comment)) {
                continue;
            }
            locallyDeletedAnnotationComments.splice(index, 1);
        }
    }

    function localDeletionMatchesComment(
        deleted: IAnnotationCommentSummary,
        comment: IAnnotationCommentSummary,
    ) {
        if (isTransientEditorOnlyComment(deleted) || isTransientEditorOnlyComment(comment)) {
            return commentsShareTransientPlacement(deleted, comment)
                || commentsShareActiveTransientTransitionIdentity(deleted, comment);
        }
        return annotationCommentsMatch(deleted, comment) || commentsShareTransientPlacement(deleted, comment);
    }

    function clearLocalDeletionForAnnotationComment(comment: IAnnotationCommentSummary) {
        for (let index = locallyDeletedAnnotationComments.length - 1; index >= 0; index -= 1) {
            const deleted = locallyDeletedAnnotationComments[index];
            if (deleted && localDeletionMatchesComment(deleted, comment)) {
                locallyDeletedAnnotationComments.splice(index, 1);
            }
        }
    }

    function isLocallyDeletedAnnotationComment(comment: IAnnotationCommentSummary) {
        return locallyDeletedAnnotationComments.some(deleted => localDeletionMatchesComment(deleted, comment));
    }

    function commentsRepresentSameVisibleNote(
        left: IAnnotationCommentSummary,
        right: IAnnotationCommentSummary,
    ) {
        if (annotationCommentsMatch(left, right)) {
            return true;
        }
        if (!(isTransientEditorOnlyComment(left) || isTransientEditorOnlyComment(right))) {
            return false;
        }
        return commentsShareTransientPlacement(left, right)
            || commentsShareActiveTransientTransitionIdentity(left, right);
    }

    function selectPreferredVisibleComment(
        left: IAnnotationCommentSummary,
        right: IAnnotationCommentSummary,
    ) {
        if (
            (
                commentsShareTransientPlacement(left, right)
                || commentsShareActiveTransientTransitionIdentity(left, right)
            )
            && isTransientEditorOnlyComment(left) !== isTransientEditorOnlyComment(right)
        ) {
            return isTransientEditorOnlyComment(left) ? right : left;
        }
        return selectPreferredAnnotationComment(left, right);
    }

    function shouldSuppressEmptyPdfNoteDuringTransientEdit(
        comment: IAnnotationCommentSummary,
        comments: IAnnotationCommentSummary[],
    ) {
        if (
            comment.source !== 'pdf'
            || normalizeAnnotationNoteText(comment).length > 0
            || !isNoteEligibleComment(comment)
        ) {
            return false;
        }

        return comments.some(candidate =>
            candidate.pageIndex === comment.pageIndex
            && isTransientEditorOnlyComment(candidate)
            && isNoteEligibleComment(candidate),
        );
    }

    function normalizeAnnotationComments(
        comments: IAnnotationCommentSummary[],
        normalizeOptions: { dropTransientEditorOnly?: boolean } = {},
    ) {
        const normalized: IAnnotationCommentSummary[] = [];
        for (const comment of comments) {
            if (
                isLocallyDeletedAnnotationComment(comment)
                || (normalizeOptions.dropTransientEditorOnly === true && isTransientEditorOnlyComment(comment))
                || shouldSuppressEmptyPdfNoteDuringTransientEdit(comment, comments)
            ) {
                continue;
            }

            const existingIndex = normalized.findIndex(candidate => commentsRepresentSameVisibleNote(candidate, comment));
            if (existingIndex === -1) {
                normalized.push(comment);
                continue;
            }

            normalized[existingIndex] = selectPreferredVisibleComment(normalized[existingIndex]!, comment);
        }
        return normalized;
    }

    function emitCommentsForSidebar(
        comments: IAnnotationCommentSummary[],
        emitOptions: { includeShapes?: boolean } = {},
    ) {
        const { includeShapes = true } = emitOptions;
        const visibleComments = includeShapes
            ? [
                ...comments.filter(comment => !options.shouldSuppressSidebarComment?.(comment)),
                ...options.getShapeAnnotationCommentSummaries(),
            ]
            : comments.filter(comment => !options.shouldSuppressSidebarComment?.(comment));
        options.emitAnnotationComments(visibleComments.slice().sort(compareAnnotationCommentSummaries));
    }

    function upsertComment(comment: IAnnotationCommentSummary) {
        clearLocalDeletionForNewTransientComment(comment);
        const next = normalizeAnnotationComments([
            ...annotationCommentsCache.value,
            comment,
        ]);
        annotationCommentsCache.value = next;
        emitCommentsForSidebar(next);
    }

    function updateCachedColor(
        comment: IAnnotationCommentSummary,
        color: string,
        options: { colorEdited?: boolean } = {},
    ) {
        const colorEdited = options.colorEdited ?? true;
        const next = annotationCommentsCache.value.map((candidate) => {
            if (!annotationCommentsMatch(candidate, comment)) {
                return candidate;
            }
            return {
                ...candidate,
                color,
                colorEdited,
                modifiedAt: Date.now(),
            };
        });
        annotationCommentsCache.value = next;
        emitCommentsForSidebar(next);
    }

    function withTransientNoteCreationTimestamp(comment: IAnnotationCommentSummary) {
        if (
            !isTransientEditorOnlyComment(comment)
            || !isNoteEligibleComment(comment)
            || comment.createdAt
        ) {
            return comment;
        }
        return {
            ...comment,
            createdAt: Date.now(),
        };
    }

    function markLocallyDeleted(comment: IAnnotationCommentSummary) {
        locallyDeletedAnnotationComments.push(comment);
        pendingMarkerMoves.delete(comment.stableKey);
        for (const candidate of annotationCommentsCache.value) {
            if (isLocallyDeletedAnnotationComment(candidate)) {
                pendingMarkerMoves.delete(candidate.stableKey);
            }
        }
        if (!isTransientEditorOnlyComment(comment)) {
            options.suppressAnnotationStableKey(comment.stableKey);
        }
        if (comment.annotationId) {
            options.suppressAnnotationId(comment.annotationId);
        }
        const next = annotationCommentsCache.value.filter(candidate => !isLocallyDeletedAnnotationComment(candidate));
        annotationCommentsCache.value = next;
        emitCommentsForSidebar(next);
    }

    function restoreLocally(comment: IAnnotationCommentSummary) {
        clearLocalDeletionForAnnotationComment(comment);
        options.unsuppressAnnotationStableKey(comment.stableKey);
        if (comment.annotationId) {
            options.unsuppressAnnotationId(comment.annotationId);
        }
        pendingMarkerMoves.delete(comment.stableKey);
        upsertComment(comment);
    }

    function mergeAnnotationCommentsThroughReload(
        incomingComments: IAnnotationCommentSummary[],
        previousComments: IAnnotationCommentSummary[],
    ) {
        const merged = incomingComments.map((comment) => {
            const previousStableComment = previousComments.find(previous =>
                commentsRepresentSameVisibleNote(comment, previous)
                || commentsShareTransientTransitionIdentity(comment, previous),
            );
            const previousDisplayTextComment = findPreviousReloadDisplayTextComment(comment, previousComments);
            const displayStableComment = withReloadStableSummaryFields(
                comment,
                previousDisplayTextComment ?? previousStableComment,
            );
            const pendingMarkerMove = pendingMarkerMoves.get(comment.stableKey);
            if (pendingMarkerMove) {
                return {
                    ...displayStableComment,
                    markerRect: pendingMarkerMove.markerRect,
                };
            }

            if (!isAnnotationReloadCacheGraceActive() || !isNoteEligibleComment(comment)) {
                return displayStableComment;
            }

            const transientPrevious = findPreviousTransientTransitionComment(comment, previousComments);
            if (transientPrevious?.markerRect) {
                return {
                    ...withReloadStableSummaryFields(displayStableComment, transientPrevious),
                    markerRect: getPendingMarkerMove(transientPrevious)?.markerRect ?? transientPrevious.markerRect,
                };
            }

            const previous = previousComments.find(candidate => annotationCommentsMatch(candidate, comment));
            if (!previous?.markerRect) {
                return displayStableComment;
            }

            return {
                ...withReloadStableSummaryFields(displayStableComment, previous),
                markerRect: previous.markerRect,
            };
        });

        for (const previous of previousComments) {
            const hasMergedReplacement = merged.some(comment =>
                commentsRepresentSameVisibleNote(comment, previous)
                || commentsShareTransientTransitionIdentity(comment, previous),
            );
            const canCarryPreviousAfterGrace = isTransientEditorOnlyComment(previous) && !hasMergedReplacement;
            if (
                !isNoteEligibleComment(previous)
                || (!isAnnotationReloadCacheGraceActive() && !canCarryPreviousAfterGrace)
                || isLocallyDeletedAnnotationComment(previous)
                || hasMergedReplacement
            ) {
                continue;
            }
            merged.push(previous);
        }

        return normalizeAnnotationComments(merged);
    }

    function applyFromSync(comments: IAnnotationCommentSummary[]) {
        const previousComments = annotationCommentsCache.value;
        const merged = mergeAnnotationCommentsThroughReload(comments, previousComments);
        emitCommentsForSidebar(merged);
        return merged;
    }

    function isGracePreservedEditorOnlyComment(comment: IAnnotationCommentSummary) {
        return isTransientEditorOnlyComment(comment)
            && isAnnotationReloadCacheGraceActive()
            && annotationCommentsCache.value.some(candidate => annotationCommentsMatch(candidate, comment));
    }

    function handleMarkerMove(
        comment: IAnnotationCommentSummary,
        markerRect: IAnnotationMarkerRect,
        moveOptions: {
            markEditorPending?: (
                updated: IAnnotationCommentSummary,
                original: IAnnotationCommentSummary,
                markerRect: IAnnotationMarkerRect,
            ) => void;
            markModified?: () => void;
        } = {},
    ) {
        const index = annotationCommentsCache.value.findIndex(candidate => candidate.stableKey === comment.stableKey);
        if (index === -1) {
            return false;
        }
        const movedAt = Date.now();
        const previous = annotationCommentsCache.value[index]!;
        pendingMarkerMoves.set(comment.stableKey, {
            markerRect,
            previousMarkerRect: previous.markerRect ?? null,
            movedAt,
        });
        const updated = {
            ...previous,
            markerRect,
            createdAt: previous.createdAt ?? movedAt,
            modifiedAt: movedAt,
        };
        moveOptions.markEditorPending?.(updated, comment, markerRect);
        const next = [...annotationCommentsCache.value];
        next[index] = updated;
        annotationCommentsCache.value = next;
        emitCommentsForSidebar(next);
        moveOptions.markModified?.();
        return true;
    }

    function getSnapshot() {
        return normalizeAnnotationComments(annotationCommentsCache.value)
            .map(cloneAnnotationCommentSnapshot);
    }

    function removeFromInternalCache(stableKey: string) {
        const comment = annotationCommentsCache.value.find(candidate => candidate.stableKey === stableKey);
        if (comment) {
            markLocallyDeleted(comment);
        }
        pendingMarkerMoves.delete(stableKey);
        annotationCommentsCache.value = annotationCommentsCache.value.filter(comment => comment.stableKey !== stableKey);
    }

    function clearPendingMarkerMoves() {
        pendingMarkerMoves.clear();
    }

    function handleSourceChanged(
        nextSource: unknown,
        previousSource: unknown,
        sourceOptions: { syncAnnotationComments?: () => void | Promise<void> } = {},
    ) {
        if (nextSource === previousSource) {
            return;
        }
        annotationReloadGeneration += 1;
        clearAnnotationReloadTimer();
        activeCommentStableKey.value = null;
        pendingMarkerMoves.clear();
        locallyDeletedAnnotationComments.length = 0;
        if (!nextSource) {
            annotationReloadCacheGraceUntil = 0;
            annotationCommentsCache.value = [];
            emitCommentsForSidebar([], { includeShapes: false });
            return;
        }
        annotationReloadCacheGraceUntil = Date.now() + ANNOTATION_RELOAD_CACHE_GRACE_MS;
        const reloadGeneration = annotationReloadGeneration;
        annotationReloadTimer = globalThis.setTimeout(() => {
            if (annotationReloadGeneration !== reloadGeneration) {
                return;
            }
            annotationReloadTimer = null;
            if (!isAnnotationReloadCacheGraceActive()) {
                pendingMarkerMoves.clear();
                const next = normalizeAnnotationComments(annotationCommentsCache.value);
                if (next.length !== annotationCommentsCache.value.length) {
                    annotationCommentsCache.value = next;
                    emitCommentsForSidebar(next);
                }
                void sourceOptions.syncAnnotationComments?.();
            }
        }, ANNOTATION_RELOAD_CACHE_GRACE_MS + 100);
    }

    tryOnScopeDispose(() => {
        annotationReloadGeneration += 1;
        clearAnnotationReloadTimer();
    });

    return {
        annotationCommentsCache,
        activeCommentStableKey,
        pendingMarkerMoves,
        emitCommentsForSidebar,
        upsertComment,
        toTextMarkupSubtype: toPdfTextMarkupSubtype,
        updateCachedColor,
        withTransientNoteCreationTimestamp,
        markLocallyDeleted,
        restoreLocally,
        applyFromSync,
        isGracePreservedEditorOnlyComment,
        handleMarkerMove,
        getSnapshot,
        removeFromInternalCache,
        clearPendingMarkerMoves,
        handleSourceChanged,
    };
};
