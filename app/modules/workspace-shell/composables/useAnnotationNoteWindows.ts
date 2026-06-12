import type { Ref } from 'vue';
import {
    tryOnScopeDispose,
    until,
} from '@vueuse/core';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { ANNOTATION_NOTE_SAVE_DEBOUNCE_MS } from '@app/constants/timeouts';
import {
    annotationCommentsMatch,
    selectPreferredAnnotationComment,
    isNoteEligibleComment,
    markerRectCenterDistance,
    commentsShareStableIdentifier,
    normalizeMarkerRect,
} from '@app/modules/pdf-viewer/public';
import type {
    IAnnotationNotePosition,
    IAnnotationNoteWindowState,
} from '@app/types/annotationNoteWindow';
import { parsePdfJsAnnotationRef } from '@app/utils/pdfAnnotationRefs';
import { runGuardedTask } from '@app/utils/asyncGuard';
import { BrowserLogger } from '@app/utils/browserLogger';

const FRESH_NOTE_SYNC_GRACE_MS = 5_000;

export interface IAnnotationNoteWindowDeps {
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    markAnnotationDirty: () => void;
    updateAnnotationCommentInViewer: (
        comment: IAnnotationCommentSummary,
        text: string,
    ) => boolean;
    isAnnotationCommentSyncReady?: () => boolean;
}

