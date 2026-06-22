import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';

const mocks = vi.hoisted(() => ({
    convertToPdf: vi.fn(),
    openFileDirect: vi.fn(),
    openFileDirectWithDjvuCleanup: vi.fn(),
}));

vi.mock('@app/modules/workspace-shell/composables/usePdfFile', () => ({usePdfFile: () => ({
    pdfSrc: ref(null),
    pdfReloadSrc: ref(null),
    pdfData: ref(null),
    workingCopyPath: ref(null),
    originalPath: ref(null),
    fileName: ref(null),
    isDirty: ref(false),
    pdfConformanceProfile: ref(null),
    lastSaveMode: ref(null),
    error: ref(null),
    isElectron: ref(true),
    pendingDjvu: ref(null),
    openBatchProgress: ref(null),
    pickFileToOpen: vi.fn(),
    openFile: vi.fn(),
    openFileDirect: mocks.openFileDirect,
    openFileDirectBatch: vi.fn(),
    loadPdfFromPath: vi.fn(),
    ensureHistoryBaselineForExternalMutation: vi.fn(),
    reloadWorkingCopyIntoHistory: vi.fn(),
    loadPdfFromData: vi.fn(),
    persistPdfDataSilently: vi.fn(),
    readWorkingCopyBytes: vi.fn(),
    closeFile: vi.fn(),
    saveFile: vi.fn(),
    repairWorkingCopy: vi.fn(),
    optimizeWorkingCopy: vi.fn(),
    saveWorkingCopy: vi.fn(),
    trySavePdfNativeMutations: vi.fn(),
    trySaveEmbeddedNoteTextUpdates: vi.fn(),
    saveWorkingCopyAs: vi.fn(),
    markDirty: vi.fn(),
    canUndo: ref(false),
    canRedo: ref(false),
    fileHistoryMutationVersion: ref(0),
    fileHistorySessionVersion: ref(0),
    undo: vi.fn(),
    redo: vi.fn(),
})}));

vi.mock('@app/composables/useDjvu', () => ({useDjvu: () => ({
    isDjvuMode: ref(true),
    djvuSourcePath: ref('/tmp/source.djvu'),
    conversionState: ref({
        isConverting: false,
        phase: null,
        percent: 0,
    }),
    isLoadingPages: ref(false),
    loadingProgress: ref({
        current: 0,
        total: 0,
    }),
    showBanner: ref(true),
    showConvertDialog: ref(false),
    viewingError: ref(null),
    openingPath: ref(null),
    openDjvuFile: vi.fn(),
    invalidatePendingDjvuOpen: vi.fn(),
    convertToPdf: mocks.convertToPdf,
    cancelActiveJobs: vi.fn(),
    cleanupDjvuTemp: vi.fn(),
    exitDjvuMode: vi.fn(),
    openConvertDialog: vi.fn(),
    dismissBanner: vi.fn(),
})}));

vi.mock('@app/composables/useRecentFiles', () => ({useRecentFiles: () => ({
    recentFiles: ref([]),
    loadRecentFiles: vi.fn(),
    removeRecentFile: vi.fn(),
    clearRecentFiles: vi.fn(),
})}));

vi.mock('@app/modules/workspace-shell/composables/useWorkspaceFileSwitch', () => ({useWorkspaceFileSwitch: () => ({
    openFileWithDjvuCleanup: vi.fn(),
    openFileDirectWithDjvuCleanup: mocks.openFileDirectWithDjvuCleanup,
    openFileDirectBatchWithDjvuCleanup: vi.fn(),
    closeFileWithDjvuCleanup: vi.fn(),
})}));

const { useWorkspaceFileLifecycleController } =
    await import('@app/modules/workspace-shell/composables/useWorkspaceFileLifecycleController');

describe('useWorkspaceFileLifecycleController', () => {
    it('opens converted DjVu PDFs through the same workspace direct-open handler', async () => {
        mocks.openFileDirect.mockResolvedValue({
            status: 'opened',
            result: {
                kind: 'pdf',
                originalPath: '/tmp/output.pdf',
                workingPath: '/tmp/output-working.pdf',
            },
        });
        mocks.openFileDirectWithDjvuCleanup.mockImplementation(path => mocks.openFileDirect(path));
        mocks.convertToPdf.mockImplementation(async (_subsample, _preserveBookmarks, openConvertedPdf) => {
            await openConvertedPdf('/tmp/output.pdf');
        });

        const controller = useWorkspaceFileLifecycleController();
        await controller.handleDjvuConvert(2, true);

        expect(mocks.convertToPdf).toHaveBeenCalledWith(2, true, mocks.openFileDirectWithDjvuCleanup);
        expect(mocks.openFileDirect).toHaveBeenCalledWith('/tmp/output.pdf');
    });
});
