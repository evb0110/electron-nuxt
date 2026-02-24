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
        updateAnnotationCommentInViewer: vi.fn(() => true),
        updateEmbeddedAnnotationByRef: vi.fn(async () => false as Uint8Array | false),
        serializeCurrentPdfForEmbeddedFallback: vi.fn(async () => true),
        loadPdfFromData: vi.fn(async () => {}),
        workingCopyPath: ref<string | null>('/tmp/working.pdf'),
        currentPage: ref(1),
        waitForPdfReload: vi.fn(async () => {}),
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

        const saved = await windows.persistAnnotationNote('note-1:0', true);

        expect(saved).toBe(true);
        expect(deps.updateAnnotationCommentInViewer).not.toHaveBeenCalled();
        expect(deps.serializeCurrentPdfForEmbeddedFallback).not.toHaveBeenCalled();
        expect(deps.loadPdfFromData).not.toHaveBeenCalled();
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
        const saved = await windows.persistAnnotationNote('note-1:0', true);

        expect(saved).toBe(true);
        expect(deps.updateAnnotationCommentInViewer).toHaveBeenCalledWith(
            expect.objectContaining({ stableKey: 'note-1:0' }),
            'Updated text',
        );
        expect(deps.serializeCurrentPdfForEmbeddedFallback).not.toHaveBeenCalled();
        expect(deps.loadPdfFromData).not.toHaveBeenCalled();
        expect(note.lastSavedText).toBe('Updated text');
    });
});
