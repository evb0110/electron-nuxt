import type { Ref } from 'vue';
import {
    useDebounceFn,
    tryOnScopeDispose,
} from '@vueuse/core';
import { delay } from 'es-toolkit/promise';
import type {
    IAnnotationCommentSummary,
    IAnnotationNotePosition,
    IAnnotationNoteWindowState,
} from '@app/composables/pdf/annotations/types';
import { isNoteEligibleComment } from '@app/composables/pdf/annotations/types';
import { ANNOTATION_NOTE_SAVE_DEBOUNCE_MS } from '@app/constants/timeouts';
import {
    annotationCommentsMatch,
    selectPreferredAnnotationComment,
} from '@app/composables/pdf/annotationNoteWindowHelpers';
import { runGuardedTask } from '@app/utils/async-guard';

export {
    annotationCommentsMatch,
    annotationCommentEditScore,
    selectPreferredAnnotationComment,
} from '@app/composables/pdf/annotationNoteWindowHelpers';

export interface IAnnotationNoteWindowDeps {
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    markAnnotationDirty: () => void;
    updateAnnotationCommentInViewer: (
        comment: IAnnotationCommentSummary,
        text: string,
    ) => boolean;
    updateEmbeddedAnnotationByRef: (
        comment: IAnnotationCommentSummary,
        text: string,
    ) => Promise<Uint8Array | false>;
    serializeCurrentPdfForEmbeddedFallback: () => Promise<boolean>;
    loadPdfFromData: (
        data: Uint8Array,
        options: {
            pushHistory: boolean;
            persistWorkingCopy: boolean 
        },
    ) => Promise<void>;
    workingCopyPath: Ref<string | null>;
    currentPage: Ref<number>;
    waitForPdfReload: (page: number) => Promise<void>;
}

