import type {
    ComputedRef,
    Ref,
} from 'vue';
import {
    installScanCleanupRunCoordinator,
    pruneScanCleanupOutputs,
} from '@app/modules/scan-cleanup/public';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import { getDocumentOpenCapability } from '@app/utils/platformDocuments';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { TTranslateFn } from '@i18n-app';

export const useScanCleanupRunCoordinator = (
    activeWorkspace: ComputedRef<IWorkspaceExpose | null>,
    handleOpenInNewTab: (result: TOpenFileResult) => Promise<boolean>,
    isStartupOpenClaimPending: Ref<boolean>,
    t: TTranslateFn,
    tabs: Ref<ITab[]>,
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
        t,
        toast,
    });

    onUnmounted(cleanup);
    watch(isStartupOpenClaimPending, (pending) => {
        if (!pending) void pruneScanCleanupOutputs().catch(() => undefined);
    }, {immediate: true});
};
