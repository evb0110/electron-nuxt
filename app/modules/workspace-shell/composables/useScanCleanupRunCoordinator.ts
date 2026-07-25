import type {
    ComputedRef,
    Ref,
} from 'vue';
import {
    installScanCleanupRunCoordinator,
    pruneScanCleanupOutputs,
} from '@app/modules/scan-cleanup/public/runtime';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { getDocumentOpenCapability } from '@app/utils/platformDocuments';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { TTranslateFn } from '@i18n-app';
import type {ITabViewSessionState} from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';

export function resolveScanCleanupEntryViewState(
    viewState: ITabViewSessionState,
): ITabViewSessionState {
    if (viewState.surfaceMode === 'scan-cleanup') {
        return viewState;
    }
    const {
        scanCleanup: _scanCleanup,
        ...freshViewState
    } = viewState;
    return {
        ...freshViewState,
        surfaceMode: 'scan-cleanup',
    };
}

export const useScanCleanupRunCoordinator = (
    activeWorkspace: ComputedRef<IWorkspaceExpose | null>,
    handleOpenInNewTab: (result: TOpenFileResult) => Promise<boolean>,
    isStartupOpenClaimPending: Ref<boolean>,
    t: TTranslateFn,
    tabs: Ref<ITab[]>,
    documentSessionsByTabId: ComputedRef<Record<string, IWorkspaceDocumentController>>,
    activateTab: (tabId: string) => void,
) => {
    const toast = useToast();
    const cleanup = installScanCleanupRunCoordinator({
        getOpenPdfPaths: () => tabs.value
            .map(tab => tab.originalPath)
            .filter((path): path is string => typeof path === 'string' && path.length > 0),
        openGeneratedPdf: async (path) => {
            const result = await getDocumentOpenCapability().openDocumentDirect(path);
            return result?.kind === 'pdf'
                ? handleOpenInNewTab(result)
                : false;
        },
        saveActiveDocumentAs: async () => activeWorkspace.value?.handleSaveAs() ?? false,
        openScanCleanupForDocument: async (documentRef) => {
            const owner = Object.entries(documentSessionsByTabId.value).find(([
                ,
                session,
            ]) => {
                const identity = session.snapshot.value.identity;
                return identity.documentRef === documentRef
                    || identity.workingCopyPath === documentRef
                    || identity.originalPath === documentRef;
            });
            if (!owner) {
                return false;
            }
            const [
                tabId,
                session,
            ] = owner;
            session.applyViewState(resolveScanCleanupEntryViewState(
                session.snapshot.value.viewState,
            ));
            activateTab(tabId);
            await nextTick();
            return true;
        },
        t,
        toast,
    });

    onUnmounted(cleanup);
    watch(isStartupOpenClaimPending, (pending) => {
        if (!pending) void pruneScanCleanupOutputs().catch(() => undefined);
    }, {immediate: true});
};
