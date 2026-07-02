import type { Ref } from 'vue';
import type { TOpenDjvuFile } from '@app/composables/useDjvu';
import type { TDocumentRef } from '@contracts/documentRef';

interface IWorkspaceUiSyncDeps {
    pendingDjvu: Ref<TDocumentRef | null>;
    openDjvuFile: TOpenDjvuFile;
    loadPdfFromPath: (path: TDocumentRef) => Promise<void>;
    currentPage: Ref<number>;
    pdfViewerRef: Ref<{ scrollToPage: (page: number) => void } | null>;
    originalPath: Ref<TDocumentRef | null>;
    closeFile: () => void | Promise<void>;
    showSettings: Ref<boolean>;
    emitOpenSettings: () => void;
    onOpenDjvuError?: (error: unknown) => void;
}

export const useWorkspaceUiSyncWatchers = (deps: IWorkspaceUiSyncDeps): void => {
    watch(deps.pendingDjvu, async (djvuPath: TDocumentRef | null) => {
        if (!djvuPath) {
            return;
        }
        deps.pendingDjvu.value = null;
        try {
            await deps.openDjvuFile(
                djvuPath,
                deps.loadPdfFromPath,
                () => deps.currentPage.value,
                (page: number) => {
                    deps.pdfViewerRef.value?.scrollToPage(page);
                },
                (path: TDocumentRef | null) => {
                    deps.originalPath.value = path;
                },
                deps.closeFile,
            );
        } catch (error) {
            deps.onOpenDjvuError?.(error);
        }
    });

    watch(deps.showSettings, (value: boolean) => {
        if (!value) {
            return;
        }

        deps.emitOpenSettings();
        deps.showSettings.value = false;
    });
};
