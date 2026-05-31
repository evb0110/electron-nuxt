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
import { cast } from '@tests/helpers/cast';

const toastAddMock = vi.fn();

vi.stubGlobal('useToast', () => ({ add: toastAddMock }));

function createDeps() {
    const pdfDocument = shallowRef<PDFDocumentProxy | null>(cast({annotationStorage: {resetModified: vi.fn()}}));

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

    return { deps };
}

describe('useFileOperations', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        toastAddMock.mockClear();
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
