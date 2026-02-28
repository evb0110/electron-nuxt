import type { Ref } from 'vue';
import {
    until,
    useDebounceFn,
} from '@vueuse/core';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { ANNOTATION_NOTE_SAVE_DEBOUNCE_MS } from '@app/constants/timeouts';
import {
    annotationCommentsMatch,
    selectPreferredAnnotationComment,
} from '@app/composables/pdf/annotationNoteWindowHelpers';
import { runGuardedTask } from '@app/utils/async-guard';
import { BrowserLogger } from '@app/utils/browser-logger';

export interface IAnnotationNotePosition {
    x: number;
    y: number;
    width?: number;
    height?: number;
}

export interface IAnnotationNoteWindowState {
    comment: IAnnotationCommentSummary;
    text: string;
    lastSavedText: string;
    saving: boolean;
    error: string | null;
    order: number;
    saveMode: 'auto' | 'embedded';
    isMinimized: boolean;
}

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
    const annotationNoteDebouncers = new Map<
        string,
        ReturnType<typeof useDebounceFn>
    >();
    const pendingEmbeddedTextUpdates = new Map<string, string>();
    let annotationNoteOrderCounter = 0;

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

    function isNoteWindowSubtype(subtype: string | null | undefined) {
        const normalized = (subtype ?? '').trim().toLowerCase();
        return (
            normalized === 'text'
            || normalized === 'note-linked'
            || normalized === 'freetext'
            || normalized === 'typewriter'
            || normalized === 'note-inline'
        );
    }

    function isCommentEligibleForNoteWindow(comment: IAnnotationCommentSummary | null | undefined) {
        if (!comment) {
            return false;
        }
        if (comment.hasNote === true) {
            return true;
        }
        if (isNoteWindowSubtype(comment.subtype)) {
            return true;
        }
        return comment.source === 'editor' && comment.text.trim().length > 0;
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

        const previousDebouncer = annotationNoteDebouncers.get(previousKey);
        if (previousDebouncer && !annotationNoteDebouncers.has(nextKey)) {
            annotationNoteDebouncers.set(nextKey, previousDebouncer);
        }
        if (annotationNoteDebouncers.has(previousKey)) {
            annotationNoteDebouncers.delete(previousKey);
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
            const debounced = annotationNoteDebouncers.get(stableKey) as
        | ({ cancel?: () => void } & (() => void))
        | undefined;
            debounced?.cancel?.();
            annotationNoteDebouncers.delete(stableKey);
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

    function getAnnotationNoteDebouncedSaver(stableKey: string) {
        const existing = annotationNoteDebouncers.get(stableKey);
        if (existing) {
            return existing;
        }
        const saver = useDebounceFn(() => {
            runGuardedTask(() => Promise.resolve(persistAnnotationNote(stableKey, false)), {
                scope: 'annotations',
                message: `Failed to persist annotation note for ${stableKey}`,
            });
        }, ANNOTATION_NOTE_SAVE_DEBOUNCE_MS);
        annotationNoteDebouncers.set(stableKey, saver);
        return saver;
    }

    function schedulePersistAnnotationNote(stableKey: string) {
        getAnnotationNoteDebouncedSaver(stableKey)();
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

    function persistAnnotationNote(stableKey: string, force = false) {
        const note = findAnnotationNoteWindow(stableKey);
        if (!note) {
            return true;
        }

        const current = note.comment;
        const latestComment = findMatchingAnnotationComment(current) ?? current;
        const nextText = note.text;
        // Even forced persistence should skip true no-op updates.
        // Otherwise Save/Save As can materialize and reload the PDF despite no text change.
        if (nextText === note.lastSavedText) {
            return true;
        }

        if (!force && note.saveMode === 'embedded') {
            return true;
        }

        if (note.saving) {
            return false;
        }

        note.saving = true;
        note.error = null;
        try {
            let targetComment = latestComment;
            let saved = false;

            // Prefer the latest synchronized summary first; stale note-window identity
            // can miss live editors and trigger unnecessary embedded fallback reloads.
            const saveCandidates = targetComment === current
                ? [current]
                : [
                    targetComment,
                    current,
                ];
            for (const candidate of saveCandidates) {
                if (!updateAnnotationCommentInViewer(candidate, nextText)) {
                    continue;
                }
                targetComment = candidate;
                saved = true;
                break;
            }

            if (!saved && !force) {
                note.saveMode = 'embedded';
                return true;
            }

            // When force=true (called from handleSave), defer embedded text
            // updates to the serialization pipeline instead of reloading the
            // entire document. handleSave will call rewriteEmbeddedNoteTexts()
            // which applies these deferred text changes without triggering a
            // visible re-render.
            if (!saved && force) {
                pendingEmbeddedTextUpdates.set(stableKey, nextText);
                BrowserLogger.debug('annotations', 'Deferred embedded note text update to serialization pipeline', {
                    stableKey,
                    source: targetComment.source,
                    annotationId: targetComment.annotationId ?? null,
                });
                saved = true;
                note.saveMode = 'embedded';
            }

            if (!saved) {
                BrowserLogger.warn('annotations', 'Failed to persist annotation note', {
                    stableKey,
                    force,
                    source: targetComment.source,
                    annotationId: targetComment.annotationId ?? null,
                });
                note.error = t('errors.annotation.updateNote');
                return false;
            }

            note.saveMode =
                saved && note.saveMode === 'embedded' ? 'embedded' : 'auto';

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
                return true;
            }
            return true;
        } finally {
            const latestNote = findAnnotationNoteWindow(stableKey);
            if (latestNote) {
                latestNote.saving = false;
                if (latestNote.text !== latestNote.lastSavedText) {
                    schedulePersistAnnotationNote(stableKey);
                }
            }
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
            const debounced = annotationNoteDebouncers.get(note.comment.stableKey) as
        | ({ cancel?: () => void } & (() => void))
        | undefined;
            debounced?.cancel?.();
            annotationNoteDebouncers.delete(note.comment.stableKey);
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

    watch(annotationComments, (comments) => {
        if (annotationNoteWindows.value.length === 0) {
            return;
        }

        const noteComments = comments.filter(comment =>
            isCommentEligibleForNoteWindow(comment),
        );

        const byStableKey = new Map<string, IAnnotationCommentSummary>();
        const byAnnotationIdPage = new Map<string, IAnnotationCommentSummary>();
        const byUidPage = new Map<string, IAnnotationCommentSummary>();
        const byIdPageSource = new Map<string, IAnnotationCommentSummary>();
        const byPage = new Map<number, IAnnotationCommentSummary[]>();
        const byPageText = new Map<number, Map<string, IAnnotationCommentSummary[]>>();

        for (const comment of noteComments) {
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

        function findUpdatedComment(noteComment: IAnnotationCommentSummary) {
            if (noteComment.stableKey) {
                const match = byStableKey.get(noteComment.stableKey);
                if (match) {
                    return match;
                }
            }
            if (noteComment.annotationId) {
                const match = byAnnotationIdPage.get(
                    `${noteComment.annotationId}:${noteComment.pageIndex}`,
                );
                if (match) {
                    return match;
                }
            }
            if (noteComment.uid) {
                const match = byUidPage.get(
                    `${noteComment.uid}:${noteComment.pageIndex}`,
                );
                if (match) {
                    return match;
                }
            }
            return (
                byIdPageSource.get(
                    `${noteComment.id}:${noteComment.pageIndex}:${noteComment.source}`,
                ) ?? null
            );
        }

        function findLogicalFallback(noteComment: IAnnotationCommentSummary) {
            const exactText = noteComment.text.trim().toLowerCase();
            const pageMatches = byPage.get(noteComment.pageIndex) ?? [];
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

            const textMatches = byPageText
                .get(noteComment.pageIndex)
                ?.get(exactText) ?? [];
            if (textMatches.length === 1) {
                return textMatches[0] ?? null;
            }

            return null;
        }

        annotationNoteWindows.value.forEach((note) => {
            const previousStableKey = note.comment.stableKey;
            const updated =
                findUpdatedComment(note.comment)
                ?? findLogicalFallback(note.comment);
            if (!updated) {
                return;
            }
            let preferred = selectPreferredAnnotationComment(note.comment, updated);

            if (updated.markerRect && updated.markerRect !== preferred.markerRect) {
                preferred = {
                    ...preferred,
                    markerRect: updated.markerRect,
                };
            }

            const savedText = note.lastSavedText.trim();
            const updatedText = updated.text.trim();
            const currentTimestamp = note.comment.modifiedAt ?? 0;
            const updatedTimestamp = updated.modifiedAt ?? 0;
            const staleEmptySync =
                !note.saving &&
        savedText.length > 0 &&
        updatedText.length === 0 &&
        updatedTimestamp <= currentTimestamp;

            if (staleEmptySync) {
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
