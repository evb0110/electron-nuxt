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
} from '@app/composables/pdf/annotationNoteWindowHelpers';
import type {
    IAnnotationNotePosition,
    IAnnotationNoteWindowState,
} from '@app/composables/pdf/annotations/annotationNoteWindowTypes';
import { isNoteEligibleComment } from '@app/composables/pdf/annotations/annotationRules';
import { runGuardedTask } from '@app/utils/async-guard';
import { BrowserLogger } from '@app/utils/browser-logger';

export interface IAnnotationNoteWindowDeps {
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    markAnnotationDirty: () => void;
    updateAnnotationCommentInViewer: (
        comment: IAnnotationCommentSummary,
        text: string,
    ) => boolean;
}

export const useAnnotationNoteWindows = (deps: IAnnotationNoteWindowDeps) => {
    const { t } = useTypedI18n();

    const {
        annotationComments,
        markAnnotationDirty,
        updateAnnotationCommentInViewer,
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
        if (left.annotationId && right.annotationId && left.annotationId === right.annotationId) {
            return true;
        }
        if (left.uid && right.uid && left.uid === right.uid) {
            return true;
        }
        if (
            left.id === right.id
            && left.source === right.source
        ) {
            return true;
        }

        return false;
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
            return;
        }
        clearAnnotationNoteDebouncedSaver(previousKey);
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
                x: 14 + lane * 20,
                y: 72 + lane * 14,
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
        return annotationCommentsMatch(left, right);
    }

    function upsertAnnotationNoteWindow(comment: IAnnotationCommentSummary) {
        const key = comment.stableKey;
        const existing = findAnnotationNoteWindow(key)
            ?? findAnnotationNoteWindowByComment(comment);
        if (existing) {
            const previousKey = existing.comment.stableKey;
            const hasUnsavedLocalChanges = existing.text !== existing.lastSavedText;
            existing.comment = selectPreferredAnnotationComment(
                existing.comment,
                comment,
            );
            const nextKey = existing.comment.stableKey;
            migrateAnnotationNoteWindowKey(previousKey, nextKey);
            existing.error = null;
            existing.isMinimized = false;
            if (!hasUnsavedLocalChanges) {
                const nextText = comment.text || '';
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
                comment,
                text: initialText,
                lastSavedText: initialText,
                saving: false,
                error: null,
                order: annotationNoteOrderCounter,
                saveMode: 'auto',
                isMinimized: false,
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

    function removeAnnotationNoteWindow(stableKey: string) {
        const before = annotationNoteWindows.value.length;
        annotationNoteWindows.value = annotationNoteWindows.value.filter(
            (note) => note.comment.stableKey !== stableKey,
        );
        if (annotationNoteWindows.value.length !== before) {
            clearAnnotationNoteDebouncedSaver(stableKey);
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
        annotationNotePositions.value = {
            ...annotationNotePositions.value,
            [stableKey]: {
                x: Math.round(position.x),
                y: Math.round(position.y),
                width:
          typeof position.width === 'number'
              ? Math.round(position.width)
              : undefined,
                height:
          typeof position.height === 'number'
              ? Math.round(position.height)
              : undefined,
            },
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
        pendingEmbeddedTextUpdates.set(stableKey, nextText);
        BrowserLogger.debug('annotations', 'Deferred embedded note text update to serialization pipeline', {
            stableKey,
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

        const localUpdated: IAnnotationCommentSummary = {
            ...targetComment,
            text: nextText,
            modifiedAt: Date.now(),
        };
        note.comment = localUpdated;
        note.text = nextText;
        note.lastSavedText = nextText;

        const latest = findMatchingAnnotationComment(targetComment);
        if (latest && latest.text === nextText) {
            note.comment = latest;
            note.text = latest.text || '';
            note.lastSavedText = latest.text || '';
        }
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
            const savedTargetComment = saveAnnotationNoteToViewer(current, nextText);
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

    // eslint-disable-next-line @typescript-eslint/require-await -- return type must remain Promise<boolean> for callers
    async function persistAllAnnotationNotes(force = false) {
        const notes = [...annotationNoteWindows.value];
        for (const note of notes) {
            const saved = persistAnnotationNote(note.comment.stableKey, force);
            if (!saved) {
                return false;
            }
        }
        return true;
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
        byPageText: Map<number, Map<string, IAnnotationCommentSummary[]>>;
    }

    function buildAnnotationNoteCommentIndexes(
        comments: IAnnotationCommentSummary[],
    ): IAnnotationNoteCommentIndexes {
        const byStableKey = new Map<string, IAnnotationCommentSummary>();
        const byAnnotationIdPage = new Map<string, IAnnotationCommentSummary>();
        const byUidPage = new Map<string, IAnnotationCommentSummary>();
        const byIdPageSource = new Map<string, IAnnotationCommentSummary>();
        const byPage = new Map<number, IAnnotationCommentSummary[]>();
        const byPageText = new Map<number, Map<string, IAnnotationCommentSummary[]>>();

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

            const normalizedText = comment.text.trim().toLowerCase();
            if (!normalizedText) {
                continue;
            }

            let textCandidatesByPage = byPageText.get(comment.pageIndex);
            if (!textCandidatesByPage) {
                textCandidatesByPage = new Map<string, IAnnotationCommentSummary[]>();
                byPageText.set(comment.pageIndex, textCandidatesByPage);
            }

            const textCandidates = textCandidatesByPage.get(normalizedText);
            if (textCandidates) {
                textCandidates.push(comment);
            } else {
                textCandidatesByPage.set(normalizedText, [comment]);
            }
        }

        return {
            byStableKey,
            byAnnotationIdPage,
            byUidPage,
            byIdPageSource,
            byPage,
            byPageText,
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
        const exactText = noteComment.text.trim().toLowerCase();
        const pageMatches = indexes.byPage.get(noteComment.pageIndex) ?? [];
        if (pageMatches.length === 0) {
            return null;
        }

        const logical = pageMatches.find(candidate => commentsLikelyReferToSameNote(noteComment, candidate));
        if (logical) {
            return logical;
        }

        if (!exactText) {
            return null;
        }

        const textMatches = indexes.byPageText
            .get(noteComment.pageIndex)
            ?.get(exactText) ?? [];
        if (textMatches.length === 1) {
            return textMatches[0] ?? null;
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

    function preferUpdatedAnnotationNoteComment(
        noteComment: IAnnotationCommentSummary,
        updated: IAnnotationCommentSummary,
    ) {
        const preferred = selectPreferredAnnotationComment(noteComment, updated);

        if (updated.markerRect && updated.markerRect !== preferred.markerRect) {
            return {
                ...preferred,
                markerRect: updated.markerRect,
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

        const noteComments = comments.filter(comment =>
            isCommentEligibleForNoteWindow(comment),
        );
        const indexes = buildAnnotationNoteCommentIndexes(noteComments);

        annotationNoteWindows.value.forEach((note) => {
            const updated = findCurrentAnnotationNoteComment(note.comment, indexes);
            if (!updated) {
                return;
            }
            syncAnnotationNoteWindowComment(note, updated);
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
    };
};
