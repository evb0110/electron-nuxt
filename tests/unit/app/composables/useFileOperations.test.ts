import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import { useFileOperations } from '@app/composables/useFileOperations';

function cast<T>(value: unknown): T {
    return value as T;
}

function createDeps(overrides: Partial<Parameters<typeof useFileOperations>[0]> = {}) {
    const resetModified = vi.fn();
    const saveFile = vi.fn(async (_data: Uint8Array) => true);
    const saveWorkingCopyAs = vi.fn(async (_data?: Uint8Array) => '/tmp/new.pdf');

    return {
        deps: cast<Parameters<typeof useFileOperations>[0]>({
            isSaving: ref(false),
            isSavingAs: ref(false),
            workingCopyPath: ref('/tmp/work.pdf'),
            annotationDirty: ref(false),
            pageLabelsDirty: ref(false),
            bookmarksDirty: ref(false),
            pdfDocument: shallowRef(cast({ annotationStorage: { resetModified } })),
            saveDocument: vi.fn(async () => new Uint8Array([1])),
            saveFile,
            saveWorkingCopy: vi.fn(async () => true),
            saveWorkingCopyAs,
            markAnnotationSaved: vi.fn(),
            markPageLabelsSaved: vi.fn(),
            markBookmarksSaved: vi.fn(),
            hasAnnotationChanges: vi.fn(() => false),
            rewriteMarkupSubtypes: vi.fn(async (data: Uint8Array) => new Uint8Array([
                ...data,
                2,
            ])),
            serializeShapeAnnotations: vi.fn(async (data: Uint8Array) => new Uint8Array([
                ...data,
                3,
            ])),
            rewritePageLabels: vi.fn(async (data: Uint8Array) => new Uint8Array([
                ...data,
                4,
            ])),
            rewriteBookmarks: vi.fn(async (data: Uint8Array) => new Uint8Array([
                ...data,
                5,
            ])),
            persistAllAnnotationNotes: vi.fn(async (_force: boolean) => true),
            annotationNoteWindowsCount: ref(0),
            loadRecentFiles: vi.fn(),
            ...overrides,
        }),
        resetModified,
        saveFile,
        saveWorkingCopyAs,
    };
}

describe('useFileOperations', () => {
    it('serializes and saves when working copy has pending annotation-related changes', async () => {
        const {
            deps,
            resetModified,
            saveFile,
        } = createDeps({annotationDirty: ref(true)});
        const { handleSave } = useFileOperations(deps);

        await handleSave();

        expect(deps.saveDocument).toHaveBeenCalledOnce();
        expect(deps.rewriteMarkupSubtypes).toHaveBeenCalledOnce();
        expect(deps.serializeShapeAnnotations).toHaveBeenCalledOnce();
        expect(deps.rewritePageLabels).toHaveBeenCalledOnce();
        expect(deps.rewriteBookmarks).toHaveBeenCalledOnce();
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expect(saveFile).toHaveBeenCalledOnce();
        expect(Array.from(saveFile.mock.calls[0]?.[0] ?? [])).toEqual([
            1,
            2,
            3,
            4,
            5,
        ]);
        expect(resetModified).toHaveBeenCalledOnce();
        expect(deps.markAnnotationSaved).toHaveBeenCalledOnce();
        expect(deps.markPageLabelsSaved).toHaveBeenCalledOnce();
        expect(deps.markBookmarksSaved).toHaveBeenCalledOnce();
        expect(deps.isSaving.value).toBe(false);
    });

    it('saves working copy directly when no serialization work is required', async () => {
        const { deps } = createDeps();
        const { handleSave } = useFileOperations(deps);

        await handleSave();

        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.saveWorkingCopy).toHaveBeenCalledOnce();
        expect(deps.markAnnotationSaved).toHaveBeenCalledOnce();
        expect(deps.markPageLabelsSaved).toHaveBeenCalledOnce();
        expect(deps.markBookmarksSaved).toHaveBeenCalledOnce();
    });

    it('serializes on save-as and refreshes recent files when path is returned', async () => {
        const {
            deps,
            resetModified,
            saveWorkingCopyAs,
        } = createDeps({annotationDirty: ref(true)});
        const { handleSaveAs } = useFileOperations(deps);

        await handleSaveAs();

        expect(deps.saveDocument).toHaveBeenCalledOnce();
        expect(deps.rewriteMarkupSubtypes).toHaveBeenCalledOnce();
        expect(deps.serializeShapeAnnotations).toHaveBeenCalledOnce();
        expect(deps.rewritePageLabels).toHaveBeenCalledOnce();
        expect(deps.rewriteBookmarks).toHaveBeenCalledOnce();
        expect(saveWorkingCopyAs).toHaveBeenCalledOnce();
        expect(Array.from(saveWorkingCopyAs.mock.calls[0]?.[0] ?? [])).toEqual([
            1,
            2,
            3,
            4,
            5,
        ]);
        expect(resetModified).toHaveBeenCalledOnce();
        expect(deps.loadRecentFiles).toHaveBeenCalledOnce();
        expect(deps.isSavingAs.value).toBe(false);
    });

    it('aborts save early when note windows cannot be persisted', async () => {
        const { deps } = createDeps({
            annotationNoteWindowsCount: ref(2),
            persistAllAnnotationNotes: vi.fn(async () => false),
        });
        const { handleSave } = useFileOperations(deps);

        await handleSave();

        expect(deps.persistAllAnnotationNotes).toHaveBeenCalledWith(true);
        expect(deps.saveDocument).not.toHaveBeenCalled();
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expect(deps.isSaving.value).toBe(false);
    });
});
