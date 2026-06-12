import type { Ref } from 'vue';
import type { TOpenDjvuFile } from '@app/composables/useDjvu';
import type { TTabUpdate } from '@app/types/tabs';
import type { TDocumentRef } from '@contracts/documentRef';
import { clamp } from 'es-toolkit/math';
import type { IOpenBatchProgressState } from '@app/modules/workspace-shell/composables/openBatchProgressState';
import { hasDocumentHintUpdate } from '@app/modules/workspace-shell/tabs/hasDocumentHintUpdate';
import { isEmptyTabDocumentUpdate } from '@app/modules/workspace-shell/tabs/isEmptyTabDocumentUpdate';
import { resolveWorkspaceTabUpdate } from '@app/modules/workspace-shell/state/resolveWorkspaceTabUpdate';

interface IWorkspaceUiSyncDeps {
    pendingDjvu: Ref<TDocumentRef | null>;
    openDjvuFile: TOpenDjvuFile;
    loadPdfFromPath: (path: TDocumentRef) => Promise<void>;
    currentPage: Ref<number>;
    pdfViewerRef: Ref<{ scrollToPage: (page: number) => void } | null>;
    originalPath: Ref<TDocumentRef | null>;
    closeFile: () => void | Promise<void>;
    openBatchProgress: Ref<IOpenBatchProgressState | null>;
    isActive: Ref<boolean>;
    fileName: Ref<string | null>;
    isDirty: Readonly<Ref<boolean>>;
    isDjvuMode: Ref<boolean>;
    djvuSourcePath: Ref<TDocumentRef | null>;
    showSettings: Ref<boolean>;
    emitUpdateTab: (updates: TTabUpdate) => void;
    emitOpenSettings: () => void;
    onOpenDjvuError?: (error: unknown) => void;
}

export const useWorkspaceUiSyncWatchers = (deps: IWorkspaceUiSyncDeps) => {
    const { t } = useTypedI18n();
    let hasEmittedDocumentBearingTabState = false;

    function resolvePendingOpenDisplayName(progress: IOpenBatchProgressState | null) {
        if (!progress || progress.total <= 0) {
            return null;
        }

        return t('tabs.preparingBatch', {
            processed: clamp(progress.processed, 0, progress.total),
            total: progress.total,
        });
    }

    watch(deps.pendingDjvu, async (djvuPath) => {
        if (!djvuPath) {
            return;
        }
        deps.pendingDjvu.value = null;
        try {
            await deps.openDjvuFile(
                djvuPath,
                deps.loadPdfFromPath,
                () => deps.currentPage.value,
                (page) => {
                    deps.pdfViewerRef.value?.scrollToPage(page);
                },
                (path) => {
                    deps.originalPath.value = path;
                },
                deps.closeFile,
            );
        } catch (error) {
            deps.onOpenDjvuError?.(error);
        }
    });

    watch(
        [
            deps.fileName,
            deps.originalPath,
            deps.isDirty,
            deps.isDjvuMode,
            deps.djvuSourcePath,
            deps.openBatchProgress,
        ],
        () => {
            const update = resolveWorkspaceTabUpdate({
                fileName: deps.fileName.value,
                pendingOpenDisplayName: resolvePendingOpenDisplayName(deps.openBatchProgress.value),
                originalPath: deps.originalPath.value,
                isDirty: deps.isDirty.value,
                isDjvuMode: deps.isDjvuMode.value,
                djvuSourcePath: deps.djvuSourcePath.value,
            });

            if (isEmptyTabDocumentUpdate(update) && !hasEmittedDocumentBearingTabState) {
                return;
            }

            if (hasDocumentHintUpdate(update)) {
                hasEmittedDocumentBearingTabState = true;
            }

            deps.emitUpdateTab(update);
        },
        { immediate: true },
    );

    watch(deps.showSettings, (value) => {
        if (!value) {
            return;
        }

        deps.emitOpenSettings();
        deps.showSettings.value = false;
    });
};