export const useAnnotationNoteWindows = (deps: IAnnotationNoteWindowDeps) => {
    const { t } = useTypedI18n();

    const {
        annotationComments,
        markAnnotationDirty,
        updateAnnotationCommentInViewer,
        isAnnotationCommentSyncReady = () => true,
    } = deps;

    const annotationNoteWindows = ref<IAnnotationNoteWindowState[]>([]);
    const annotationNotePositions = shallowRef<
        Record<string, IAnnotationNotePosition>
    >({});
    interface IAnnotationNoteDebounceTimer {
        stableKey: string;
        timerId: ReturnType<typeof setTimeout>;
    }
    const annotationNoteDebounceTimers = new Map<string, IAnnotationNoteDebounceTimer>();
    const pendingEmbeddedTextUpdates = new Map<string, string>();
    let annotationNoteOrderCounter = 0;

    tryOnScopeDispose(() => {
        annotationNoteDebounceTimers.forEach(({ timerId }) => {
            clearTimeout(timerId);
        });
        annotationNoteDebounceTimers.clear();
    });

    function clearAnnotationNoteDebouncedSaver(stableKey: string) {
        const entry = annotationNoteDebounceTimers.get(stableKey);
        if (!entry) {
            return;
        }
        clearTimeout(entry.timerId);
        annotationNoteDebounceTimers.delete(stableKey);
    }

    function schedulePersistAnnotationNote(stableKey: string) {
        clearAnnotationNoteDebouncedSaver(stableKey);

        const entry: IAnnotationNoteDebounceTimer = {
            stableKey,
            timerId: setTimeout(() => {
                annotationNoteDebounceTimers.delete(entry.stableKey);
                runGuardedTask(() => Promise.resolve(persistAnnotationNote(entry.stableKey, false)), {
                    scope: 'annotations',
                    message: `Failed to persist annotation note for ${entry.stableKey}`,
                });
            }, ANNOTATION_NOTE_SAVE_DEBOUNCE_MS),
        };
        annotationNoteDebounceTimers.set(stableKey, entry);
    }

    const sortedAnnotationNoteWindows = computed(() =>
        [...annotationNoteWindows.value].sort(
            (left, right) => left.order - right.order,
        ),
    );

    const isAnyAnnotationNoteSaving = computed(() =>
        annotationNoteWindows.value.some((note) => note.saving),
    );

    function findAnnotationNoteWindowIndex(stableKey: string) {
        return annotationNoteWindows.value.findIndex(
            (note) => note.comment.stableKey === stableKey,
        );
    }

    function findAnnotationNoteWindow(stableKey: string) {
        const index = findAnnotationNoteWindowIndex(stableKey);
        if (index === -1) {
            return null;
        }
        return annotationNoteWindows.value[index] ?? null;
    }

    function isCommentEligibleForNoteWindow(comment: IAnnotationCommentSummary | null | undefined) {
        return isNoteEligibleComment(comment);
    }

    function hasAnnotationNoteStableIdentifier(comment: IAnnotationCommentSummary) {
        return Boolean(comment.annotationId) || Boolean(comment.uid);
    }

    function canMatchAnnotationNotesByPlacement(
        left: IAnnotationCommentSummary,
        right: IAnnotationCommentSummary,
    ) {
        if (left.source !== right.source) {
            return true;
        }

        return hasAnnotationNoteStableIdentifier(left) !== hasAnnotationNoteStableIdentifier(right);
    }

    function commentsLikelyReferToSameNote(
        left: IAnnotationCommentSummary,
        right: IAnnotationCommentSummary,
    ) {
        if (annotationCommentsMatch(left, right)) {
            return true;
        }
        if (
            !isCommentEligibleForNoteWindow(left)
            || !isCommentEligibleForNoteWindow(right)
        ) {
            return false;
        }
        if (left.pageIndex !== right.pageIndex) {
            return false;
        }
        if (commentsShareStableIdentifier(left, right)) {
            return true;
        }
        if (
            left.id
            && left.id === right.id
            && left.source === right.source
        ) {
            return true;
        }

        return commentsShareNotePlacement(left, right);
    }

    function commentsShareNotePlacement(
        left: IAnnotationCommentSummary,
        right: IAnnotationCommentSummary,
    ) {
        return left.pageIndex === right.pageIndex
            && isCommentEligibleForNoteWindow(left)
            && isCommentEligibleForNoteWindow(right)
            && canMatchAnnotationNotesByPlacement(left, right)
            && markerRectCenterDistance(left.markerRect, right.markerRect) < 0.01;
    }

    function findAnnotationNoteWindowByComment(comment: IAnnotationCommentSummary) {
        return annotationNoteWindows.value.find(note => commentsLikelyReferToSameNote(note.comment, comment)) ?? null;
    }

    function migrateAnnotationNoteWindowKey(previousKey: string, nextKey: string) {
        if (!previousKey || !nextKey || previousKey === nextKey) {
            return;
        }

        const previousPosition = annotationNotePositions.value[previousKey];
        if (previousPosition) {
            const nextPosition = annotationNotePositions.value[nextKey];
            const nextPositions = {
                ...annotationNotePositions.value,
                [nextKey]: nextPosition ?? previousPosition,
            };
            const {
                [previousKey]: _discarded,
                ...remainingPositions
            } = nextPositions;
            annotationNotePositions.value = remainingPositions;
        }

        const previousDebouncer = annotationNoteDebounceTimers.get(previousKey);
        if (previousDebouncer && !annotationNoteDebounceTimers.has(nextKey)) {
            annotationNoteDebounceTimers.delete(previousKey);
            previousDebouncer.stableKey = nextKey;
            annotationNoteDebounceTimers.set(nextKey, previousDebouncer);
        } else {
            clearAnnotationNoteDebouncedSaver(previousKey);
        }

        if (pendingEmbeddedTextUpdates.has(previousKey) && !pendingEmbeddedTextUpdates.has(nextKey)) {
            const pendingText = pendingEmbeddedTextUpdates.get(previousKey);
            pendingEmbeddedTextUpdates.delete(previousKey);
            if (typeof pendingText === 'string') {
                pendingEmbeddedTextUpdates.set(nextKey, pendingText);
            }
        } else if (pendingEmbeddedTextUpdates.has(previousKey)) {
            pendingEmbeddedTextUpdates.delete(previousKey);
        }
    }

    function bringAnnotationNoteToFront(stableKey: string) {
        const note = findAnnotationNoteWindow(stableKey);
        if (!note) {
            return;
        }
        annotationNoteOrderCounter += 1;
        note.order = annotationNoteOrderCounter;
    }

    function ensureAnnotationNoteDefaultPosition(stableKey: string) {
        if (annotationNotePositions.value[stableKey]) {
            return;
        }
        const noteCount = annotationNoteWindows.value.length;
        const lane = Math.max(0, noteCount - 1) % 5;
        annotationNotePositions.value = {
            ...annotationNotePositions.value,
            [stableKey]: {
                x: 14 + lane * 32,
                y: 112 + lane * 56,
            },
        };
    }

    function findMatchingAnnotationComment(comment: IAnnotationCommentSummary) {
        const noteCandidates = annotationComments.value.filter(candidate =>
            isCommentEligibleForNoteWindow(candidate),
        );
        return noteCandidates.find((candidate) =>
            annotationCommentsMatch(candidate, comment),
        ) ?? null;
    }

    function isSameAnnotationComment(
        left: IAnnotationCommentSummary,
        right: IAnnotationCommentSummary,
    ) {
        return commentsLikelyReferToSameNote(left, right);
    }

    function upsertAnnotationNoteWindow(comment: IAnnotationCommentSummary) {
        const normalizedComment = {
            ...comment,
            markerRect: normalizeMarkerRect(comment.markerRect),
        };
        const key = normalizedComment.stableKey;
        const existing = findAnnotationNoteWindow(key)
            ?? findAnnotationNoteWindowByComment(normalizedComment);
        if (existing) {
            const previousKey = existing.comment.stableKey;
            const hasUnsavedLocalChanges = existing.text !== existing.lastSavedText;
            const preferredComment = selectPreferredAnnotationComment(
                existing.comment,
                normalizedComment,
            );
            existing.comment = {
                ...preferredComment,
                markerRect: normalizeMarkerRect(preferredComment.markerRect)
                    ?? normalizeMarkerRect(existing.comment.markerRect)
                    ?? normalizeMarkerRect(normalizedComment.markerRect),
                hasNote: existing.comment.hasNote === true || normalizedComment.hasNote === true,
            };
            const nextKey = existing.comment.stableKey;
            migrateAnnotationNoteWindowKey(previousKey, nextKey);
            existing.error = null;
            existing.isMinimized = false;
            if (!hasUnsavedLocalChanges) {
                const nextText = normalizedComment.text || '';
                existing.text = nextText;
                existing.lastSavedText = nextText;
            }
            annotationNoteWindows.value = annotationNoteWindows.value.filter(note => (
                note === existing
                || !commentsLikelyReferToSameNote(note.comment, existing.comment)
            ));
            bringAnnotationNoteToFront(existing.comment.stableKey);
            return;
        }

        annotationNoteOrderCounter += 1;
        const initialText = comment.text || '';
        annotationNoteWindows.value = [
            ...annotationNoteWindows.value,
            {
                comment: normalizedComment,
                text: initialText,
                lastSavedText: initialText,
                saving: false,
                error: null,
                order: annotationNoteOrderCounter,
                saveMode: 'auto',
                isMinimized: false,
                createdAtMs: Date.now(),
            },
        ];
        ensureAnnotationNoteDefaultPosition(key);
    }

    function minimizeAnnotationNote(stableKey: string) {
        const note = findAnnotationNoteWindow(stableKey);
        if (!note) {
            return;
        }
        note.isMinimized = true;
        note.error = null;
    }

    function restoreAnnotationNote(stableKey: string) {
        const note = findAnnotationNoteWindow(stableKey);
        if (!note) {
            return;
        }
        note.isMinimized = false;
        note.error = null;
        const matched = findMatchingAnnotationComment(note.comment);
        if (matched) {
            note.comment = selectPreferredAnnotationComment(note.comment, matched);
        }
        bringAnnotationNoteToFront(stableKey);
    }

    function removeAnnotationNoteWindow(
        stableKey: string,
        options: { clearPendingEmbeddedTextUpdate?: boolean } = {},
    ) {
        const before = annotationNoteWindows.value.length;
        annotationNoteWindows.value = annotationNoteWindows.value.filter(
            (note) => note.comment.stableKey !== stableKey,
        );
        if (annotationNoteWindows.value.length !== before) {
            clearAnnotationNoteDebouncedSaver(stableKey);
            if (options.clearPendingEmbeddedTextUpdate) {
                pendingEmbeddedTextUpdates.delete(stableKey);
            }
        }
    }

    function setAnnotationNoteWindowError(
        stableKey: string,
        message: string | null,
    ) {
        const note = findAnnotationNoteWindow(stableKey);
        if (!note) {
            return;
        }
        note.error = message;
    }

    function updateAnnotationNoteText(stableKey: string, text: string) {
        const note = findAnnotationNoteWindow(stableKey);
        if (!note) {
            return;
        }
        note.text = text;
        note.error = null;
        if (note.text !== note.lastSavedText) {
            markAnnotationDirty();
        }
        schedulePersistAnnotationNote(stableKey);
    }

    function updateAnnotationNotePosition(
        stableKey: string,
        position: IAnnotationNotePosition,
    ) {
        const nextPosition: IAnnotationNotePosition = {
            x: Math.round(position.x),
            y: Math.round(position.y),
        };
        if (typeof position.width === 'number') {
            nextPosition.width = Math.round(position.width);
        }
        if (typeof position.height === 'number') {
            nextPosition.height = Math.round(position.height);
        }
        annotationNotePositions.value = {
            ...annotationNotePositions.value,
            [stableKey]: nextPosition,
        };
    }

    function getAnnotationNoteSaveCandidates(
        current: IAnnotationCommentSummary,
    ) {
        const latestComment = findMatchingAnnotationComment(current) ?? current;

        // Prefer the latest synchronized summary first; stale note-window identity
        // can miss live editors and trigger unnecessary embedded fallback reloads.
        return latestComment === current
            ? [current]
            : [
                latestComment,
                current,
            ];
    }

    function saveAnnotationNoteToViewer(
        current: IAnnotationCommentSummary,
        nextText: string,
    ) {
        for (const candidate of getAnnotationNoteSaveCandidates(current)) {
            if (!updateAnnotationCommentInViewer(candidate, nextText)) {
                continue;
            }
            return candidate;
        }

        return null;
    }

    function deferEmbeddedAnnotationNoteUpdate(
        stableKey: string,
        targetComment: IAnnotationCommentSummary,
        nextText: string,
    ) {
        const pendingKey = targetComment.stableKey || stableKey;
        pendingEmbeddedTextUpdates.set(pendingKey, nextText);
        BrowserLogger.debug('annotations', 'Deferred embedded note text update to serialization pipeline', {
            stableKey: pendingKey,
            source: targetComment.source,
            annotationId: targetComment.annotationId ?? null,
        });
    }

    function setAnnotationNoteEmbeddedFallback(note: IAnnotationNoteWindowState) {
        note.saveMode = 'embedded';
        return true;
    }

    function markAnnotationNotePersistFailed(
        note: IAnnotationNoteWindowState,
        stableKey: string,
        targetComment: IAnnotationCommentSummary,
        force: boolean,
    ) {
        BrowserLogger.warn('annotations', 'Failed to persist annotation note', {
            stableKey,
            force,
            source: targetComment.source,
            annotationId: targetComment.annotationId ?? null,
        });
        note.error = t('errors.annotation.updateNote');
        return false;
    }

    function updateAnnotationNoteSavedState(
        note: IAnnotationNoteWindowState,
        targetComment: IAnnotationCommentSummary,
        nextText: string,
    ) {
        note.saveMode = note.saveMode === 'embedded' ? 'embedded' : 'auto';

        const modifiedAt = Date.now();
        const localUpdated: IAnnotationCommentSummary = {
            ...targetComment,
            text: nextText,
            createdAt: targetComment.createdAt ?? note.comment.createdAt ?? null,
            modifiedAt,
            markerRect: normalizeMarkerRect(targetComment.markerRect)
                ?? normalizeMarkerRect(note.comment.markerRect),
        };
        note.comment = localUpdated;
        note.text = nextText;
        note.lastSavedText = nextText;
        upsertAnnotationCommentCache(localUpdated);

        const latest = findMatchingAnnotationComment(targetComment);
        if (latest && latest.text === nextText) {
            note.comment = latest;
            note.text = latest.text || '';
            note.lastSavedText = latest.text || '';
        }
    }

    function upsertAnnotationCommentCache(comment: IAnnotationCommentSummary) {
        const index = annotationComments.value.findIndex(candidate =>
            commentsLikelyReferToSameNote(candidate, comment),
        );
        if (index === -1) {
            annotationComments.value = [
                ...annotationComments.value,
                comment,
            ];
            return;
        }

        const next = [...annotationComments.value];
        const existing = next[index]!;
        const preferred = selectPreferredAnnotationComment(existing, comment);
        next[index] = {
            ...preferred,
            text: comment.text,
            hasNote: true,
            createdAt: preferred.createdAt ?? comment.createdAt ?? existing.createdAt ?? null,
            modifiedAt: comment.modifiedAt,
            markerRect: normalizeMarkerRect(comment.markerRect)
                ?? normalizeMarkerRect(existing.markerRect)
                ?? normalizeMarkerRect(preferred.markerRect),
        };
        annotationComments.value = next;
    }

    function shouldMirrorAnnotationNoteToEmbeddedSerialization(
        targetComment: IAnnotationCommentSummary,
    ) {
        return Boolean(parsePdfJsAnnotationRef(targetComment.annotationId));
    }

    function shouldSkipAnnotationNotePersistence(
        note: IAnnotationNoteWindowState,
        force: boolean,
    ) {
        // Even forced persistence should skip true no-op updates.
        // Otherwise Save/Save As can materialize and reload the PDF despite no text change.
        if (note.text === note.lastSavedText) {
            return true;
        }
        return !force && note.saveMode === 'embedded';
    }

    function handleUnsavedAnnotationNoteTarget(
        note: IAnnotationNoteWindowState,
        stableKey: string,
        targetComment: IAnnotationCommentSummary,
        nextText: string,
        force: boolean,
    ) {
        if (!force) {
            return setAnnotationNoteEmbeddedFallback(note);
        }

        if (!shouldMirrorAnnotationNoteToEmbeddedSerialization(targetComment)) {
            updateAnnotationNoteSavedState(note, targetComment, nextText);
            return true;
        }

        // When force=true (called from handleSave), defer embedded text
        // updates to the serialization pipeline instead of reloading the
        // entire document. handleSave will call rewriteEmbeddedNoteTexts()
        // which applies these deferred text changes without triggering a
        // visible re-render.
        deferEmbeddedAnnotationNoteUpdate(stableKey, targetComment, nextText);
        setAnnotationNoteEmbeddedFallback(note);
        if (note.saveMode !== 'embedded') {
            return markAnnotationNotePersistFailed(
                note,
                stableKey,
                targetComment,
                force,
            );
        }

        updateAnnotationNoteSavedState(note, targetComment, nextText);
        return true;
    }

    function scheduleDirtyAnnotationNotePersistence(stableKey: string) {
        const latestNote = findAnnotationNoteWindow(stableKey);
        if (latestNote && latestNote.text !== latestNote.lastSavedText) {
            schedulePersistAnnotationNote(stableKey);
        }
    }

    function persistAnnotationNote(stableKey: string, force = false) {
        const note = findAnnotationNoteWindow(stableKey);
        if (!note) {
            return true;
        }

        const current = note.comment;
        const nextText = note.text;
        if (shouldSkipAnnotationNotePersistence(note, force)) {
            return true;
        }

        if (note.saving) {
            return false;
        }

        note.saving = true;
        note.error = null;
        try {
            const latestComment = findMatchingAnnotationComment(current) ?? current;
            const savedTargetComment = saveAnnotationNoteToViewer(latestComment, nextText);
            let targetComment = savedTargetComment ?? latestComment;

            if (!savedTargetComment) {
                return handleUnsavedAnnotationNoteTarget(
                    note,
                    stableKey,
                    targetComment,
                    nextText,
                    force,
                );
            }

            targetComment = savedTargetComment;
            if (shouldMirrorAnnotationNoteToEmbeddedSerialization(targetComment)) {
                deferEmbeddedAnnotationNoteUpdate(stableKey, targetComment, nextText);
            }
            updateAnnotationNoteSavedState(note, targetComment, nextText);
            return true;
        } finally {
            const latestNote = findAnnotationNoteWindow(stableKey);
            if (latestNote) {
                latestNote.saving = false;
            }
            scheduleDirtyAnnotationNotePersistence(stableKey);
        }
    }

    async function persistAllAnnotationNotes(force = false) {
        const notes = [...annotationNoteWindows.value];
        if (force) {
            notes.forEach((note) => {
                if (note.text.trim().length > 0) {
                    const previousStableKey = note.comment.stableKey;
                    const latestComment = findMatchingAnnotationComment(note.comment) ?? note.comment;
                    const modifiedAt = Date.now();
                    const markerRect = normalizeMarkerRect(latestComment.markerRect)
                        ?? normalizeMarkerRect(note.comment.markerRect);
                    const commentForSave: IAnnotationCommentSummary = {
                        ...latestComment,
                        text: note.text,
                        hasNote: true,
                        createdAt: latestComment.createdAt ?? note.comment.createdAt ?? null,
                        modifiedAt,
                        markerRect,
                    };
                    note.comment = commentForSave;
                    migrateAnnotationNoteWindowKey(previousStableKey, commentForSave.stableKey);
                    if (shouldMirrorAnnotationNoteToEmbeddedSerialization(commentForSave)) {
                        deferEmbeddedAnnotationNoteUpdate(commentForSave.stableKey, commentForSave, note.text);
                    }
                    upsertAnnotationCommentCache(commentForSave);
                }
            });
        }
        for (const note of notes) {
            const saved = persistAnnotationNote(note.comment.stableKey, force);
            if (!saved) {
                return false;
            }
        }
        if (force) {
            await waitForForcedAnnotationNoteSync(notes);
        }
        return true;
    }

    async function waitForForcedAnnotationNoteSync(notes: IAnnotationNoteWindowState[]) {
        const expected = notes
            .filter(note => note.text.trim().length > 0)
            .map(note => ({
                comment: note.comment,
                text: note.text,
            }));
        if (expected.length === 0) {
            return;
        }

        try {
            await until(() => expected.every(({
                comment,
                text,
            }) => {
                const matched = findMatchingAnnotationComment(comment);
                return matched?.text === text;
            })).toBe(true, { timeout: 1_000 });
        } catch (error) {
            BrowserLogger.debug('annotations', 'Timed out waiting for forced note text sync before save', {
                expectedCount: expected.length,
                error,
            });
        }
    }

    async function closeAnnotationNote(
        stableKey: string,
        options: { saveIfDirty?: boolean } = {},
    ) {
        const saveIfDirty = options.saveIfDirty ?? true;
        const note = findAnnotationNoteWindow(stableKey);
        if (!note) {
            return;
        }

        if (saveIfDirty) {
            if (note.saving) {
                try {
                    await until(() => !note.saving).toBe(true, { timeout: 500 });
                } catch (error) {
                    void error;
                }
            }
            const saved = persistAnnotationNote(stableKey, true);
            if (!saved) {
                setAnnotationNoteWindowError(
                    stableKey,
                    t('errors.annotation.saveBeforeClose'),
                );
                return;
            }
        }

        removeAnnotationNoteWindow(stableKey);
    }

    async function closeAllAnnotationNotes(
        options: { saveIfDirty?: boolean } = {},
    ) {
        const saveIfDirty = options.saveIfDirty ?? true;
        if (saveIfDirty) {
            const saved = await persistAllAnnotationNotes(true);
            if (!saved) {
                return false;
            }
        }

        annotationNoteWindows.value.forEach((note) => {
            clearAnnotationNoteDebouncedSaver(note.comment.stableKey);
        });
        annotationNoteWindows.value = [];
        return true;
    }

    function handleOpenAnnotationNote(comment: IAnnotationCommentSummary) {
        if (!isCommentEligibleForNoteWindow(comment)) {
            return;
        }
        const noteComment = comment;
        const matched = findMatchingAnnotationComment(noteComment);
        if (matched) {
            upsertAnnotationNoteWindow(
                selectPreferredAnnotationComment(noteComment, matched),
            );
        } else {
            upsertAnnotationNoteWindow(noteComment);
        }
    }

    interface IAnnotationNoteCommentIndexes {
        byStableKey: Map<string, IAnnotationCommentSummary>;
        byAnnotationIdPage: Map<string, IAnnotationCommentSummary>;
        byUidPage: Map<string, IAnnotationCommentSummary>;
        byIdPageSource: Map<string, IAnnotationCommentSummary>;
        byPage: Map<number, IAnnotationCommentSummary[]>;
    }

    function buildAnnotationNoteCommentIndexes(
        comments: IAnnotationCommentSummary[],
    ): IAnnotationNoteCommentIndexes {
        const byStableKey = new Map<string, IAnnotationCommentSummary>();
        const byAnnotationIdPage = new Map<string, IAnnotationCommentSummary>();
        const byUidPage = new Map<string, IAnnotationCommentSummary>();
        const byIdPageSource = new Map<string, IAnnotationCommentSummary>();
        const byPage = new Map<number, IAnnotationCommentSummary[]>();

        for (const comment of comments) {
            if (comment.stableKey) {
                byStableKey.set(comment.stableKey, comment);
            }
            if (comment.annotationId) {
                byAnnotationIdPage.set(
                    `${comment.annotationId}:${comment.pageIndex}`,
                    comment,
                );
            }
            if (comment.uid) {
                byUidPage.set(`${comment.uid}:${comment.pageIndex}`, comment);
            }
            byIdPageSource.set(
                `${comment.id}:${comment.pageIndex}:${comment.source}`,
                comment,
            );

            const pageCandidates = byPage.get(comment.pageIndex);
            if (pageCandidates) {
                pageCandidates.push(comment);
            } else {
                byPage.set(comment.pageIndex, [comment]);
            }
        }

        return {
            byStableKey,
            byAnnotationIdPage,
            byUidPage,
            byIdPageSource,
            byPage,
        };
    }

    function findUpdatedAnnotationNoteComment(
        noteComment: IAnnotationCommentSummary,
        indexes: IAnnotationNoteCommentIndexes,
    ) {
        if (noteComment.stableKey) {
            const match = indexes.byStableKey.get(noteComment.stableKey);
            if (match) {
                return match;
            }
        }
        if (noteComment.annotationId) {
            const match = indexes.byAnnotationIdPage.get(
                `${noteComment.annotationId}:${noteComment.pageIndex}`,
            );
            if (match) {
                return match;
            }
        }
        if (noteComment.uid) {
            const match = indexes.byUidPage.get(
                `${noteComment.uid}:${noteComment.pageIndex}`,
            );
            if (match) {
                return match;
            }
        }
        return (
            indexes.byIdPageSource.get(
                `${noteComment.id}:${noteComment.pageIndex}:${noteComment.source}`,
            ) ?? null
        );
    }

    function findLogicalAnnotationNoteFallback(
        noteComment: IAnnotationCommentSummary,
        indexes: IAnnotationNoteCommentIndexes,
    ) {
        const pageMatches = indexes.byPage.get(noteComment.pageIndex) ?? [];
        if (pageMatches.length === 0) {
            return null;
        }

        const logical = pageMatches.find(candidate => commentsLikelyReferToSameNote(noteComment, candidate));
        if (logical) {
            return logical;
        }

        return null;
    }

    function findCurrentAnnotationNoteComment(
        noteComment: IAnnotationCommentSummary,
        indexes: IAnnotationNoteCommentIndexes,
    ) {
        return (
            findUpdatedAnnotationNoteComment(noteComment, indexes)
            ?? findLogicalAnnotationNoteFallback(noteComment, indexes)
        );
    }

    function normalizeAnnotationNoteSavedText(text: string) {
        // Strip ZWS/BOM so the stale-empty guard compares real content only
        // (legacy saves stored ZWS in /Contents — see docs/freetext-note-persistence.md)
        return text.replace(/[\u200B\uFEFF]/g, '').trim();
    }

    function isStaleEmptyAnnotationNoteSync(
        note: IAnnotationNoteWindowState,
        updated: IAnnotationCommentSummary,
    ) {
        const savedText = normalizeAnnotationNoteSavedText(note.lastSavedText);
        const updatedText = normalizeAnnotationNoteSavedText(updated.text);
        const currentTimestamp = note.comment.modifiedAt ?? 0;
        const updatedTimestamp = updated.modifiedAt ?? 0;

        return (
            !note.saving
            && savedText.length > 0
            && updatedText.length === 0
            && updatedTimestamp <= currentTimestamp
        );
    }

    function shouldKeepUnmatchedAnnotationNoteWindow(note: IAnnotationNoteWindowState) {
        if (note.text !== note.lastSavedText || note.saving) {
            return true;
        }

        return Date.now() - note.createdAtMs < FRESH_NOTE_SYNC_GRACE_MS;
    }

    function preferUpdatedAnnotationNoteComment(
        noteComment: IAnnotationCommentSummary,
        updated: IAnnotationCommentSummary,
    ) {
        const preferred = selectPreferredAnnotationComment(noteComment, updated);
        const updatedMarkerRect = normalizeMarkerRect(updated.markerRect);

        if (updatedMarkerRect && updatedMarkerRect !== normalizeMarkerRect(preferred.markerRect)) {
            return {
                ...preferred,
                markerRect: updatedMarkerRect,
            };
        }

        return preferred;
    }

    function syncAnnotationNoteWindowComment(
        note: IAnnotationNoteWindowState,
        updated: IAnnotationCommentSummary,
    ) {
        const previousStableKey = note.comment.stableKey;
        const preferred = preferUpdatedAnnotationNoteComment(note.comment, updated);
        const currentTimestamp = note.comment.modifiedAt ?? 0;
        const updatedTimestamp = updated.modifiedAt ?? 0;

        if (isStaleEmptyAnnotationNoteSync(note, updated)) {
            note.comment = {
                ...preferred,
                text: note.lastSavedText,
                modifiedAt: currentTimestamp || updatedTimestamp || null,
            };
            return;
        }

        note.comment = preferred;
        migrateAnnotationNoteWindowKey(previousStableKey, note.comment.stableKey);
        const hasUnsavedLocalChanges = note.text !== note.lastSavedText;
        if (!note.saving && !hasUnsavedLocalChanges) {
            const nextText = updated.text || '';
            note.text = nextText;
            note.lastSavedText = nextText;
        }
    }

    watch(annotationComments, (comments) => {
        if (annotationNoteWindows.value.length === 0) {
            return;
        }
        if (!isAnnotationCommentSyncReady()) {
            return;
        }

        const noteComments = comments.filter(comment =>
            isCommentEligibleForNoteWindow(comment),
        );
        const indexes = buildAnnotationNoteCommentIndexes(noteComments);
        const staleStableKeys: string[] = [];

        annotationNoteWindows.value.forEach((note) => {
            const updated = findCurrentAnnotationNoteComment(note.comment, indexes);
            if (!updated) {
                if (shouldKeepUnmatchedAnnotationNoteWindow(note)) {
                    return;
                }
                staleStableKeys.push(note.comment.stableKey);
                return;
            }
            syncAnnotationNoteWindowComment(note, updated);
        });

        staleStableKeys.forEach((stableKey) => {
            removeAnnotationNoteWindow(stableKey, { clearPendingEmbeddedTextUpdate: true });
        });
    });

    function consumePendingEmbeddedTextUpdates() {
        if (pendingEmbeddedTextUpdates.size === 0) {
            return null;
        }
        const updates = new Map(pendingEmbeddedTextUpdates);
        pendingEmbeddedTextUpdates.clear();
        return updates;
    }

    function restorePendingEmbeddedTextUpdates(updates: Map<string, string> | null | undefined) {
        updates?.forEach((text, stableKey) => {
            if (!pendingEmbeddedTextUpdates.has(stableKey)) {
                pendingEmbeddedTextUpdates.set(stableKey, text);
            }
        });
    }

    return {
        annotationNoteWindows,
        annotationNotePositions,
        sortedAnnotationNoteWindows,
        isAnyAnnotationNoteSaving,
        findAnnotationNoteWindow,
        upsertAnnotationNoteWindow,
        minimizeAnnotationNote,
        restoreAnnotationNote,
        updateAnnotationNoteText,
        updateAnnotationNotePosition,
        persistAnnotationNote,
        persistAllAnnotationNotes,
        closeAnnotationNote,
        closeAllAnnotationNotes,
        handleOpenAnnotationNote,
        removeAnnotationNoteWindow,
        setAnnotationNoteWindowError,
        bringAnnotationNoteToFront,
        isSameAnnotationComment,
        findMatchingAnnotationComment,
        selectPreferredAnnotationComment,
        consumePendingEmbeddedTextUpdates,
        restorePendingEmbeddedTextUpdates,
    };
};
