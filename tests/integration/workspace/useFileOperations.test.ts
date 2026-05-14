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

const toastAddMock = vi.fn();

vi.stubGlobal('useToast', () => ({ add: toastAddMock }));

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
        annotationComments: ref([]),
        pageLabelsDirty: ref(false),
        bookmarksDirty: ref(false),
        pdfDocument,
        saveDocument: vi.fn(async () => new Uint8Array([
            1,
            2,
            3,
        ])),
        getSourcePdfData: vi.fn(async () => new Uint8Array([
            1,
            2,
            3,
        ])),
        readWorkingCopyBytes: vi.fn(async () => new Uint8Array([
            1,
            2,
            3,
        ])),
        validatePdfPath: vi.fn(async () => ({
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
        hasShapeChanges: vi.fn(() => false),
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
        toastAddMock.mockClear();
    });

    it('serializes and saves document when there are unsaved annotation/page/bookmark changes', async () => {
        const {
            deps,
            annotationReset,
        } = createDeps();
        deps.annotationDirty.value = true;

        const { handleSave } = useFileOperations(deps);
        await handleSave();

        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(deps.serializePdfForSave).toHaveBeenCalledOnce();
        expect(deps.saveFile).toHaveBeenCalledOnce();
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expect(annotationReset).toHaveBeenCalledOnce();
        expect(deps.markAnnotationSaved).toHaveBeenCalledOnce();
        expect(deps.markPageLabelsSaved).toHaveBeenCalledOnce();
        expect(deps.markBookmarksSaved).toHaveBeenCalledOnce();
        expect(deps.isSaving.value).toBe(false);
        expect(deps.validatePdfPath).not.toHaveBeenCalled();
    });

    it('uses working-copy save path when no serialized changes exist', async () => {
        const { deps } = createDeps();

        const { handleSave } = useFileOperations(deps);
        await handleSave();

        expect(deps.saveWorkingCopy).toHaveBeenCalledOnce();
        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.saveFile).not.toHaveBeenCalled();
        expect(deps.readWorkingCopyBytes).not.toHaveBeenCalled();
        expect(deps.validatePdfPath).toHaveBeenCalledOnce();
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

        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(deps.saveWorkingCopyAs).toHaveBeenCalledOnce();
        expect(annotationReset).toHaveBeenCalledOnce();
        expect(deps.loadRecentFiles).toHaveBeenCalledOnce();
        expect(deps.isSavingAs.value).toBe(false);
        expect(deps.validatePdfPath).not.toHaveBeenCalled();
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

    it('serializes note-only saves from source bytes without calling PDF.js saveDocument', async () => {
        const { deps } = createDeps();
        deps.annotationDirty.value = true;

        const { handleSave } = useFileOperations(deps);
        await handleSave();

        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.serializePdfForSave).toHaveBeenCalledOnce();
        expect(deps.saveFile).toHaveBeenCalledOnce();
    });

    it('serializes replayable editor-only notes without an annotation id from source bytes', async () => {
        const { deps } = createDeps();
        deps.annotationDirty.value = true;
        deps.annotationComments.value = [{
            id: 'editor-note-1',
            stableKey: 'editor:0:editor-note-1',
            sortIndex: null,
            pageIndex: 0,
            pageNumber: 1,
            text: 'fresh note',
            kindLabel: 'Note',
            subtype: 'FreeText',
            author: null,
            modifiedAt: Date.now(),
            color: null,
            uid: 'editor-uid-1',
            annotationId: null,
            source: 'editor',
            hasNote: true,
            markerRect: {
                left: 0.1,
                top: 0.1,
                width: 0.01,
                height: 0.01,
            },
        }];

        const { handleSave } = useFileOperations(deps);
        await handleSave();

        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(deps.saveFile).toHaveBeenCalledOnce();
    });

    it('serializes replayable editor-only notes with temporary annotation ids from source bytes', async () => {
        const { deps } = createDeps();
        deps.annotationDirty.value = true;
        deps.annotationComments.value = [{
            id: 'editor-note-2',
            stableKey: 'editor:0:editor-note-2',
            sortIndex: null,
            pageIndex: 0,
            pageNumber: 1,
            text: 'fresh note with temp id',
            kindLabel: 'Note',
            subtype: 'FreeText',
            author: null,
            modifiedAt: Date.now(),
            color: null,
            uid: 'editor-uid-2',
            annotationId: 'pdfjs_internal_editor_12',
            source: 'editor',
            hasNote: true,
            markerRect: {
                left: 0.12,
                top: 0.12,
                width: 0.01,
                height: 0.01,
            },
        }];

        const { handleSave } = useFileOperations(deps);
        await handleSave();

        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.getSourcePdfData).toHaveBeenCalledOnce();
        expect(deps.saveFile).toHaveBeenCalledOnce();
    });

    it('stops before persisting when validation fails', async () => {
        const { deps } = createDeps();
        deps.validatePdfPath = vi.fn(async () => ({
            isValid: false,
            tool: 'qpdf' as const,
            errors: ['invalid'],
            warnings: [],
        }));

        const { handleSave } = useFileOperations(deps);
        await handleSave();

        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expect(deps.markAnnotationSaved).not.toHaveBeenCalled();
    });
});
