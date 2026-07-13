import type { TDjvuPdfExportStrategy } from '@contracts/electronApiDjvu';
import { usePdfFile } from '@app/modules/workspace-shell/composables/usePdfFile';
import { useDjvu } from '@app/composables/useDjvu';
import { useRecentFiles } from '@app/composables/useRecentFiles';
import { useWorkspaceFileSwitch } from '@app/modules/workspace-shell/composables/useWorkspaceFileSwitch';
import { BrowserLogger } from '@app/utils/browserLogger';
import { createWorkspaceViewerLifecycleHooks } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import type { IAnalyticsDocumentScope } from '@app/composables/useAnalytics';
import type { TPdfProjectionReason } from '@app/utils/document-viewer/session/documentSession';
import type { IDocumentOpenSurfaceSession } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';

interface IUseWorkspaceFileLifecycleControllerOptions {
    analyticsDocumentScope?: IAnalyticsDocumentScope | undefined;
    openSurface?: IDocumentOpenSurfaceSession | undefined;
}

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
        requiresSaveAsOnFirstSave,
        fileName,
        isDirty,
        pdfConformanceProfile,
        pdfRasterDisplayProfile,
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
        setWorkspaceCommandSink,
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
        sourceError: djvuError,
        openingPath: djvuOpeningPath,
        sourceSizeBytes: djvuSourceSizeBytes,
        openDjvuFile,
        invalidatePendingDjvuOpen,
        convertToPdf: djvuConvertToPdf,
        ensurePdfProjectionForAction: ensureDjvuPdfProjectionForAction,
        cancelActiveJobs: cancelDjvuJobs,
        cleanupDjvuTemp,
        captureDjvuActivation,
        exitDjvuMode,
        openConvertDialog,
        dismissBanner: djvuDismissBanner,
    } = useDjvu({openSurface: options.openSurface});

    const {
        recentFiles,
        loadRecentFiles,
        removeRecentFile,
        clearRecentFiles,
    } = useRecentFiles();

    async function commitPendingDjvuOpen(outcome: TDocumentOpenOutcome) {
        BrowserLogger.info('djvu-open-transaction', 'Finalize requested', {
            status: outcome.status,
            resultKind: 'result' in outcome ? outcome.result.kind : null,
            resultPath: 'result' in outcome ? outcome.result.originalPath : null,
            pendingPath: pendingDjvu.value,
        });
        if (outcome.status !== 'prepared') {
            return outcome;
        }
        if (outcome.result.kind !== 'djvu') {
            return {
                status: 'failed',
                error: 'Only DjVu opens may require activation',
            } satisfies TDocumentOpenOutcome;
        }
        const djvuPath = outcome.result.originalPath;
        if (pendingDjvu.value !== djvuPath) {
            BrowserLogger.warn('djvu-open-transaction', 'Finalize rejected', {
                reason: 'pending-path-mismatch',
                djvuPath,
                pendingPath: pendingDjvu.value,
            });
            return {
                status: 'stale',
                result: outcome.result,
            } satisfies TDocumentOpenOutcome;
        }
        pendingDjvu.value = null;
        BrowserLogger.info('djvu-open-transaction', 'Pending command consumed', {
            reason: 'activation-owner-acquired',
            djvuPath,
        });
        try {
            const activated = await openDjvuFile(djvuPath, {
                closeActiveDocument: closeFile,
                setOriginalPath: (path) => {
                    originalPath.value = path;
                },
            });
            BrowserLogger.info('djvu-open-transaction', 'Activation returned', {
                activated,
                djvuPath,
                isDjvuMode: isDjvuMode.value,
                sourcePath: djvuSourcePath.value,
            });
            if (!activated) {
                return {
                    status: 'stale',
                    result: outcome.result,
                } satisfies TDocumentOpenOutcome;
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            pdfError.value = message;
            BrowserLogger.error('djvu-open-transaction', 'Activation failed', {
                reason: 'open-djvu-threw',
                djvuPath,
                error: message,
            });
            return {
                status: 'failed',
                error: message,
            } satisfies TDocumentOpenOutcome;
        }
        if (!isDjvuMode.value || djvuSourcePath.value !== djvuPath) {
            BrowserLogger.warn('djvu-open-transaction', 'Activation state rejected', {
                reason: !isDjvuMode.value ? 'djvu-mode-inactive' : 'source-path-mismatch',
                djvuPath,
                isDjvuMode: isDjvuMode.value,
                sourcePath: djvuSourcePath.value,
            });
            return {
                status: 'stale',
                result: outcome.result,
            } satisfies TDocumentOpenOutcome;
        }
        BrowserLogger.info('djvu-open-transaction', 'Finalize committed', {
            reason: 'source-active',
            djvuPath,
        });
        return {
            status: 'opened',
            result: outcome.result,
        } satisfies TDocumentOpenOutcome;
    }

    const {
        openFileWithViewerLifecycle,
        openFileDirectWithViewerLifecycle,
        openFileDirectBatchWithViewerLifecycle,
        closeFileWithViewerLifecycle,
    } = useWorkspaceFileSwitch({
        workingCopyPath,
        viewerLifecycleHooks: createWorkspaceViewerLifecycleHooks({
            cleanupDjvuTemp,
            captureDjvuActivation,
            exitDjvuMode,
            invalidatePendingDjvuOpen,
            isDjvuMode,
            workingCopyPath,
        }),
        pickFileToOpen: pickPdfFileToOpen,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        finalizeOpen: commitPendingDjvuOpen,
        closeFile,
    });

    function handleDjvuConvert(
        subsample: number,
        preserveBookmarks: boolean,
        pdfStrategy: TDjvuPdfExportStrategy,
    ) {
        return djvuConvertToPdf(subsample, preserveBookmarks, pdfStrategy, openFileDirectWithViewerLifecycle);
    }

    function ensureDjvuPdfProjection(
        reason: TPdfProjectionReason,
        signal: AbortSignal,
    ) {
        return ensureDjvuPdfProjectionForAction(reason, openFileDirectWithViewerLifecycle, signal);
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
        requiresSaveAsOnFirstSave,
        fileName,
        isDirty,
        pdfConformanceProfile,
        pdfRasterDisplayProfile,
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
        setWorkspaceCommandSink,
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
        djvuSourceSizeBytes,
        openDjvuFile,
        openConvertDialog,
        djvuDismissBanner,
        handleDjvuConvert,
        ensureDjvuPdfProjection,
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
