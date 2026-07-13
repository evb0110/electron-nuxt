import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';
import type { TDocumentDirectOpenOptions } from '@app/modules/workspace-shell/composables/document-session/createDocumentOpenFlow';
import type { IWorkspaceViewerLifecycleHooks } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapterTypes';

interface IWorkspaceFileSwitchDeps {
    workingCopyPath: Ref<TDocumentRef | null>;
    viewerLifecycleHooks: IWorkspaceViewerLifecycleHooks[];
    pickFileToOpen: () => Promise<TOpenFileResult | null>;
    openFile: (preSelected?: TOpenFileResult) => Promise<TDocumentOpenOutcome>;
    openFileDirect: (path: TDocumentRef, options?: TDocumentDirectOpenOptions) => Promise<TDocumentOpenOutcome>;
    openFileDirectBatch: (paths: TDocumentRef[]) => Promise<TDocumentOpenOutcome>;
    finalizeOpen: (outcome: TDocumentOpenOutcome) => Promise<TDocumentOpenOutcome>;
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
        finalizeOpen,
        closeFile,
    } = deps;
    let lifecycleGeneration = 0;

    function markOutcomeStale(outcome: TDocumentOpenOutcome): TDocumentOpenOutcome {
        return 'result' in outcome
            ? {
                status: 'stale',
                result: outcome.result,
            }
            : outcome;
    }

    async function openWithViewerLifecycle(
        openDocument: () => Promise<TDocumentOpenOutcome>,
    ) {
        const generation = ++lifecycleGeneration;
        const previousWorkingCopyPath = workingCopyPath.value;
        for (const hooks of viewerLifecycleHooks) {
            await hooks.beforeOpen?.();
        }
        const preparedOutcome = await openDocument();
        if (generation !== lifecycleGeneration) {
            return markOutcomeStale(preparedOutcome);
        }
        const outcome = await finalizeOpen(preparedOutcome);
        if (generation !== lifecycleGeneration) {
            return markOutcomeStale(outcome);
        }
        for (const hooks of viewerLifecycleHooks) {
            await hooks.afterOpen?.(outcome, { previousWorkingCopyPath });
            if (generation !== lifecycleGeneration) {
                return markOutcomeStale(outcome);
            }
        }
        return outcome;
    }

    async function openFileWithViewerLifecycle(preSelected?: TOpenFileResult) {
        return openWithViewerLifecycle(() => openFile(preSelected));
    }

    async function openFileDirectWithViewerLifecycle(path: TDocumentRef, options?: TDocumentDirectOpenOptions) {
        return openWithViewerLifecycle(() => openFileDirect(path, options));
    }

    async function openFileDirectBatchWithViewerLifecycle(paths: TDocumentRef[]) {
        return openWithViewerLifecycle(() => openFileDirectBatch(paths));
    }

    async function closeFileWithViewerLifecycle() {
        const generation = ++lifecycleGeneration;
        for (const hooks of viewerLifecycleHooks) {
            await hooks.beforeClose?.();
        }
        if (generation === lifecycleGeneration) {
            closeFile();
            // `closeFile` clears the source synchronously, while the mounted
            // viewer owns derived document, navigation, toolbar, and chassis
            // state through source watchers.  Do not commit the close to the
            // tab/session layer until those owners have observed the empty
            // source; otherwise a retained singleton workspace can expose a
            // document-less viewport with stale document capabilities.
            await nextTick();
        }
    }

    return {
        pickFileToOpen,
        openFileWithViewerLifecycle,
        openFileDirectWithViewerLifecycle,
        openFileDirectBatchWithViewerLifecycle,
        closeFileWithViewerLifecycle,
    };
};
