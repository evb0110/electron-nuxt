import type {Ref} from 'vue';
import {tryOnScopeDispose} from '@vueuse/core';
import type {IAnnotationCommentSummary} from '@app/types/annotations';
import type {
    IAnnotationNotePosition,
    IAnnotationNoteWindowState,
    IAnnotationNoteWindowViewModel,
} from '@app/types/annotationNoteWindow';
import {
    isNoteEligibleComment,
    annotationIdForSummary,
} from '@app/modules/pdf-viewer/public';
import {
    asAnnotationId,
    type AnnotationId,
} from '@app/modules/pdf-viewer/public';
import {ANNOTATION_NOTE_SAVE_DEBOUNCE_MS} from '@app/constants/timeouts';
import {runGuardedTask} from '@app/utils/asyncGuard';

interface IAnnotationNoteWindowRuntime {
    requiresEmbeddedSave: boolean;
    canonicalText: string;
    pageIndex: number;
    pageNumber: number;
    author: string | null;
    createdAt: number | null;
    modifiedAt: number | null;
    markerRect: IAnnotationCommentSummary['markerRect'];
    subtype: string | null;
    source: IAnnotationCommentSummary['source'];
    hasNote: boolean;
    dirty: boolean;
    saving: boolean;
    error: string | null;
    order: number;
    pendingEmbeddedSave: boolean;
    createdAtMs: number;
}

const ANNOTATION_NOTE_DISAPPEARANCE_GRACE_MS = 5_000;

export interface IAnnotationNoteWindowDeps {
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    markAnnotationDirty: () => void;
    updateAnnotationCommentInViewer: (
        annotationId: AnnotationId,
        text: string,
    ) => boolean | Promise<boolean>;
    isAnnotationCommentSyncReady?: () => boolean;
}

function commandId(comment: IAnnotationCommentSummary): AnnotationId {
    return annotationIdForSummary(comment);
}

function commentsHaveSameIdentity(left: IAnnotationCommentSummary, right: IAnnotationCommentSummary) {
    return annotationIdForSummary(left) === annotationIdForSummary(right);
}

