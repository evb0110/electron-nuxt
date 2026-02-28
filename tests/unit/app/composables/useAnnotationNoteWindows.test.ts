import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
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
        const { windows } = createHarness();

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
    });

    it('defers embedded text update to serialization pipeline when auto path fails', () => {
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
        expect(note.saveMode).toBe('embedded');
        expect(note.lastSavedText).toBe('Unsaved sticky note text');

        const pending = windows.consumePendingEmbeddedTextUpdates();
        expect(pending).not.toBeNull();
        expect(pending!.get('uid:0:pdfjs_internal_editor_0')).toBe('Unsaved sticky note text');
    });

    it('returns null from consumePendingEmbeddedTextUpdates when nothing is pending', () => {
        const { windows } = createHarness();

        const pending = windows.consumePendingEmbeddedTextUpdates();
        expect(pending).toBeNull();
    });

    it('clears pending updates after consume', () => {
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
        windows.persistAnnotationNote('note-1:0', true);

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
});
