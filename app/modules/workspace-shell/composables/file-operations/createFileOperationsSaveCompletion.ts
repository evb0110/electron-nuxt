import type { IPdfPersistResult } from '@app/types/pdf';
import { resetLivePdfJsAnnotationStorageModifiedState } from '@app/modules/pdf-viewer/public';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    finalizePostSaveReload,
    type IPostSaveReloadWaiter,
} from '@app/modules/workspace-shell/composables/file-operations/postSaveReload';
import type {
    IFileOperationsSavePdfPorts,
    IFileOperationsSaveStatePorts,
    IFileOperationsSaveViewerPorts,
    IWorkspaceSaveLifecyclePort,
} from '@app/modules/workspace-shell/composables/file-operations/saveRolePorts';

export interface ISaveStateSnapshot {
    annotation: unknown;
    pageLabels: unknown;
    bookmarks: unknown;
}

export interface IFileOperationsSaveCompletionPorts {
    state: Pick<IFileOperationsSaveStatePorts, 'annotations' | 'metadata' | 'metadataCompletion'>;
    pdf: Pick<IFileOperationsSavePdfPorts, 'source'>;
    viewer: Pick<IFileOperationsSaveViewerPorts, 'shapes' | 'shapeState'>;
    lifecycle: Pick<IWorkspaceSaveLifecyclePort, 'loadRecentFiles'>;
}

interface ISuccessfulSaveStateCompletionOptions {
    allowAnnotationSaveStateRefresh?: boolean | undefined;
    allowBookmarksSaveStateRefresh?: boolean | undefined;
    allowPageLabelsSaveStateRefresh?: boolean | undefined;
    markShapeStateSaved?: boolean | undefined;
    preserveLivePdfjsSession?: boolean | undefined;
    resetAnnotationStorage?: boolean | undefined;
    saveStateSnapshot?: ISaveStateSnapshot | undefined;
}

interface IFinalizeSuccessfulSaveOptions extends ISuccessfulSaveStateCompletionOptions {completeSaveState?: boolean | undefined;}

interface IFinalizeSaveReloadOptions {
    completeSaveStateOnSuccess?: boolean | undefined;
    markShapeStateSavedOnSuccess?: boolean | undefined;
    preserveLivePdfjsSessionOnSuccess?: boolean | undefined;
    resetAnnotationStorageOnSuccess?: boolean | undefined;
    saveStateSnapshot?: ISaveStateSnapshot | undefined;
}

