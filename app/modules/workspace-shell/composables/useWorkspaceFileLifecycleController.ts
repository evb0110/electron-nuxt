import { usePdfFile } from '@app/composables/usePdfFile';
import { useDjvu } from '@app/composables/useDjvu';
import { useRecentFiles } from '@app/composables/useRecentFiles';
import { useWorkspaceFileSwitch } from '@app/modules/workspace-shell/composables/useWorkspaceFileSwitch';
import { BrowserLogger } from '@app/utils/browserLogger';

export const useWorkspaceFileLifecycleController = () => {
    const {
        pdfSrc,
        pdfData,
        workingCopyPath,
        originalPath,
        fileName,
        isDirty,
        pdfConformanceProfile,
        lastSaveMode,
        error: pdfError,
        isElectron,
        pendingDjvu,
        openBatchProgress,
        pickFileToOpen: pickPdfFileToOpen,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        loadPdfFromPath,
        ensureHistoryBaselineForExternalMutation,
        reloadWorkingCopyIntoHistory,
        loadPdfFromData,
        persistPdfDataSilently,
        readWorkingCopyBytes,
        closeFile,
        saveFile,
        saveWorkingCopy,
        trySavePdfNativeMutations,
        trySaveEmbeddedNoteTextUpdates,
        saveWorkingCopyAs,
        markDirty,
        canUndo: canUndoFile,
        canRedo: canRedoFile,
        fileHistoryMutationVersion,
        fileHistorySessionVersion,
        undo,
        redo,
    } = usePdfFile();

    const {
        isDjvuMode,
        djvuSourcePath,
        conversionState,
        isLoadingPages: djvuIsLoadingPages,
        loadingProgress: djvuLoadingProgress,
        showBanner: djvuShowBanner,
        showConvertDialog,
        viewingError: djvuError,
        openingPath: djvuOpeningPath,
        openDjvuFile,
        invalidatePendingDjvuOpen,
        convertToPdf: djvuConvertToPdf,
        cancelActiveJobs: cancelDjvuJobs,
        cleanupDjvuTemp,
        exitDjvuMode,
        openConvertDialog,
        dismissBanner: djvuDismissBanner,
    } = useDjvu();

    const {
        recentFiles,
        loadRecentFiles,
        removeRecentFile,
        clearRecentFiles,
    } = useRecentFiles();

    const {
        openFileWithDjvuCleanup,
        openFileDirectWithDjvuCleanup,
        openFileDirectBatchWithDjvuCleanup,
        closeFileWithDjvuCleanup,
    } = useWorkspaceFileSwitch({
        workingCopyPath,
        isDjvuMode,
        cleanupDjvuTemp,
        exitDjvuMode,
        invalidatePendingDjvuOpen,
        pickFileToOpen: pickPdfFileToOpen,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        closeFile,
    });

    function handleDjvuConvert(subsample: number, preserveBookmarks: boolean) {
        return djvuConvertToPdf(subsample, preserveBookmarks, loadPdfFromPath, (path) => {
            originalPath.value = path;
        });
    }

    function handleDjvuCancel() {
        if (djvuSourcePath.value) {
            void cancelDjvuJobs();
        }
    }

    function initFromStorage() {
        if (import.meta.dev) {
            BrowserLogger.debug('workspace', 'Electron API available', isElectron.value);
        }

        void loadRecentFiles();
    }

    const hasPdf = computed(() => !!pdfSrc.value);

    return {
        pdfSrc,
        pdfData,
        workingCopyPath,
        originalPath,
        fileName,
        isDirty,
        pdfConformanceProfile,
        lastSaveMode,
        pdfError,
        isElectron,
        pendingDjvu,
        openBatchProgress,
        pickFileToOpen: pickPdfFileToOpen,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        loadPdfFromPath,
        ensureHistoryBaselineForExternalMutation,
        reloadWorkingCopyIntoHistory,
        loadPdfFromData,
        persistPdfDataSilently,
        readWorkingCopyBytes,
        closeFile,
        saveFile,
        saveWorkingCopy,
        trySavePdfNativeMutations,
        trySaveEmbeddedNoteTextUpdates,
        saveWorkingCopyAs,
        markDirty,
        canUndoFile,
        canRedoFile,
        fileHistoryMutationVersion,
        fileHistorySessionVersion,
        undo,
        redo,

        isDjvuMode,
        djvuSourcePath,
        conversionState,
        djvuIsLoadingPages,
        djvuLoadingProgress,
        djvuShowBanner,
        showConvertDialog,
        djvuError,
        djvuOpeningPath,
        openDjvuFile,
        openConvertDialog,
        djvuDismissBanner,
        handleDjvuConvert,
        handleDjvuCancel,

        recentFiles,
        loadRecentFiles,
        removeRecentFile,
        clearRecentFiles,

        openFileWithDjvuCleanup,
        openFileDirectWithDjvuCleanup,
        openFileDirectBatchWithDjvuCleanup,
        closeFileWithDjvuCleanup,

        hasPdf,
        initFromStorage,
    };
};
