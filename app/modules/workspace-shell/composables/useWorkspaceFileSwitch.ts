import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';
import type { IWorkspaceViewerLifecycleHooks } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapterTypes';

interface IWorkspaceFileSwitchDeps {
    workingCopyPath: Ref<TDocumentRef | null>;
    viewerLifecycleHooks: IWorkspaceViewerLifecycleHooks[];
    pickFileToOpen: () => Promise<TOpenFileResult | null>;
    openFile: (preSelected?: TOpenFileResult) => Promise<TDocumentOpenOutcome>;
    openFileDirect: (path: TDocumentRef) => Promise<TDocumentOpenOutcome>;
    openFileDirectBatch: (paths: TDocumentRef[]) => Promise<TDocumentOpenOutcome>;
    closeFile: () => void;
}

export const useWorkspaceFileSwitch = (deps: IWorkspaceFileSwitchDeps) => {
    const {
        workingCopyPath,
        viewerLifecycleHooks,
        pickFileToOpen,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        closeFile,
    } = deps;

    async function openWithViewerLifecycle(
        openDocument: () => Promise<TDocumentOpenOutcome>,
    ) {
        const previousWorkingCopyPath = workingCopyPath.value;
        for (const hooks of viewerLifecycleHooks) {
            await hooks.beforeOpen?.();
        }
        const outcome = await openDocument();
        for (const hooks of viewerLifecycleHooks) {
            await hooks.afterOpen?.(outcome, { previousWorkingCopyPath });
        }
        return outcome;
    }

    async function openFileWithViewerLifecycle(preSelected?: TOpenFileResult) {
        return openWithViewerLifecycle(() => openFile(preSelected));
    }

    async function openFileDirectWithViewerLifecycle(path: TDocumentRef) {
        return openWithViewerLifecycle(() => openFileDirect(path));
    }

    async function openFileDirectBatchWithViewerLifecycle(paths: TDocumentRef[]) {
        return openWithViewerLifecycle(() => openFileDirectBatch(paths));
    }

    async function closeFileWithViewerLifecycle() {
        for (const hooks of viewerLifecycleHooks) {
            await hooks.beforeClose?.();
        }
        closeFile();
    }

    return {
        pickFileToOpen,
        openFileWithViewerLifecycle,
        openFileDirectWithViewerLifecycle,
        openFileDirectBatchWithViewerLifecycle,
        closeFileWithViewerLifecycle,
    };
};