export const useAnnotationNotes = (deps: IAnnotationNoteWindowDeps) => {
    const { t } = useTypedI18n();

    const {
        annotationComments,
        markAnnotationDirty,
        updateAnnotationCommentInViewer,
        updateEmbeddedAnnotationByRef,
        serializeCurrentPdfForEmbeddedFallback,
        loadPdfFromData,
        workingCopyPath,
        currentPage,
        waitForPdfReload,
    } = deps;

    const annotationNoteWindows = ref<IAnnotationNoteWindowState[]>([]);
    const annotationNotePositions = shallowRef<Record<string, IAnnotationNotePosition>>({});
    const annotationNoteDebouncers = new Map<string, ReturnType<typeof useDebounceFn>>();
    let annotationNoteOrderCounter = 0;

    tryOnScopeDispose(() => {
        for (const [
            , debouncer,
        ] of annotationNoteDebouncers) {
            (debouncer as { cancel?: () => void }).cancel?.();
        }
        annotationNoteDebouncers.clear();
    });

    const sortedAnnotationNoteWindows = computed(() =>
        [...annotationNoteWindows.value].sort((l, r) => l.order - r.order),
    );

    const isAnyAnnotationNoteSaving = computed(() =>
        annotationNoteWindows.value.some(note => note.saving),
    );

    function findAnnotationNoteWindowIndex(stableKey: string) {
        return annotationNoteWindows.value.findIndex(note => note.comment.stableKey === stableKey);
    }

    function findAnnotationNoteWindow(stableKey: string) {
        const index = findAnnotationNoteWindowIndex(stableKey);
        return index === -1 ? null : annotationNoteWindows.value[index] ?? null;
    }

    function commentsLikelyReferToSameNote(
        left: IAnnotationCommentSummary,
        right: IAnnotationCommentSummary,
    ) {
        if (annotationCommentsMatch(left, right)) {
            return true;
        }
        if (!isNoteEligibleComment(left) || !isNoteEligibleComment(right)) {
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
        return left.id === right.id && left.source === right.source;
    }

    function findAnnotationNoteWindowByComment(comment: IAnnotationCommentSummary) {
        return annotationNoteWindows.value.find(note =>
            commentsLikelyReferToSameNote(note.comment, comment),
        ) ?? null;
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
        const noteCandidates = annotationComments.value.filter(c => isNoteEligibleComment(c));
        return noteCandidates.find(c => annotationCommentsMatch(c, comment)) ?? null;
    }

    function isSameAnnotationComment(
        left: IAnnotationCommentSummary,
        right: IAnnotationCommentSummary,
    ) {
        return annotationCommentsMatch(left, right);
    }

    function upsertAnnotationNoteWindow(comment: IAnnotationCommentSummary) {
        const key = comment.stableKey;
        const existing = findAnnotationNoteWindow(key) ?? findAnnotationNoteWindowByComment(comment);

        if (existing) {
            const previousKey = existing.comment.stableKey;
            const hasUnsavedLocalChanges = existing.text !== existing.lastSavedText;
            existing.comment = selectPreferredAnnotationComment(existing.comment, comment);
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
            note => note.comment.stableKey !== stableKey,
        );
        if (annotationNoteWindows.value.length !== before) {
            const debounced = annotationNoteDebouncers.get(stableKey) as
                | ({ cancel?: () => void } & (() => void))
                | undefined;
            debounced?.cancel?.();
            annotationNoteDebouncers.delete(stableKey);
        }
    }

    function setAnnotationNoteWindowError(stableKey: string, message: string | null) {
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
            runGuardedTask(() => persistAnnotationNote(stableKey, false), {
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

    function updateAnnotationNotePosition(stableKey: string, position: IAnnotationNotePosition) {
        annotationNotePositions.value = {
            ...annotationNotePositions.value,
            [stableKey]: {
                x: Math.round(position.x),
                y: Math.round(position.y),
                width: typeof position.width === 'number' ? Math.round(position.width) : undefined,
                height: typeof position.height === 'number' ? Math.round(position.height) : undefined,
            },
        };
    }

    async function persistAnnotationNote(stableKey: string, force = false) {
        const note = findAnnotationNoteWindow(stableKey);
        if (!note) {
            return true;
        }

        const current = note.comment;
        const nextText = note.text;
        if (!force && nextText === note.lastSavedText) {
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
            const savedInViewer = updateAnnotationCommentInViewer(current, nextText);
            let saved = savedInViewer;

            if (!saved && !force) {
                note.saveMode = 'embedded';
                return true;
            }
            if (!saved) {
                const result = await updateEmbeddedAnnotationByRef(current, nextText);
                if (result instanceof Uint8Array) {
                    const pageToRestore = currentPage.value;
                    const restorePromise = waitForPdfReload(pageToRestore);
                    await loadPdfFromData(result, {
                        pushHistory: true,
                        persistWorkingCopy: !!workingCopyPath.value,
                    });
                    await restorePromise;
                    saved = true;
                }
            }
            if (!saved && force) {
                const materialized = await serializeCurrentPdfForEmbeddedFallback();
                if (materialized) {
                    const result = await updateEmbeddedAnnotationByRef(current, nextText);
                    if (result instanceof Uint8Array) {
                        const pageToRestore = currentPage.value;
                        const restorePromise = waitForPdfReload(pageToRestore);
                        await loadPdfFromData(result, {
                            pushHistory: true,
                            persistWorkingCopy: !!workingCopyPath.value,
                        });
                        await restorePromise;
                        saved = true;
                    }
                }
            }
            if (savedInViewer && force) {
                const materialized = await serializeCurrentPdfForEmbeddedFallback();
                if (!materialized) {
                    note.error = t('errors.annotation.updateNote');
                    return false;
                }
            }
            if (!saved) {
                note.error = t('errors.annotation.updateNote');
                return false;
            }

            note.saveMode = saved && note.saveMode === 'embedded' ? 'embedded' : 'auto';

            const localUpdated: IAnnotationCommentSummary = {
                ...current,
                text: nextText,
                modifiedAt: Date.now(),
            };
            note.comment = localUpdated;
            note.text = nextText;
            note.lastSavedText = nextText;

            const latest = findMatchingAnnotationComment(current);
            if (latest && latest.text === nextText) {
                note.comment = latest;
                note.text = latest.text || '';
                note.lastSavedText = latest.text || '';
                return true;
            }
            return true;
        }
        catch {
            note.error = t('errors.annotation.updateNote');
            return false;
        }
        finally {
            const latestNote = findAnnotationNoteWindow(stableKey);
            if (latestNote) {
                latestNote.saving = false;
                if (latestNote.text !== latestNote.lastSavedText) {
                    schedulePersistAnnotationNote(stableKey);
                }
            }
        }
    }

    async function persistAllAnnotationNotes(force = false) {
        const notes = [...annotationNoteWindows.value];
        for (const note of notes) {
            const saved = await persistAnnotationNote(note.comment.stableKey, force);
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
                let attempts = 0;
                while (note.saving && attempts < 20) {
                    await delay(25);
                    attempts += 1;
                }
            }
            const saved = await persistAnnotationNote(stableKey, true);
            if (!saved) {
                setAnnotationNoteWindowError(stableKey, t('errors.annotation.saveBeforeClose'));
                return;
            }
        }

        removeAnnotationNoteWindow(stableKey);
    }

    async function closeAllAnnotationNotes(options: { saveIfDirty?: boolean } = {}) {
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
        if (!isNoteEligibleComment(comment)) {
            return;
        }
        const matched = findMatchingAnnotationComment(comment);
        if (matched) {
            upsertAnnotationNoteWindow(selectPreferredAnnotationComment(comment, matched));
        }
        else {
            upsertAnnotationNoteWindow(comment);
        }
    }

    watch(annotationComments, (comments) => {
        if (annotationNoteWindows.value.length === 0) {
            return;
        }

        const noteComments = comments.filter(c => isNoteEligibleComment(c));

        const byStableKey = new Map<string, IAnnotationCommentSummary>();
        const byAnnotationIdPage = new Map<string, IAnnotationCommentSummary>();
        const byUidPage = new Map<string, IAnnotationCommentSummary>();
        const byIdPageSource = new Map<string, IAnnotationCommentSummary>();

        for (const comment of noteComments) {
            if (comment.stableKey) byStableKey.set(comment.stableKey, comment);
            if (comment.annotationId) byAnnotationIdPage.set(`${comment.annotationId}:${comment.pageIndex}`, comment);
            if (comment.uid) byUidPage.set(`${comment.uid}:${comment.pageIndex}`, comment);
            byIdPageSource.set(`${comment.id}:${comment.pageIndex}:${comment.source}`, comment);
        }

        function findUpdatedComment(noteComment: IAnnotationCommentSummary) {
            if (noteComment.stableKey) {
                const match = byStableKey.get(noteComment.stableKey);
                if (match) {
                    return match;
                }
            }
            if (noteComment.annotationId) {
                const match = byAnnotationIdPage.get(`${noteComment.annotationId}:${noteComment.pageIndex}`);
                if (match) {
                    return match;
                }
            }
            if (noteComment.uid) {
                const match = byUidPage.get(`${noteComment.uid}:${noteComment.pageIndex}`);
                if (match) {
                    return match;
                }
            }
            return byIdPageSource.get(`${noteComment.id}:${noteComment.pageIndex}:${noteComment.source}`) ?? null;
        }

        function findLogicalFallback(noteComment: IAnnotationCommentSummary) {
            const exactText = noteComment.text.trim().toLowerCase();
            const pageMatches = noteComments.filter(c => c.pageIndex === noteComment.pageIndex);
            if (pageMatches.length === 0) {
                return null;
            }

            const logical = pageMatches.find(c => commentsLikelyReferToSameNote(noteComment, c));
            if (logical) {
                return logical;
            }

            if (!exactText) {
                return null;
            }
            const textMatches = pageMatches.filter((c) => {
                const ct = c.text.trim().toLowerCase();
                return ct.length > 0 && ct === exactText;
            });
            return textMatches.length === 1 ? textMatches[0] ?? null : null;
        }

        annotationNoteWindows.value.forEach((note) => {
            const previousStableKey = note.comment.stableKey;
            const updated = findUpdatedComment(note.comment) ?? findLogicalFallback(note.comment);
            if (!updated) {
                return;
            }

            const preferred = selectPreferredAnnotationComment(note.comment, updated);
            const savedText = note.lastSavedText.trim();
            const updatedText = updated.text.trim();
            const currentTimestamp = note.comment.modifiedAt ?? 0;
            const updatedTimestamp = updated.modifiedAt ?? 0;
            const staleEmptySync = !note.saving
                && savedText.length > 0
                && updatedText.length === 0
                && updatedTimestamp <= currentTimestamp;

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
    };
};
