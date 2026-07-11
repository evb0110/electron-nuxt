import type { Ref } from 'vue';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { IWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { buildWorkspaceCheckpoint } from '@app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpoint';
import { getWindowTabsCapability } from '@app/utils/platformWindowTabs';
import { waitForDesktopPlatformBridge } from '@app/utils/platform';
import { guardAsync } from '@app/utils/asyncGuard';

interface IUseWorkspaceCrashCheckpointOptions {
    enabled: Ref<boolean>;
    panes: Ref<IEditorPaneState[]>;
    tabs: Ref<ITab[]>;
    layout: Ref<TEditorLayoutNode | null>;
    activePaneId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
    documentRecordsByTabId: Ref<Record<string, IWorkspaceDocumentRecord>>;
    getPaneByTabId(tabId: string): IEditorPaneState | null;
}

const CHECKPOINT_DEBOUNCE_MS = 500;

export const useWorkspaceCrashCheckpoint = (options: IUseWorkspaceCrashCheckpointOptions) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    function persistCheckpoint() {
        if (!options.enabled.value || disposed) {
            return;
        }
        const checkpoint = buildWorkspaceCheckpoint(options);
        guardAsync((async () => {
            await waitForDesktopPlatformBridge({shouldWait: true});
            if (!disposed && options.enabled.value) {
                await getWindowTabsCapability().saveWorkspaceCheckpoint(checkpoint);
            }
        })(), {
            category: 'background-diagnostic',
            scope: 'workspace-checkpoint',
            message: 'Failed to persist crash recovery checkpoint',
        });
    }

    function scheduleCheckpoint() {
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => {
            timer = null;
            persistCheckpoint();
        }, CHECKPOINT_DEBOUNCE_MS);
    }

    const stop = watch(
        () => options.enabled.value
            ? JSON.stringify(buildWorkspaceCheckpoint(options))
            : null,
        scheduleCheckpoint,
        {immediate: true},
    );

    onBeforeUnmount(() => {
        disposed = true;
        stop();
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    });
};
