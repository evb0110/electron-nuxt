import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { usePageFileOperations } from '@app/modules/workspace-shell/composables/usePageFileOperations';
import { BrowserLogger } from '@app/utils/browserLogger';

const {
    mockHasElectronAPI,
    mockOpenCombineDialog,
    mockReadFileRange,
} = vi.hoisted(() => ({
    mockHasElectronAPI: vi.fn(() => true),
    mockOpenCombineDialog: vi.fn(async (): Promise<unknown> => null),
    mockReadFileRange: vi.fn(async (_path: string, _offset: number, _length: number): Promise<Uint8Array> => new Uint8Array([0])),
}));

vi.mock('@app/utils/platform', () => ({hasElectronAPI: () => mockHasElectronAPI()}));
vi.mock('@app/utils/platformDocuments', () => ({getDocumentsCapability: () => ({
    openCombineDialog: mockOpenCombineDialog,
    readFileRange: mockReadFileRange,
})}));

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
        removeRecentFile: vi.fn(async () => {}),
        notifyMissingRecentFile: vi.fn(),
        ...overrides,
    });
}

describe('usePageFileOperations', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mockHasElectronAPI.mockReturnValue(true);
        mockOpenCombineDialog.mockReset();
        mockOpenCombineDialog.mockResolvedValue(null);
        mockReadFileRange.mockReset();
        mockReadFileRange.mockResolvedValue(new Uint8Array([0]));
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

    it('removes a missing recent file and notifies instead of opening it', async () => {
        const warnSpy = vi.spyOn(BrowserLogger, 'warn').mockImplementation(() => {});
        mockReadFileRange.mockRejectedValueOnce(new Error('ENOENT: no such file or directory'));
        const deps = createDeps();
        const { openRecentFile } = usePageFileOperations(deps);
        const file = {
            originalPath: '/tmp/missing.pdf',
            fileName: 'missing.pdf',
            timestamp: 0,
            fileSize: 0,
        };

        await openRecentFile(file);

        expect(deps.openFileDirect).not.toHaveBeenCalled();
        expect(deps.removeRecentFile).toHaveBeenCalledWith(file);
        expect(deps.notifyMissingRecentFile).toHaveBeenCalledWith(file);
        expect(warnSpy).toHaveBeenCalledWith(
            'recent-open',
            'Recent file no longer exists; removing from recents',
            {path: '/tmp/missing.pdf'},
        );
    });

    it('removes a recent whose browser storage chunks were evicted', async () => {
        mockReadFileRange.mockRejectedValueOnce(new Error('Browser document chunk missing: browser://documents/uuid/file.pdf#0'));
        const deps = createDeps();
        const { openRecentFile } = usePageFileOperations(deps);
        const file = {
            originalPath: 'browser://documents/uuid/file.pdf',
            fileName: 'file.pdf',
            timestamp: 0,
            fileSize: 32_000_000,
        };

        await openRecentFile(file);

        expect(deps.openFileDirect).not.toHaveBeenCalled();
        expect(deps.removeRecentFile).toHaveBeenCalledWith(file);
        expect(deps.notifyMissingRecentFile).toHaveBeenCalledWith(file);
    });

    it('opens a present recent file without removing or notifying', async () => {
        mockReadFileRange.mockResolvedValueOnce(new Uint8Array([37]));
        const deps = createDeps();
        const { openRecentFile } = usePageFileOperations(deps);
        const file = {
            originalPath: '/tmp/present.pdf',
            fileName: 'present.pdf',
            timestamp: 0,
            fileSize: 4096,
        };

        await openRecentFile(file);

        expect(mockReadFileRange).toHaveBeenCalledWith('/tmp/present.pdf', 0, 1);
        expect(deps.openFileDirect).toHaveBeenCalledWith('/tmp/present.pdf');
        expect(deps.removeRecentFile).not.toHaveBeenCalled();
        expect(deps.notifyMissingRecentFile).not.toHaveBeenCalled();
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
