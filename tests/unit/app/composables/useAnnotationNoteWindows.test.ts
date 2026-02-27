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
        updateEmbeddedAnnotationByRef: vi.fn<
            (comment: IAnnotationCommentSummary, text: string) => Promise<Uint8Array | false>
        >(async () => false as Uint8Array | false),
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

    it('materializes and rematches to embedded ref when editor-only note has no live editor handle', async () => {
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
        deps.serializeCurrentPdfForEmbeddedFallback.mockImplementation(async () => {
            deps.annotationComments.value = [
                comment,
                createComment({
                    id: '17R',
                    stableKey: 'ann:0:17R',
                    source: 'pdf',
                    annotationId: '17R',
                    uid: null,
                    text: '',
                }),
            ];
            return true;
        });
        deps.updateEmbeddedAnnotationByRef.mockImplementation(async (target, text) => {
            if (target.annotationId === '17R' && text === 'Unsaved sticky note text') {
                return new Uint8Array([
                    1,
                    2,
                    3,
                ]);
            }
            return false;
        });
        windows.handleOpenAnnotationNote(comment);
        const note = windows.findAnnotationNoteWindow('uid:0:pdfjs_internal_editor_0');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }

        note.text = 'Unsaved sticky note text';
        const saved = await windows.persistAnnotationNote('uid:0:pdfjs_internal_editor_0', true);

        expect(saved).toBe(true);
        expect(deps.serializeCurrentPdfForEmbeddedFallback).toHaveBeenCalledTimes(1);
        expect(deps.updateEmbeddedAnnotationByRef).toHaveBeenCalledWith(
            expect.objectContaining({
                annotationId: '17R',
                source: 'pdf',
            }),
            'Unsaved sticky note text',
        );
        expect(deps.loadPdfFromData).toHaveBeenCalledTimes(1);
    });

    it('uses heuristic embedded ref resolution after materialization when no explicit ref is available', async () => {
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
        deps.serializeCurrentPdfForEmbeddedFallback.mockResolvedValue(true);
        deps.updateEmbeddedAnnotationByRef.mockImplementation(async (target, text) => {
            if (
                target.stableKey === 'uid:0:pdfjs_internal_editor_0'
                && target.annotationId === null
                && text === 'Unsaved sticky note text'
            ) {
                return new Uint8Array([
                    1,
                    2,
                    3,
                ]);
            }
            return false;
        });

        windows.handleOpenAnnotationNote(comment);
        const note = windows.findAnnotationNoteWindow('uid:0:pdfjs_internal_editor_0');
        expect(note).not.toBeNull();
        if (!note) {
            return;
        }

        note.text = 'Unsaved sticky note text';
        const saved = await windows.persistAnnotationNote('uid:0:pdfjs_internal_editor_0', true);

        expect(saved).toBe(true);
        expect(deps.serializeCurrentPdfForEmbeddedFallback).toHaveBeenCalledTimes(1);
        expect(deps.updateEmbeddedAnnotationByRef).toHaveBeenCalledWith(
            expect.objectContaining({
                stableKey: 'uid:0:pdfjs_internal_editor_0',
                annotationId: null,
                source: 'editor',
            }),
            'Unsaved sticky note text',
        );
        expect(deps.loadPdfFromData).toHaveBeenCalledTimes(1);
    });
});
