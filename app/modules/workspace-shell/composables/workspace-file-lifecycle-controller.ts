import type { Ref } from 'vue';
import { usePdfFile } from '@app/composables/usePdfFile';
import { useDjvu } from '@app/composables/useDjvu';
import { useRecentFiles } from '@app/composables/useRecentFiles';
import { useWorkspaceFileSwitch } from '@app/modules/workspace-shell/composables/useWorkspaceFileSwitch';
import { usePageFileOperations } from '@app/modules/workspace-shell/composables/usePageFileOperations';
import type { IAnnotationNoteWindowState } from '@app/composables/pdf/annotations/types';
import type {
    TDocumentRef,
    TOpenFileResult,
} from '@contracts/platform-api';
import type { TPdfSource } from '@app/types/pdf';
import { BrowserLogger } from '@app/utils/browser-logger';

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
        pickFileToOpen,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        loadPdfFromPath,
        reloadWorkingCopyIntoHistory,
        loadPdfFromData,
        persistPdfDataSilently,
        readWorkingCopyBytes,
        closeFile,
        saveFile,
        saveWorkingCopy,
        saveWorkingCopyAs,
        markDirty,
        canUndo: canUndoFile,
        canRedo: canRedoFile,
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
        openDjvuFile,
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
        pickFileToOpenWithDjvuCleanup,
        openFileWithDjvuCleanup,
        openFileDirectWithDjvuCleanup,
        openFileDirectBatchWithDjvuCleanup,
        closeFileWithDjvuCleanup,
    } = useWorkspaceFileSwitch({
        workingCopyPath,
        isDjvuMode,
        cleanupDjvuTemp,
        exitDjvuMode,
        pickFileToOpen,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        closeFile,
    });

    function handleDjvuConvert(subsample: number, preserveBookmarks: boolean) {
        return djvuConvertToPdf(subsample, preserveBookmarks, loadPdfFromPath);
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
        pickFileToOpen,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        loadPdfFromPath,
        reloadWorkingCopyIntoHistory,
        loadPdfFromData,
        persistPdfDataSilently,
        readWorkingCopyBytes,
        closeFile,
        saveFile,
        saveWorkingCopy,
        saveWorkingCopyAs,
        markDirty,
        canUndoFile,
        canRedoFile,
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
        openDjvuFile,
        openConvertDialog,
        djvuDismissBanner,
        handleDjvuConvert,
        handleDjvuCancel,

        recentFiles,
        loadRecentFiles,
        removeRecentFile,
        clearRecentFiles,

        pickFileToOpenWithDjvuCleanup,
        openFileWithDjvuCleanup,
        openFileDirectWithDjvuCleanup,
        openFileDirectBatchWithDjvuCleanup,
        closeFileWithDjvuCleanup,

        hasPdf,
        initFromStorage,
    };
};

interface IWorkspaceFileOperationControllerDeps {
    pdfSrc: Ref<TPdfSource | null>;
    isAnySaving: Ref<boolean>;
    isHistoryBusy: Ref<boolean>;
    isExportingDocx: Ref<boolean>;
    isAnyAnnotationNoteSaving: Ref<boolean>;
    annotationNoteWindows: Ref<IAnnotationNoteWindowState[]>;
    annotationDirty: Ref<boolean>;
    isDirty: Ref<boolean>;
    pageLabelsDirty: Ref<boolean>;
    bookmarksDirty: Ref<boolean>;
    hasAnnotationChanges: () => boolean;
    persistAllAnnotationNotes: (force: boolean) => Promise<boolean>;
    handleSave: () => Promise<void>;
    pickFileToOpenWithDjvuCleanup: () => Promise<TOpenFileResult | null>;
    openFileWithDjvuCleanup: (preSelected?: TOpenFileResult) => Promise<void>;
    openFileDirectWithDjvuCleanup: (path: TDocumentRef) => Promise<void>;
    openFileDirectBatchWithDjvuCleanup: (paths: TDocumentRef[]) => Promise<void>;
    closeFileWithDjvuCleanup: () => Promise<void>;
    closeAllDropdowns: () => void;
    emitOpenInNewTab: (result: TOpenFileResult) => void;
}

export const useWorkspaceFileOperationController = (deps: IWorkspaceFileOperationControllerDeps) => {
    const {
        pdfSrc,
        isAnySaving,
        isHistoryBusy,
        isExportingDocx,
        isAnyAnnotationNoteSaving,
        annotationNoteWindows,
        annotationDirty,
        isDirty,
        pageLabelsDirty,
        bookmarksDirty,
        hasAnnotationChanges,
        persistAllAnnotationNotes,
        handleSave,
        pickFileToOpenWithDjvuCleanup,
        openFileWithDjvuCleanup,
        openFileDirectWithDjvuCleanup,
        openFileDirectBatchWithDjvuCleanup,
        closeFileWithDjvuCleanup,
        closeAllDropdowns,
        emitOpenInNewTab,
    } = deps;

    return usePageFileOperations({
        pdfSrc,
        isAnySaving,
        isHistoryBusy,
        isExportingDocx,
        isAnyAnnotationNoteSaving,
        annotationNoteWindows,
        annotationDirty,
        isDirty,
        pageLabelsDirty,
        bookmarksDirty,
        hasAnnotationChanges,
        persistAllAnnotationNotes,
        handleSave,
        pickFileToOpen: pickFileToOpenWithDjvuCleanup,
        openFile: openFileWithDjvuCleanup,
        openFileDirect: openFileDirectWithDjvuCleanup,
        openFileDirectBatch: openFileDirectBatchWithDjvuCleanup,
        closeFile: closeFileWithDjvuCleanup,
        closeAllDropdowns,
        emitOpenInNewTab,
    });
};