export function createFileOperationsSaveCompletion(ports: IFileOperationsSaveCompletionPorts) {
    const {
        state,
        pdf,
        viewer,
        lifecycle,
    } = ports;

    function isSaveStateTokenUnchanged(
        snapshotToken: unknown,
        getCurrentToken: (() => unknown) | undefined,
    ) {
        return !getCurrentToken || Object.is(getCurrentToken(), snapshotToken);
    }

    function captureSaveStateSnapshot(): ISaveStateSnapshot {
        return {
            annotation: state.annotations.getAnnotationSaveStateToken?.(),
            pageLabels: state.metadataCompletion.getPageLabelsSaveStateToken?.(),
            bookmarks: state.metadataCompletion.getBookmarksSaveStateToken?.(),
        };
    }

    function refreshAnnotationSaveStateSnapshot(
        snapshot: ISaveStateSnapshot | undefined,
    ): ISaveStateSnapshot | undefined {
        if (!snapshot) {
            return snapshot;
        }
        return {
            ...snapshot,
            annotation: state.annotations.getAnnotationSaveStateToken?.(),
        };
    }

    function completeSuccessfulSaveState(opts?: ISuccessfulSaveStateCompletionOptions) {
        const snapshot = opts?.saveStateSnapshot;
        const isAnnotationSaveStateUnchanged = !snapshot
            || isSaveStateTokenUnchanged(snapshot.annotation, state.annotations.getAnnotationSaveStateToken);
        const shouldMarkAnnotationSaved = isAnnotationSaveStateUnchanged
            || opts?.allowAnnotationSaveStateRefresh === true;
        if (shouldMarkAnnotationSaved) {
            if (!isAnnotationSaveStateUnchanged) {
                BrowserLogger.debug('workspace', 'Refreshing changed annotation save baseline after native save');
            }
            if (opts?.resetAnnotationStorage !== false) {
                resetLivePdfJsAnnotationStorageModifiedState(pdf.source.pdfDocument.value);
            }
            state.annotations.markAnnotationSaved({ preserveLivePdfjsSession: opts?.preserveLivePdfjsSession === true });
        }

        const isPageLabelsSaveStateUnchanged = !snapshot
            || isSaveStateTokenUnchanged(snapshot.pageLabels, state.metadataCompletion.getPageLabelsSaveStateToken);
        const shouldMarkPageLabelsSaved = isPageLabelsSaveStateUnchanged
            || opts?.allowPageLabelsSaveStateRefresh === true;
        if (shouldMarkPageLabelsSaved) {
            if (!isPageLabelsSaveStateUnchanged) {
                BrowserLogger.debug('workspace', 'Refreshing changed page-label save baseline after native save');
            }
            state.metadataCompletion.markPageLabelsSaved();
        }

        const isBookmarksSaveStateUnchanged = !snapshot
            || isSaveStateTokenUnchanged(snapshot.bookmarks, state.metadataCompletion.getBookmarksSaveStateToken);
        const shouldMarkBookmarksSaved = isBookmarksSaveStateUnchanged
            || opts?.allowBookmarksSaveStateRefresh === true;
        if (shouldMarkBookmarksSaved) {
            if (!isBookmarksSaveStateUnchanged) {
                BrowserLogger.debug('workspace', 'Refreshing changed bookmark save baseline after native save');
            }
            state.metadataCompletion.markBookmarksSaved();
        }

        if (opts?.markShapeStateSaved !== false) {
            viewer.shapeState.markShapeStateSaved?.();
            if (opts?.preserveLivePdfjsSession !== true) {
                viewer.shapeState.clearPendingPersistedShapeStateForNextReload?.();
            }
        }
    }

    function finalizeSuccessfulSave(
        result: IPdfPersistResult,
        opts?: IFinalizeSuccessfulSaveOptions,
    ) {
        if (!result.success) {
            return false;
        }

        BrowserLogger.debug('workspace', 'Finalizing successful save', () => ({
            didSaveAs: result.didSaveAs,
            outPath: result.outPath,
            saveMode: result.saveMode,
            resetAnnotationStorage: opts?.resetAnnotationStorage !== false,
            annotationDirty: state.annotations.annotationDirty.value,
            pageLabelsDirty: state.metadata.pageLabelsDirty.value,
            bookmarksDirty: state.metadata.bookmarksDirty.value,
            hasAnnotationChanges: state.annotations.hasAnnotationChanges(),
            hasShapeChanges: viewer.shapes.hasShapeChanges?.() ?? false,
        }));

        if (opts?.completeSaveState !== false) {
            completeSuccessfulSaveState({
                markShapeStateSaved: opts?.markShapeStateSaved,
                allowAnnotationSaveStateRefresh: opts?.allowAnnotationSaveStateRefresh,
                allowBookmarksSaveStateRefresh: opts?.allowBookmarksSaveStateRefresh,
                allowPageLabelsSaveStateRefresh: opts?.allowPageLabelsSaveStateRefresh,
                preserveLivePdfjsSession: opts?.preserveLivePdfjsSession,
                resetAnnotationStorage: opts?.resetAnnotationStorage,
                saveStateSnapshot: opts?.saveStateSnapshot,
            });
        }

        if (result.outPath) {
            lifecycle.loadRecentFiles();
        }

        return true;
    }

    async function finalizeSaveReload(
        reloadWaiter: IPostSaveReloadWaiter | null,
        saveSucceeded: boolean,
        opts?: IFinalizeSaveReloadOptions,
    ) {
        await finalizePostSaveReload(reloadWaiter, saveSucceeded, {
            onSaveFailed: () => {
                viewer.shapeState.clearPendingPersistedShapeStateForNextReload?.();
            },
            onReloadFailed: (error) => {
                BrowserLogger.warn('workspace', 'Saved PDF but failed to restore the reloaded view', error);
            },
            onSaveSucceeded: () => {
                if (opts?.completeSaveStateOnSuccess !== true) {
                    return;
                }
                completeSuccessfulSaveState({
                    markShapeStateSaved: opts.markShapeStateSavedOnSuccess,
                    preserveLivePdfjsSession: opts.preserveLivePdfjsSessionOnSuccess,
                    resetAnnotationStorage: opts.resetAnnotationStorageOnSuccess,
                    saveStateSnapshot: opts.saveStateSnapshot,
                });
            },
        });
    }

    function armPersistedShapeStateAdoption(shapeStateDirty: boolean) {
        if (!shapeStateDirty) {
            return false;
        }

        viewer.shapeState.adoptPersistedShapeStateForNextReload?.();
        return true;
    }

    async function primePersistedShapeStateForSave(
        data: Uint8Array,
        shapeStateDirty: boolean,
    ) {
        if (!shapeStateDirty) {
            return null;
        }

        return viewer.shapeState.preparePersistedShapeStateForSave?.(data) ?? null;
    }

    async function restorePreparedShapeState(snapshot: unknown) {
        if (!snapshot) {
            return;
        }

        await viewer.shapeState.restorePreparedPersistedShapeState?.(snapshot);
    }

    return {
        armPersistedShapeStateAdoption,
        captureSaveStateSnapshot,
        completeSuccessfulSaveState,
        finalizeSaveReload,
        finalizeSuccessfulSave,
        primePersistedShapeStateForSave,
        refreshAnnotationSaveStateSnapshot,
        restorePreparedShapeState,
    };
}
