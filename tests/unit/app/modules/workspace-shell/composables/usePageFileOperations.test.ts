import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { usePageFileOperations } from '@app/modules/workspace-shell/composables/usePageFileOperations';
import { BrowserLogger } from '@app/utils/browser-logger';

const { mockHasElectronAPI } = vi.hoisted(() => ({mockHasElectronAPI: vi.fn(() => true)}));

vi.mock('@app/utils/electron', () => ({hasElectronAPI: () => mockHasElectronAPI()}));

function cast<T>(obj: unknown): T {
    return obj as T;
}

function createDeps(overrides: Partial<Parameters<typeof usePageFileOperations>[0]> = {}) {
    return cast<Parameters<typeof usePageFileOperations>[0]>({
        pdfSrc: ref<unknown>({}),
        isAnySaving: ref(false),
        isHistoryBusy: ref(false),
        isExportingDocx: ref(false),
        isAnyAnnotationNoteSaving: ref(false),
        annotationNoteWindows: ref([]),
        annotationDirty: ref(false),
        isDirty: ref(false),
        pageLabelsDirty: ref(false),
        bookmarksDirty: ref(false),
        hasAnnotationChanges: vi.fn(() => false),
        persistAllAnnotationNotes: vi.fn(async (_force: boolean) => true),
        handleSave: vi.fn(async () => {}),
        pickFileToOpen: vi.fn(async () => null),
        openFile: vi.fn(async () => {}),
        openFileDirect: vi.fn(async (_path: string) => {}),
        openFileDirectBatch: vi.fn(async (_paths: string[]) => {}),
        closeFile: vi.fn(async () => {}),
        closeAllDropdowns: vi.fn(),
        emitOpenInNewTab: vi.fn(),
        ...overrides,
    });
}

describe('usePageFileOperations', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mockHasElectronAPI.mockReturnValue(true);
    });

    it('persists unsaved changes before closing by default', async () => {
        const isDirty = ref(true);
        const deps = createDeps({
            isDirty,
            handleSave: vi.fn(async () => {
                isDirty.value = false;
            }),
        });
        const { handleCloseFileFromUi } = usePageFileOperations(deps);

        await handleCloseFileFromUi();

        expect(deps.handleSave).toHaveBeenCalledOnce();
        expect(deps.closeFile).toHaveBeenCalledOnce();
        expect(deps.closeAllDropdowns).toHaveBeenCalledOnce();
    });

    it('can close without persisting when persist is false', async () => {
        const deps = createDeps({ isDirty: ref(true) });
        const { handleCloseFileFromUi } = usePageFileOperations(deps);

        await handleCloseFileFromUi({ persist: false });

        expect(deps.handleSave).not.toHaveBeenCalled();
        expect(deps.closeFile).toHaveBeenCalledOnce();
        expect(deps.closeAllDropdowns).toHaveBeenCalledOnce();
    });

    it('handles save rejection deterministically before opening another file', async () => {
        const errorSpy = vi.spyOn(BrowserLogger, 'error').mockImplementation(() => {});
        const deps = createDeps({
            isDirty: ref(true),
            handleSave: vi.fn(async () => {
                throw new Error('disk full');
            }),
        });
        const { handleOpenFileFromUi } = usePageFileOperations(deps);

        await expect(handleOpenFileFromUi()).resolves.toBeUndefined();

        expect(deps.pickFileToOpen).not.toHaveBeenCalled();
        expect(deps.openFile).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(
            'recent-open',
            'Switch blocked: save before switch threw',
            { error: 'disk full' },
        );
    });

    it('opens through openFile directly in browser mode', async () => {
        mockHasElectronAPI.mockReturnValue(false);
        const deps = createDeps();
        const { handleOpenFileFromUi } = usePageFileOperations(deps);

        await expect(handleOpenFileFromUi()).resolves.toBeUndefined();

        expect(deps.pickFileToOpen).not.toHaveBeenCalled();
        expect(deps.openFile).toHaveBeenCalledOnce();
        expect(deps.closeAllDropdowns).toHaveBeenCalledOnce();
    });

    it('blocks close when save throws instead of bubbling an uncaught rejection', async () => {
        const errorSpy = vi.spyOn(BrowserLogger, 'error').mockImplementation(() => {});
        const deps = createDeps({
            isDirty: ref(true),
            handleSave: vi.fn(async () => {
                throw new Error('cannot save');
            }),
        });
        const { handleCloseFileFromUi } = usePageFileOperations(deps);

        await expect(handleCloseFileFromUi()).resolves.toBeUndefined();

        expect(deps.closeFile).not.toHaveBeenCalled();
        expect(deps.closeAllDropdowns).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(
            'recent-open',
            'Switch blocked: save before switch threw',
            { error: 'cannot save' },
        );
    });
});
