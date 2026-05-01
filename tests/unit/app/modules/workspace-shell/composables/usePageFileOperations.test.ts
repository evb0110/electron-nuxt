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

const {
    mockHasElectronAPI,
    mockOpenCombineDialog,
} = vi.hoisted(() => ({
    mockHasElectronAPI: vi.fn(() => true),
    mockOpenCombineDialog: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('@app/utils/platform', () => ({hasElectronAPI: () => mockHasElectronAPI()}));
vi.mock('@app/utils/platform-documents', () => ({getDocumentsCapability: () => ({openCombineDialog: mockOpenCombineDialog})}));

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
        mockOpenCombineDialog.mockReset();
        mockOpenCombineDialog.mockResolvedValue(null);
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
        const openResult = {
            kind: 'pdf' as const,
            originalPath: 'browser://documents/source/browser-open.pdf',
            workingPath: 'browser://documents/working/browser-open.pdf',
        };
        const deps = createDeps({pickFileToOpen: vi.fn(async () => openResult)});
        const { handleOpenFileFromUi } = usePageFileOperations(deps);

        await expect(handleOpenFileFromUi()).resolves.toBeUndefined();

        expect(deps.pickFileToOpen).toHaveBeenCalledOnce();
        expect(deps.openFile).toHaveBeenCalledWith(openResult);
        expect(deps.closeAllDropdowns).toHaveBeenCalledOnce();
    });

    it('awaits the persistence gate before invoking the open picker', async () => {
        const callOrder: string[] = [];
        const isDirty = ref(true);
        const handleSave = vi.fn(async () => {
            callOrder.push('save');
            isDirty.value = false;
        });
        const pickFileToOpen = vi.fn(async () => {
            callOrder.push('pick');
            return null;
        });
        const deps = createDeps({
            isDirty,
            handleSave,
            pickFileToOpen,
        });
        const { handleOpenFileFromUi } = usePageFileOperations(deps);

        await handleOpenFileFromUi();

        expect(callOrder).toEqual([
            'save',
            'pick',
        ]);
    });

    it('returns early without closing dropdowns when the open picker is cancelled', async () => {
        const deps = createDeps({ pickFileToOpen: vi.fn(async () => null) });
        const { handleOpenFileFromUi } = usePageFileOperations(deps);

        await handleOpenFileFromUi();

        expect(deps.pickFileToOpen).toHaveBeenCalledOnce();
        expect(deps.openFile).not.toHaveBeenCalled();
        expect(deps.emitOpenInNewTab).not.toHaveBeenCalled();
        expect(deps.closeAllDropdowns).not.toHaveBeenCalled();
    });

    it('runs the full open flow and closes dropdowns after handling the result', async () => {
        const openResult = {
            kind: 'pdf' as const,
            originalPath: '/tmp/source.pdf',
            workingPath: '/tmp/working.pdf',
        };
        const deps = createDeps({ pickFileToOpen: vi.fn(async () => openResult) });
        const { handleOpenFileFromUi } = usePageFileOperations(deps);

        await handleOpenFileFromUi();

        expect(deps.openFile).toHaveBeenCalledWith(openResult);
        expect(deps.emitOpenInNewTab).not.toHaveBeenCalled();
        expect(deps.closeAllDropdowns).toHaveBeenCalledOnce();
    });

    it('returns early without closing dropdowns when combine picker is cancelled', async () => {
        mockOpenCombineDialog.mockResolvedValue(null);
        const deps = createDeps();
        const { handleCombineImages } = usePageFileOperations(deps);

        await handleCombineImages();

        expect(mockOpenCombineDialog).toHaveBeenCalledOnce();
        expect(deps.openFile).not.toHaveBeenCalled();
        expect(deps.emitOpenInNewTab).not.toHaveBeenCalled();
        expect(deps.closeAllDropdowns).not.toHaveBeenCalled();
    });

    it('opens combined generated PDF in a new tab only when pdfSrc is set', async () => {
        const generated = {
            kind: 'pdf' as const,
            originalPath: '/tmp/generated.pdf',
            workingPath: '/tmp/working.pdf',
            isGenerated: true,
        };
        mockOpenCombineDialog.mockResolvedValue(generated);

        const depsWithDoc = createDeps(cast({ pdfSrc: ref<unknown>({}) }));
        const opsWithDoc = usePageFileOperations(depsWithDoc);
        await opsWithDoc.handleCombineImages();

        expect(depsWithDoc.emitOpenInNewTab).toHaveBeenCalledWith(generated);
        expect(depsWithDoc.openFile).not.toHaveBeenCalled();
        expect(depsWithDoc.closeAllDropdowns).toHaveBeenCalledOnce();

        mockOpenCombineDialog.mockResolvedValue(generated);
        const depsNoDoc = createDeps(cast({ pdfSrc: ref<unknown>(null) }));
        const opsNoDoc = usePageFileOperations(depsNoDoc);
        await opsNoDoc.handleCombineImages();

        expect(depsNoDoc.emitOpenInNewTab).not.toHaveBeenCalled();
        expect(depsNoDoc.openFile).toHaveBeenCalledWith(generated);
        expect(depsNoDoc.closeAllDropdowns).toHaveBeenCalledOnce();
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
