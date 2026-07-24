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
import type { IWorkspaceDocumentSessionController } from '@app/modules/workspace-shell/document-sessions/documentSessionTypes';
import { getDocumentOpenCapability } from '@app/utils/platformDocuments';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { TTranslateFn } from '@i18n-app';

export const useScanCleanupRunCoordinator = (
    activeWorkspace: ComputedRef<IWorkspaceExpose | null>,
    handleOpenInNewTab: (result: TOpenFileResult) => Promise<boolean>,
    isStartupOpenClaimPending: Ref<boolean>,
    t: TTranslateFn,
    tabs: Ref<ITab[]>,
    documentSessionsByTabId: ComputedRef<Record<string, IWorkspaceDocumentSessionController>>,
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
                ? handleOpenInNewTab({
                    ...result,
                    isGenerated: true,
                })
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
            session.applyViewState({
                ...session.snapshot.value.viewState,
                surfaceMode: 'scan-cleanup',
            });
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
