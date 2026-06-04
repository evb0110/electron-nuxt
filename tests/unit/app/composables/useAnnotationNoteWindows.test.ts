import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    nextTick,
    ref,
} from 'vue';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { useAnnotationNoteWindows } from '@app/composables/pdf/useAnnotationNoteWindows';

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: 'note-1',
        stableKey: 'note-1:0',
        pageIndex: 0,
        pageNumber: 1,
        text: 'Initial note',
        author: null,
        modifiedAt: null,
        color: null,
        uid: null,
        annotationId: 'ann-1',
        source: 'editor',
        hasNote: true,
        ...overrides,
    };
}

function createHarness(comment = createComment()) {
    const deps = {
        annotationComments: ref<IAnnotationCommentSummary[]>([comment]),
        markAnnotationDirty: vi.fn(),
        updateAnnotationCommentInViewer: vi.fn<
            (comment: IAnnotationCommentSummary, text: string) => boolean
        >(() => true),
        isAnnotationCommentSyncReady: vi.fn(() => true),
    };

    return {
        deps,
        windows: useAnnotationNoteWindows(deps),
    };
}

describe('useAnnotationNoteWindows', () => {
    it('skips forced no-op persistence when note text is unchanged', async () => {
        const {
            deps,
            windows,
        } = createHarness();

        windows.handleOpenAnnotationNote(createComment());

        const saved = await windows.persistAllAnnotationNotes(true);

        expect(saved).toBe(true);
        expect(deps.updateAnnotationCommentInViewer).not.toHaveBeenCalled();
    });

    it('does not materialize a full PDF reload when force-saving viewer-backed note edits', async () => {
        const {
            deps,
            windows,
        } = createHarness();

        windows.handleOpenAnnotationNote(createComment());
        const note = windows.findAnnotationNoteWindow('note-1:0');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }

        note.text = 'Updated text';
        const saved = windows.persistAnnotationNote('note-1:0', true);

        expect(saved).toBe(true);
        expect(note.lastSavedText).toBe('Updated text');
        expect(deps.annotationComments.value.find(comment => comment.stableKey === 'note-1:0')?.text).toBe('Updated text');
    });

    it('preserves a note creation timestamp when saving through a synchronized summary without one', () => {
        const opened = createComment({
            createdAt: 111,
            modifiedAt: null,
        });
        const syncedWithoutCreatedAt = createComment({
            createdAt: null,
            modifiedAt: 222,
        });
        const {
            deps,
            windows,
        } = createHarness(opened);

        windows.handleOpenAnnotationNote(opened);
        deps.annotationComments.value = [syncedWithoutCreatedAt];

        const note = windows.findAnnotationNoteWindow('note-1:0');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }

        note.text = 'Updated through sync';
        const saved = windows.persistAnnotationNote('note-1:0');

        expect(saved).toBe(true);
        expect(note.comment.createdAt).toBe(111);
        expect(deps.annotationComments.value[0]?.createdAt).toBe(111);
    });

    it('mirrors existing PDF note saves into the embedded serialization pipeline', () => {
        const comment = createComment({
            id: '3856R',
            stableKey: 'ann:0:3856R',
            annotationId: '3856R',
            uid: null,
            source: 'pdf',
            text: 'Initial note',
        });
        const { windows } = createHarness(comment);

        windows.handleOpenAnnotationNote(comment);
        const note = windows.findAnnotationNoteWindow('ann:0:3856R');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }

        note.text = 'Updated PDF note';
        const saved = windows.persistAnnotationNote('ann:0:3856R', false);

        expect(saved).toBe(true);
        expect(note.lastSavedText).toBe('Updated PDF note');
        const pending = windows.consumePendingEmbeddedTextUpdates();
        expect(pending?.get('ann:0:3856R')).toBe('Updated PDF note');
    });

    it('mirrors reopened editor-sourced notes with durable annotation ids into embedded serialization', () => {
        const comment = createComment({
            id: 'editor:0:pdfjs_internal_editor_0',
            stableKey: 'uid:0:pdfjs_internal_editor_0',
            annotationId: '3856R',
            uid: 'pdfjs_internal_editor_0',
            source: 'editor',
            text: 'Initial note',
        });
        const { windows } = createHarness(comment);

        windows.handleOpenAnnotationNote(comment);
        const note = windows.findAnnotationNoteWindow('uid:0:pdfjs_internal_editor_0');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }

        note.text = 'Updated reopened note';
        const saved = windows.persistAnnotationNote('uid:0:pdfjs_internal_editor_0', false);

        expect(saved).toBe(true);
        expect(note.lastSavedText).toBe('Updated reopened note');
        const pending = windows.consumePendingEmbeddedTextUpdates();
        expect(pending?.get('uid:0:pdfjs_internal_editor_0')).toBe('Updated reopened note');
    });

    it('migrates pending embedded text when a note window resolves to a new stable key', async () => {
        const initialComment = createComment({
            id: 'runtime-note',
            stableKey: 'uid:0:pdfjs_internal_editor_0',
            annotationId: '3856R',
            uid: 'pdfjs_internal_editor_0',
            source: 'pdf',
            text: 'Initial note',
        });
        const {
            deps,
            windows,
        } = createHarness(initialComment);

        windows.handleOpenAnnotationNote(initialComment);
        const note = windows.findAnnotationNoteWindow('uid:0:pdfjs_internal_editor_0');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }

        note.text = 'Updated PDF note';
        expect(windows.persistAnnotationNote('uid:0:pdfjs_internal_editor_0', false)).toBe(true);

        deps.annotationComments.value = [createComment({
            ...initialComment,
            id: '3856R',
            stableKey: 'ann:0:3856R',
            uid: null,
            text: 'Updated PDF note',
        })];
        await nextTick();

        const pending = windows.consumePendingEmbeddedTextUpdates();
        expect(pending?.has('uid:0:pdfjs_internal_editor_0')).toBe(false);
        expect(pending?.get('ann:0:3856R')).toBe('Updated PDF note');
    });

    it('saves replayable editor-only notes locally when auto path fails during forced save', () => {
        const comment = createComment({
            id: 'editor:0:pdfjs_internal_editor_0',
            stableKey: 'uid:0:pdfjs_internal_editor_0',
            annotationId: null,
            uid: 'pdfjs_internal_editor_0',
            source: 'editor',
        });
        const {
            deps,
            windows,
        } = createHarness(comment);

        deps.updateAnnotationCommentInViewer.mockReturnValue(false);

        windows.handleOpenAnnotationNote(comment);
        const note = windows.findAnnotationNoteWindow('uid:0:pdfjs_internal_editor_0');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }

        note.text = 'Unsaved sticky note text';
        const saved = windows.persistAnnotationNote('uid:0:pdfjs_internal_editor_0', true);

        expect(saved).toBe(true);
        expect(note.saveMode).toBe('auto');
        expect(note.lastSavedText).toBe('Unsaved sticky note text');
        expect(windows.consumePendingEmbeddedTextUpdates()).toBeNull();
    });

    it('returns null from consumePendingEmbeddedTextUpdates when nothing is pending', () => {
        const { windows } = createHarness();

        const pending = windows.consumePendingEmbeddedTextUpdates();
        expect(pending).toBeNull();
    });

    it('clears pending updates after consume', () => {
        const comment = createComment({
            id: '3856R',
            stableKey: 'ann:0:3856R',
            annotationId: '3856R',
            uid: null,
            source: 'pdf',
        });
        const {
            deps,
            windows,
        } = createHarness(comment);

        deps.updateAnnotationCommentInViewer.mockReturnValue(false);

        windows.handleOpenAnnotationNote(comment);
        const note = windows.findAnnotationNoteWindow('ann:0:3856R');
        if (!note) {
            return;
        }
        note.text = 'Changed';
        windows.persistAnnotationNote('ann:0:3856R', true);

        const first = windows.consumePendingEmbeddedTextUpdates();
        expect(first).not.toBeNull();

        const second = windows.consumePendingEmbeddedTextUpdates();
        expect(second).toBeNull();
    });

    it('sets saveMode to embedded when auto path fails without force', () => {
        const comment = createComment();
        const {
            deps,
            windows,
        } = createHarness(comment);

        deps.updateAnnotationCommentInViewer.mockReturnValue(false);

        windows.handleOpenAnnotationNote(comment);
        const note = windows.findAnnotationNoteWindow('note-1:0');
        if (!note) {
            return;
        }
        note.text = 'Changed';
        const saved = windows.persistAnnotationNote('note-1:0', false);

        expect(saved).toBe(true);
        expect(note.saveMode).toBe('embedded');
        expect(windows.consumePendingEmbeddedTextUpdates()).toBeNull();
    });

    it('closes an open note window when its backing annotation disappears from a ready sync', async () => {
        const comment = createComment();
        const {
            deps,
            windows,
        } = createHarness(comment);

        windows.handleOpenAnnotationNote(comment);
        const note = windows.findAnnotationNoteWindow('note-1:0');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }
        note.createdAtMs = Date.now() - 10_000;

        deps.annotationComments.value = [];
        await nextTick();

        expect(windows.findAnnotationNoteWindow('note-1:0')).toBeNull();
    });

    it('keeps a freshly opened note window while annotation sync catches up', async () => {
        const comment = createComment();
        const {
            deps,
            windows,
        } = createHarness(comment);

        windows.handleOpenAnnotationNote(comment);

        deps.annotationComments.value = [];
        await nextTick();

        expect(windows.findAnnotationNoteWindow('note-1:0')).not.toBeNull();
    });

    it('keeps a dirty note window when annotation sync temporarily misses it', async () => {
        const comment = createComment();
        const {
            deps,
            windows,
        } = createHarness(comment);

        windows.handleOpenAnnotationNote(comment);
        const note = windows.findAnnotationNoteWindow('note-1:0');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }
        note.createdAtMs = Date.now() - 10_000;
        windows.updateAnnotationNoteText('note-1:0', 'Unsynced typed note');

        deps.annotationComments.value = [];
        await nextTick();

        expect(windows.findAnnotationNoteWindow('note-1:0')).not.toBeNull();
    });

    it('keeps an open note window during transient document reload sync gaps', async () => {
        const comment = createComment();
        const {
            deps,
            windows,
        } = createHarness(comment);
        deps.isAnnotationCommentSyncReady.mockReturnValue(false);

        windows.handleOpenAnnotationNote(comment);

        deps.annotationComments.value = [];
        await nextTick();

        expect(windows.findAnnotationNoteWindow('note-1:0')).not.toBeNull();
    });

    it('adds locally saved new note comments to the annotation cache for serialization replay', () => {
        const comment = createComment({
            id: 'editor:0:pdfjs_internal_editor_0',
            stableKey: 'uid:0:pdfjs_internal_editor_0',
            annotationId: null,
            uid: 'pdfjs_internal_editor_0',
            source: 'editor',
            text: '',
            subtype: 'FreeText',
            markerRect: {
                left: 0.2,
                top: 0.2,
                width: 0.01,
                height: 0.01,
            },
        });
        const {
            deps,
            windows,
        } = createHarness(comment);
        deps.annotationComments.value = [];

        windows.handleOpenAnnotationNote(comment);
        const note = windows.findAnnotationNoteWindow('uid:0:pdfjs_internal_editor_0');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }

        note.text = 'Replayable new note text';
        const saved = windows.persistAnnotationNote('uid:0:pdfjs_internal_editor_0', true);

        expect(saved).toBe(true);
        expect(deps.annotationComments.value).toContainEqual(expect.objectContaining({
            stableKey: 'uid:0:pdfjs_internal_editor_0',
            text: 'Replayable new note text',
            hasNote: true,
            markerRect: comment.markerRect,
        }));
    });

    it('keeps existing PDF notes when forced-saving a new editor note with a recycled runtime id', async () => {
        const existingPdfNote = createComment({
            id: '13275R',
            stableKey: 'ann:0:13275R',
            annotationId: '13275R',
            uid: null,
            source: 'pdf',
            text: 'existing embedded note',
            subtype: 'FreeText',
            markerRect: {
                left: 0.78,
                top: 0.08,
                width: 0.0016,
                height: 0.0016,
            },
        });
        const newEditorNote = createComment({
            id: 'pdfjs_internal_editor_0',
            stableKey: 'uid:0:pdfjs_internal_editor_0',
            annotationId: null,
            uid: 'pdfjs_internal_editor_0',
            source: 'editor',
            text: 'new editor note',
            subtype: 'Typewriter',
            markerRect: {
                left: 0.72,
                top: 0.24,
                width: 0.0016,
                height: 0.0016,
            },
        });
        const {
            deps,
            windows,
        } = createHarness(existingPdfNote);
        deps.annotationComments.value = [
            existingPdfNote,
            newEditorNote,
        ];

        windows.handleOpenAnnotationNote(newEditorNote);
        const note = windows.findAnnotationNoteWindow('uid:0:pdfjs_internal_editor_0');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }

        note.text = 'saved new editor note';
        const saved = await windows.persistAllAnnotationNotes(true);

        expect(saved).toBe(true);
        expect(windows.consumePendingEmbeddedTextUpdates()).toBeNull();
        expect(deps.annotationComments.value).toEqual(expect.arrayContaining([
            expect.objectContaining({
                stableKey: 'ann:0:13275R',
                text: 'existing embedded note',
                source: 'pdf',
            }),
            expect.objectContaining({
                stableKey: 'uid:0:pdfjs_internal_editor_0',
                text: 'saved new editor note',
                source: 'editor',
            }),
        ]));
    });

    it('preserves the latest marker rect when forced save races a stale open note window', async () => {
        const originalRect = {
            left: 0.2,
            top: 0.2,
            width: 0.0016,
            height: 0.0016,
        };
        const movedRect = {
            left: 0.42,
            top: 0.31,
            width: 0.0016,
            height: 0.0016,
        };
        const original = createComment({
            text: 'Open note text',
            markerRect: originalRect,
            modifiedAt: 100,
        });
        const moved = createComment({
            text: 'Open note text',
            markerRect: movedRect,
            modifiedAt: 200,
        });
        const {
            deps,
            windows,
        } = createHarness(original);

        windows.handleOpenAnnotationNote(original);
        deps.annotationComments.value = [moved];

        const saved = await windows.persistAllAnnotationNotes(true);

        expect(saved).toBe(true);
        expect(deps.annotationComments.value[0]?.markerRect).toEqual(movedRect);
        expect(deps.updateAnnotationCommentInViewer).not.toHaveBeenCalled();
    });

    it('does not retarget a fresh transient note window to an unrelated same-page annotation by text only', async () => {
        const transient = createComment({
            id: 'editor:0:pdfjs_internal_editor_0',
            stableKey: 'uid:0:pdfjs_internal_editor_0',
            annotationId: null,
            uid: 'pdfjs_internal_editor_0',
            source: 'editor',
            text: 'Same visible note text',
            subtype: 'FreeText',
            markerRect: {
                left: 0.58,
                top: 0.2,
                width: 0.001,
                height: 0.001,
            },
        });
        const unrelated = createComment({
            id: '4860R',
            stableKey: 'ann:0:4860R',
            annotationId: '4860R',
            uid: null,
            source: 'pdf',
            text: 'Same visible note text',
            subtype: 'Text',
            markerRect: {
                left: 0.2,
                top: 0.1,
                width: 0.001,
                height: 0.001,
            },
        });
        const {
            deps,
            windows,
        } = createHarness(transient);

        windows.handleOpenAnnotationNote(transient);
        deps.annotationComments.value = [unrelated];
        await nextTick();

        expect(windows.findAnnotationNoteWindow('uid:0:pdfjs_internal_editor_0')).not.toBeNull();
        expect(windows.findAnnotationNoteWindow('ann:0:4860R')).toBeNull();
    });

    it('keeps distinct same-source note windows separate even when their markers are nearby', () => {
        const first = createComment({
            id: 'editor:0:pdfjs_internal_editor_0',
            stableKey: 'uid:0:pdfjs_internal_editor_0',
            annotationId: null,
            uid: 'pdfjs_internal_editor_0',
            source: 'editor',
            text: '',
            subtype: 'FreeText',
            markerRect: {
                left: 0.5,
                top: 0.5,
                width: 0.001,
                height: 0.001,
            },
        });
        const second = createComment({
            id: 'editor:0:pdfjs_internal_editor_1',
            stableKey: 'uid:0:pdfjs_internal_editor_1',
            annotationId: null,
            uid: 'pdfjs_internal_editor_1',
            source: 'editor',
            text: '',
            subtype: 'FreeText',
            markerRect: {
                left: 0.504,
                top: 0.504,
                width: 0.001,
                height: 0.001,
            },
        });
        const { windows } = createHarness(first);

        windows.handleOpenAnnotationNote(first);
        windows.handleOpenAnnotationNote(second);

        expect(windows.annotationNoteWindows.value).toHaveLength(2);
        expect(windows.findAnnotationNoteWindow('uid:0:pdfjs_internal_editor_0')).not.toBeNull();
        expect(windows.findAnnotationNoteWindow('uid:0:pdfjs_internal_editor_1')).not.toBeNull();
        expect(windows.annotationNotePositions.value['uid:0:pdfjs_internal_editor_1']?.y).toBeGreaterThanOrEqual(
            (windows.annotationNotePositions.value['uid:0:pdfjs_internal_editor_0']?.y ?? 0) + 32,
        );
    });

    it('matches an open note to its persisted annotation summary during explicit delete cleanup', () => {
        const markerRect = {
            left: 0.42,
            top: 0.24,
            width: 0.01,
            height: 0.01,
        };
        const openEditorNote = createComment({
            id: 'editor:0:pdfjs_internal_editor_0',
            stableKey: 'uid:0:pdfjs_internal_editor_0',
            annotationId: null,
            uid: 'pdfjs_internal_editor_0',
            source: 'editor',
            text: 'Unsaved note window text',
            subtype: 'FreeText',
            markerRect,
        });
        const persistedDeleteSummary = createComment({
            id: '3856R',
            stableKey: 'ann:0:3856R',
            annotationId: '3856R',
            uid: null,
            source: 'pdf',
            text: '',
            subtype: 'FreeText',
            markerRect,
        });
        const { windows } = createHarness(openEditorNote);

        windows.handleOpenAnnotationNote(openEditorNote);
        const note = windows.findAnnotationNoteWindow('uid:0:pdfjs_internal_editor_0');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }
        note.text = 'Dirty text that should not keep a deleted note alive';

        expect(windows.isSameAnnotationComment(note.comment, persistedDeleteSummary)).toBe(true);
    });

    it('migrates a transient note window to a persisted PDF note at the same placement', async () => {
        const transient = createComment({
            id: 'editor:0:pdfjs_internal_editor_0',
            stableKey: 'uid:0:pdfjs_internal_editor_0',
            annotationId: null,
            uid: 'pdfjs_internal_editor_0',
            source: 'editor',
            text: 'Placed note text',
            subtype: 'FreeText',
            markerRect: {
                left: 0.58,
                top: 0.2,
                width: 0.001,
                height: 0.001,
            },
        });
        const persisted = createComment({
            id: '9999R',
            stableKey: 'ann:0:9999R',
            annotationId: '9999R',
            uid: null,
            source: 'pdf',
            text: 'Placed note text',
            subtype: 'Text',
            markerRect: {
                left: 0.5805,
                top: 0.2005,
                width: 0.001,
                height: 0.001,
            },
        });
        const {
            deps,
            windows,
        } = createHarness(transient);

        windows.handleOpenAnnotationNote(transient);
        deps.annotationComments.value = [persisted];
        await nextTick();

        expect(windows.findAnnotationNoteWindow('uid:0:pdfjs_internal_editor_0')).toBeNull();
        expect(windows.findAnnotationNoteWindow('ann:0:9999R')).not.toBeNull();
    });
});