export const useAnnotationNoteWindows = (deps: IAnnotationNoteWindowDeps) => {
    const {t} = useTypedI18n();
    const states = ref<IAnnotationNoteWindowState[]>([]);
    const runtime = new Map<AnnotationId, IAnnotationNoteWindowRuntime>();
    const timers = new Map<AnnotationId, ReturnType<typeof setTimeout>>();
    const disappearanceTimers = new Map<AnnotationId, ReturnType<typeof setTimeout>>();
    let nextOrder = 0;

    function stateById(annotationId: string) {
        return states.value.find(state => state.annotationId === annotationId) ?? null;
    }

    function toViewModel(state: IAnnotationNoteWindowState): IAnnotationNoteWindowViewModel | null {
        const annotationId = asAnnotationId(state.annotationId);
        const metadata = runtime.get(annotationId);
        if (!metadata) {
            return null;
        }
        return Object.defineProperties({}, {
            annotationId: {
                enumerable: true,
                get: () => state.annotationId,
            },
            draftText: {
                enumerable: true,
                get: () => state.draftText,
                set: value => { state.draftText = String(value); },
            },
            minimized: {
                enumerable: true,
                get: () => state.minimized,
                set: value => { state.minimized = Boolean(value); },
            },
            position: {
                enumerable: true,
                get: () => state.position,
                set: value => { state.position = value as IAnnotationNotePosition; },
            },
            pageIndex: {
                enumerable: true,
                get: () => metadata.pageIndex,
            },
            pageNumber: {
                enumerable: true,
                get: () => metadata.pageNumber,
            },
            author: {
                enumerable: true,
                get: () => metadata.author,
            },
            createdAt: {
                enumerable: true,
                get: () => metadata.createdAt,
            },
            modifiedAt: {
                enumerable: true,
                get: () => metadata.modifiedAt,
            },
            markerRect: {
                enumerable: true,
                get: () => metadata.markerRect ? Object.freeze({...metadata.markerRect}) : null,
            },
            subtype: {
                enumerable: true,
                get: () => metadata.subtype,
            },
            source: {
                enumerable: true,
                get: () => metadata.source,
            },
            hasNote: {
                enumerable: true,
                get: () => metadata.hasNote,
            },
            dirty: {
                enumerable: true,
                get: () => metadata.dirty,
                set: value => { metadata.dirty = Boolean(value); },
            },
            saving: {
                enumerable: true,
                get: () => metadata.saving,
            },
            error: {
                enumerable: true,
                get: () => metadata.error,
            },
            order: {
                enumerable: true,
                get: () => metadata.order,
            },
            pendingEmbeddedSave: {
                enumerable: true,
                get: () => metadata.pendingEmbeddedSave,
            },
            isMinimized: {
                enumerable: true,
                get: () => state.minimized,
            },
            createdAtMs: {
                enumerable: true,
                get: () => metadata.createdAtMs,
                set: value => { metadata.createdAtMs = Number(value); },
            },
        }) as IAnnotationNoteWindowViewModel;
    }

    const annotationNoteWindows = computed(() => states.value.flatMap((state) => {
        const viewModel = toViewModel(state);
        return viewModel ? [viewModel] : [];
    }));
    const sortedAnnotationNoteWindows = computed(() => (
        [...annotationNoteWindows.value].sort((left, right) => left.order - right.order)
    ));
    const annotationNotePositions = computed<Record<string, IAnnotationNotePosition>>(() => Object.fromEntries(
        states.value.flatMap((state) => {
            return [[
                state.annotationId,
                state.position,
            ]];
        }),
    ));
    const isAnyAnnotationNoteSaving = computed(() => (
        [...runtime.values()].some(value => value.saving)
    ));

    function resolveId(value: string) {
        const direct = states.value.find(state => state.annotationId === value);
        if (direct) {
            return asAnnotationId(direct.annotationId);
        }
        return null;
    }

    function findAnnotationNoteWindow(value: string) {
        const id = resolveId(value);
        const state = id ? stateById(id) : null;
        return state ? toViewModel(state) : null;
    }

    function findMatchingAnnotationComment(comment: IAnnotationCommentSummary) {
        return deps.annotationComments.value.find(candidate => commentsHaveSameIdentity(candidate, comment)) ?? null;
    }

    function ensureDefaultPosition() {
        const lane = states.value.length % 5;
        return {
            x: 14 + lane * 32,
            y: 112 + lane * 56,
        };
    }

    function upsertAnnotationNoteWindow(comment: IAnnotationCommentSummary) {
        if (!isNoteEligibleComment(comment)) {
            return;
        }
        const annotationId = commandId(comment);
        const existing = stateById(annotationId);
        if (existing) {
            existing.minimized = false;
            const metadata = runtime.get(annotationId)!;
            metadata.error = null;
            metadata.order = ++nextOrder;
            metadata.canonicalText = comment.text;
            metadata.requiresEmbeddedSave = comment.source === 'pdf' || Boolean(comment.annotationId);
            metadata.pageIndex = comment.pageIndex;
            metadata.pageNumber = comment.pageNumber;
            metadata.author = comment.author ?? null;
            metadata.createdAt = comment.createdAt ?? metadata.createdAt;
            metadata.modifiedAt = comment.modifiedAt ?? null;
            metadata.markerRect = comment.markerRect ? {...comment.markerRect} : null;
            metadata.subtype = comment.subtype ?? null;
            metadata.source = comment.source;
            metadata.hasNote = comment.hasNote === true;
            if (!metadata.dirty) existing.draftText = comment.text;
            return;
        }
        states.value.push({
            annotationId,
            draftText: comment.text,
            minimized: false,
            position: ensureDefaultPosition(),
        });
        runtime.set(annotationId, {
            requiresEmbeddedSave: comment.source === 'pdf' || Boolean(comment.annotationId),
            canonicalText: comment.text,
            pageIndex: comment.pageIndex,
            pageNumber: comment.pageNumber,
            author: comment.author ?? null,
            createdAt: comment.createdAt ?? null,
            modifiedAt: comment.modifiedAt ?? null,
            markerRect: comment.markerRect ? {...comment.markerRect} : null,
            subtype: comment.subtype ?? null,
            source: comment.source,
            hasNote: comment.hasNote === true,
            dirty: false,
            saving: false,
            error: null,
            order: ++nextOrder,
            pendingEmbeddedSave: false,
            createdAtMs: Date.now(),
        });
    }

    function bringAnnotationNoteToFront(value: string) {
        const id = resolveId(value);
        const metadata = id ? runtime.get(id) : null;
        if (metadata) metadata.order = ++nextOrder;
    }

    function minimizeAnnotationNote(value: string) {
        const id = resolveId(value);
        const state = id ? stateById(id) : null;
        if (state) state.minimized = true;
    }

    function restoreAnnotationNote(value: string) {
        const id = resolveId(value);
        const state = id ? stateById(id) : null;
        if (!state || !id) {
            return;
        }
        state.minimized = false;
        const metadata = runtime.get(id);
        if (metadata) metadata.order = ++nextOrder;
    }

    function clearTimer(id: AnnotationId) {
        const timer = timers.get(id);
        if (timer !== undefined) clearTimeout(timer);
        timers.delete(id);
    }

    function clearDisappearanceTimer(id: AnnotationId) {
        const timer = disappearanceTimers.get(id);
        if (timer !== undefined) clearTimeout(timer);
        disappearanceTimers.delete(id);
    }

    function removeIfStillMissing(id: AnnotationId) {
        const metadata = runtime.get(id);
        if (
            !metadata
            || metadata.dirty
            || deps.annotationComments.value.some(comment => (
                isNoteEligibleComment(comment) && commandId(comment) === id
            ))
        ) {
            return;
        }
        removeAnnotationNoteWindow(id);
    }

    function scheduleRemovalAfterProjectionGap(id: AnnotationId) {
        if (disappearanceTimers.has(id)) {
            return;
        }
        const metadata = runtime.get(id);
        if (!metadata) {
            return;
        }
        const remainingGraceMs = Math.max(
            0,
            ANNOTATION_NOTE_DISAPPEARANCE_GRACE_MS - (Date.now() - metadata.createdAtMs),
        );
        if (remainingGraceMs === 0) {
            removeIfStillMissing(id);
            return;
        }
        disappearanceTimers.set(id, setTimeout(() => {
            disappearanceTimers.delete(id);
            removeIfStillMissing(id);
        }, remainingGraceMs));
    }

    function schedulePersist(id: AnnotationId) {
        clearTimer(id);
        timers.set(id, setTimeout(() => {
            timers.delete(id);
            runGuardedTask(() => Promise.resolve(persistAnnotationNote(id, false)), {
                category: 'background-diagnostic',
                scope: 'annotations',
                message: `Failed to persist annotation note ${id}`,
            });
        }, ANNOTATION_NOTE_SAVE_DEBOUNCE_MS));
    }

    function updateAnnotationNoteText(value: string, text: string) {
        const id = resolveId(value);
        const state = id ? stateById(id) : null;
        const metadata = id ? runtime.get(id) : null;
        if (!id || !state || !metadata) {
            return;
        }
        state.draftText = text;
        metadata.dirty = text !== metadata.canonicalText;
        metadata.error = null;
        if (metadata.dirty) deps.markAnnotationDirty();
        schedulePersist(id);
    }

    function updateAnnotationNotePosition(value: string, position: IAnnotationNotePosition) {
        const id = resolveId(value);
        const state = id ? stateById(id) : null;
        if (!state) {
            return;
        }
        state.position = {
            x: Math.round(position.x),
            y: Math.round(position.y),
            ...(typeof position.width === 'number' ? {width: Math.round(position.width)} : {}),
            ...(typeof position.height === 'number' ? {height: Math.round(position.height)} : {}),
        };
    }

    function persistAnnotationNote(value: string, force = false): boolean | Promise<boolean> {
        const id = resolveId(value) ?? asAnnotationId(value);
        const state = stateById(id);
        const metadata = runtime.get(id);
        if (!state || !metadata || !metadata.dirty) {
            return true;
        }
        if (metadata.saving) {
            return false;
        }
        metadata.saving = true;
        metadata.error = null;
        const submittedText = state.draftText;
        const finish = (updated: boolean) => {
            if (metadata.requiresEmbeddedSave) {
                metadata.pendingEmbeddedSave = true;
            }
            if (!updated && !force) {
                metadata.pendingEmbeddedSave = true;
                return true;
            }
            metadata.canonicalText = submittedText;
            if (state.draftText === submittedText) {
                metadata.dirty = false;
            }
            return true;
        };
        const fail = () => {
            metadata.error = t('errors.annotation.updateNote');
            return false;
        };
        try {
            const updated = deps.updateAnnotationCommentInViewer(id, submittedText);
            if (updated instanceof Promise) {
                return updated
                    .then(finish)
                    .catch(fail)
                    .finally(() => {
                        metadata.saving = false;
                    });
            }
            const result = finish(updated);
            metadata.saving = false;
            return result;
        } catch {
            const result = fail();
            metadata.saving = false;
            return result;
        }
    }

    async function persistAllAnnotationNotes(force = false) {
        const results = await Promise.all(
            states.value.map(state => Promise.resolve(
                persistAnnotationNote(state.annotationId, force),
            )),
        );
        return results.every(Boolean);
    }

    function removeAnnotationNoteWindow(value: string) {
        const id = resolveId(value);
        if (!id) {
            return;
        }
        states.value = states.value.filter(state => state.annotationId !== id);
        runtime.delete(id);
        clearTimer(id);
        clearDisappearanceTimer(id);
    }

    async function closeAnnotationNote(value: string, options: {saveIfDirty?: boolean} = {}) {
        if (options.saveIfDirty !== false && !await persistAnnotationNote(value, true)) {
            return;
        }
        removeAnnotationNoteWindow(value);
    }

    async function closeAllAnnotationNotes(options: {saveIfDirty?: boolean} = {}) {
        if (options.saveIfDirty !== false && !await persistAllAnnotationNotes(true)) {
            return false;
        }
        timers.forEach(timer => clearTimeout(timer));
        disappearanceTimers.forEach(timer => clearTimeout(timer));
        timers.clear(); disappearanceTimers.clear(); runtime.clear(); states.value = [];
        return true;
    }

    function setAnnotationNoteWindowError(value: string, message: string | null) {
        const id = resolveId(value);
        const metadata = id ? runtime.get(id) : null;
        if (metadata) metadata.error = message;
    }

    watch(deps.annotationComments, (comments) => {
        if (!deps.isAnnotationCommentSyncReady?.() && deps.isAnnotationCommentSyncReady) {
            return;
        }
        const ids = new Set(comments.filter(isNoteEligibleComment).map(commandId));
        comments.filter(isNoteEligibleComment).forEach((comment) => {
            const id = commandId(comment);
            const metadata = runtime.get(id);
            if (!metadata) {
                return;
            }
            metadata.canonicalText = comment.text;
            metadata.requiresEmbeddedSave = comment.source === 'pdf' || Boolean(comment.annotationId);
            metadata.pageIndex = comment.pageIndex;
            metadata.pageNumber = comment.pageNumber;
            metadata.author = comment.author ?? null;
            metadata.createdAt = comment.createdAt ?? metadata.createdAt;
            metadata.modifiedAt = comment.modifiedAt ?? null;
            metadata.markerRect = comment.markerRect ? {...comment.markerRect} : null;
            metadata.subtype = comment.subtype ?? null;
            metadata.source = comment.source;
            metadata.hasNote = comment.hasNote === true;
            clearDisappearanceTimer(id);
        });
        states.value.filter(state => !ids.has(asAnnotationId(state.annotationId))).forEach((state) => {
            const metadata = runtime.get(asAnnotationId(state.annotationId));
            if (metadata && !metadata.dirty) {
                scheduleRemovalAfterProjectionGap(asAnnotationId(state.annotationId));
            }
        });
    });

    tryOnScopeDispose(() => {
        timers.forEach(timer => clearTimeout(timer));
        disappearanceTimers.forEach(timer => clearTimeout(timer));
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
        handleOpenAnnotationNote: upsertAnnotationNoteWindow,
        removeAnnotationNoteWindow,
        setAnnotationNoteWindowError,
        bringAnnotationNoteToFront,
        isSameAnnotationComment: commentsHaveSameIdentity,
        findMatchingAnnotationComment,
        selectPreferredAnnotationComment: (left: IAnnotationCommentSummary, right: IAnnotationCommentSummary) => (
            commentsHaveSameIdentity(left, right) ? right : left
        ),
    };
};
