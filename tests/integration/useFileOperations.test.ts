import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useFileOperations } from '@app/composables/useFileOperations';

function cast<T>(value: unknown): T {
    return value as T;
}

function createDeps() {
    const annotationReset = vi.fn();
    const pdfDocument = shallowRef<PDFDocumentProxy | null>(cast({annotationStorage: {resetModified: annotationReset}}));

    const rewriteMarkupSubtypes = vi.fn(async (data: Uint8Array) => data);
    const serializeShapeAnnotations = vi.fn(async (data: Uint8Array) => data);
    const rewriteFreeTextNoteRects = vi.fn(async (data: Uint8Array) => data);
    const rewritePageLabels = vi.fn(async (data: Uint8Array) => data);
    const rewriteBookmarks = vi.fn(async (data: Uint8Array) => data);

    const deps: Parameters<typeof useFileOperations>[0] = {
        isSaving: ref(false),
        isSavingAs: ref(false),
        workingCopyPath: ref('/tmp/working.pdf'),
        annotationDirty: ref(false),
        pageLabelsDirty: ref(false),
        bookmarksDirty: ref(false),
        pdfDocument,
        saveDocument: vi.fn(async () => new Uint8Array([
            1,
            2,
            3,
        ])),
        saveFile: vi.fn(async () => true),
        saveWorkingCopy: vi.fn(async () => true),
        saveWorkingCopyAs: vi.fn(async () => '/tmp/exported.pdf'),
        markAnnotationSaved: vi.fn(),
        markPageLabelsSaved: vi.fn(),
        markBookmarksSaved: vi.fn(),
        hasAnnotationChanges: vi.fn(() => false),
        rewriteMarkupSubtypes,
        serializeShapeAnnotations,
        rewriteFreeTextNoteRects,
        rewritePageLabels,
        rewriteBookmarks,
        persistAllAnnotationNotes: vi.fn(async () => true),
        annotationNoteWindowsCount: ref(0),
        loadRecentFiles: vi.fn(),
    };

    return {
        deps,
        annotationReset,
    };
}

describe('useFileOperations', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('serializes and saves document when there are unsaved annotation/page/bookmark changes', async () => {
        const {
            deps,
            annotationReset,
        } = createDeps();
        deps.annotationDirty.value = true;

        const { handleSave } = useFileOperations(deps);
        await handleSave();

        expect(deps.saveDocument).toHaveBeenCalledOnce();
        expect(deps.rewriteMarkupSubtypes).toHaveBeenCalledOnce();
        expect(deps.serializeShapeAnnotations).toHaveBeenCalledOnce();
        expect(deps.rewritePageLabels).toHaveBeenCalledOnce();
        expect(deps.rewriteBookmarks).toHaveBeenCalledOnce();
        expect(deps.saveFile).toHaveBeenCalledOnce();
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expect(annotationReset).toHaveBeenCalledOnce();
        expect(deps.markAnnotationSaved).toHaveBeenCalledOnce();
        expect(deps.markPageLabelsSaved).toHaveBeenCalledOnce();
        expect(deps.markBookmarksSaved).toHaveBeenCalledOnce();
        expect(deps.isSaving.value).toBe(false);
    });

    it('uses working-copy save path when no serialized changes exist', async () => {
        const { deps } = createDeps();

        const { handleSave } = useFileOperations(deps);
        await handleSave();

        expect(deps.saveWorkingCopy).toHaveBeenCalledOnce();
        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.saveFile).not.toHaveBeenCalled();
        expect(deps.markAnnotationSaved).toHaveBeenCalledOnce();
    });

    it('runs Save As with serialization and reloads recent files on success', async () => {
        const {
            deps,
            annotationReset,
        } = createDeps();
        deps.pageLabelsDirty.value = true;

        const { handleSaveAs } = useFileOperations(deps);
        await handleSaveAs();

        expect(deps.saveDocument).toHaveBeenCalledOnce();
        expect(deps.saveWorkingCopyAs).toHaveBeenCalledOnce();
        expect(annotationReset).toHaveBeenCalledOnce();
        expect(deps.loadRecentFiles).toHaveBeenCalledOnce();
        expect(deps.isSavingAs.value).toBe(false);
    });

    it('aborts save when note persistence fails', async () => {
        const { deps } = createDeps();
        deps.annotationNoteWindowsCount.value = 2;
        deps.persistAllAnnotationNotes = vi.fn(async () => false);

        const { handleSave } = useFileOperations(deps);
        await handleSave();

        expect(deps.persistAllAnnotationNotes).toHaveBeenCalledWith(true);
        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expect(deps.isSaving.value).toBe(false);
    });
});
