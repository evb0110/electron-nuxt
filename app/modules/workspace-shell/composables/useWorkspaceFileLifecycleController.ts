import type { TDjvuPdfExportStrategy } from '@contracts/electronApiDjvu';
import { usePdfFile } from '@app/modules/workspace-shell/composables/usePdfFile';
import { useDjvu } from '@app/composables/useDjvu';
import { useRecentFiles } from '@app/composables/useRecentFiles';
import { useWorkspaceFileSwitch } from '@app/modules/workspace-shell/composables/useWorkspaceFileSwitch';
import { BrowserLogger } from '@app/utils/browserLogger';
import { createWorkspaceViewerLifecycleHooks } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import type { IAnalyticsDocumentScope } from '@app/composables/useAnalytics';

interface IUseWorkspaceFileLifecycleControllerOptions { analyticsDocumentScope?: IAnalyticsDocumentScope | undefined; }

export const useWorkspaceFileLifecycleController = (
    options: IUseWorkspaceFileLifecycleControllerOptions = {},
) => {
    const {
        pdfSrc,
        pdfReloadSrc,
        pdfData,
        workingCopyPath,
        documentRevisionInfo,
        documentRevisionToken,
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
        repairWorkingCopy,
        optimizeWorkingCopy,
        optimizeWorkingCopyAsCopy,
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
    } = usePdfFile({analyticsDocumentScope: options.analyticsDocumentScope});

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
        openFileWithViewerLifecycle,
        openFileDirectWithViewerLifecycle,
        openFileDirectBatchWithViewerLifecycle,
        closeFileWithViewerLifecycle,
    } = useWorkspaceFileSwitch({
        workingCopyPath,
        viewerLifecycleHooks: createWorkspaceViewerLifecycleHooks({
            cleanupDjvuTemp,
            exitDjvuMode,
            invalidatePendingDjvuOpen,
            isDjvuMode,
            workingCopyPath,
        }),
        pickFileToOpen: pickPdfFileToOpen,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        closeFile,
    });

    function handleDjvuConvert(
        subsample: number,
        preserveBookmarks: boolean,
        pdfStrategy: TDjvuPdfExportStrategy,
    ) {
        return djvuConvertToPdf(subsample, preserveBookmarks, pdfStrategy, openFileDirectWithViewerLifecycle);
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
        pdfReloadSrc,
        pdfData,
        workingCopyPath,
        documentRevisionInfo,
        documentRevisionToken,
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
        repairWorkingCopy,
        optimizeWorkingCopy,
        optimizeWorkingCopyAsCopy,
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

        openFileWithViewerLifecycle,
        openFileDirectWithViewerLifecycle,
        openFileDirectBatchWithViewerLifecycle,
        closeFileWithViewerLifecycle,

        hasPdf,
        initFromStorage,
    };
};
