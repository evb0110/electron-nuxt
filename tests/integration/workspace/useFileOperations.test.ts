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

    const serializePdfForSave = vi.fn(async (data: Uint8Array) => data);

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
        readWorkingCopyBytes: vi.fn(async () => new Uint8Array([
            1,
            2,
            3,
        ])),
        validatePdfData: vi.fn(async () => ({
            isValid: true,
            tool: 'qpdf' as const,
            errors: [],
            warnings: [],
        })),
        saveFile: vi.fn(async () => ({
            success: true,
            outPath: '/tmp/working.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        })),
        saveWorkingCopy: vi.fn(async () => ({
            success: true,
            outPath: '/tmp/working.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        })),
        saveWorkingCopyAs: vi.fn(async () => ({
            success: true,
            outPath: '/tmp/exported.pdf',
            saveMode: 'save_as_rewrite' as const,
            didSaveAs: true,
        })),
        markAnnotationSaved: vi.fn(),
        markPageLabelsSaved: vi.fn(),
        markBookmarksSaved: vi.fn(),
        hasAnnotationChanges: vi.fn(() => false),
        serializePdfForSave,
        persistAllAnnotationNotes: vi.fn(async () => true),
        consumePendingEmbeddedTextUpdates: vi.fn(() => null),
        consumePendingEmbeddedAnnotationDeletes: vi.fn(() => null),
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
        expect(deps.serializePdfForSave).toHaveBeenCalledOnce();
        expect(deps.saveFile).toHaveBeenCalledOnce();
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expect(annotationReset).toHaveBeenCalledOnce();
        expect(deps.markAnnotationSaved).toHaveBeenCalledOnce();
        expect(deps.markPageLabelsSaved).toHaveBeenCalledOnce();
        expect(deps.markBookmarksSaved).toHaveBeenCalledOnce();
        expect(deps.isSaving.value).toBe(false);
        expect(deps.validatePdfData).toHaveBeenCalledOnce();
    });

    it('uses working-copy save path when no serialized changes exist', async () => {
        const { deps } = createDeps();

        const { handleSave } = useFileOperations(deps);
        await handleSave();

        expect(deps.saveWorkingCopy).toHaveBeenCalledOnce();
        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.saveFile).not.toHaveBeenCalled();
        expect(deps.readWorkingCopyBytes).toHaveBeenCalledOnce();
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
        expect(deps.validatePdfData).toHaveBeenCalledOnce();
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

    it('stops before persisting when validation fails', async () => {
        const { deps } = createDeps();
        deps.annotationDirty.value = true;
        deps.validatePdfData = vi.fn(async () => ({
            isValid: false,
            tool: 'qpdf' as const,
            errors: ['invalid'],
            warnings: [],
        }));

        const { handleSave } = useFileOperations(deps);
        await handleSave();

        expect(deps.saveFile).not.toHaveBeenCalled();
        expect(deps.markAnnotationSaved).not.toHaveBeenCalled();
    });
});
