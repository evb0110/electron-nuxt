import type { Ref } from 'vue';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { IWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { buildWorkspaceCheckpoint } from '@app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpoint';
import { buildWorkspaceCheckpointChangeSignature } from '@app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpointChangeSignature';
import { getWindowTabsCapability } from '@app/utils/platformWindowTabs';
import { waitForDesktopPlatformBridge } from '@app/utils/platform';
import { guardAsync } from '@app/utils/asyncGuard';
import { getPerformanceProfile } from '@app/utils/performanceProfile';
import type { IWorkspaceCheckpoint } from '@contracts/workspaceCheckpoint';
import { resolveDocumentSavePerformanceTier } from '@contracts/hostResourceProfile';

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

export const useWorkspaceCrashCheckpoint = (options: IUseWorkspaceCrashCheckpointOptions) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;
    let pendingLatest: IWorkspaceCheckpoint | null = null;
    let disposed = false;
    const deviceTier = resolveDocumentSavePerformanceTier(getPerformanceProfile().tier);
    const debounceMs = deviceTier === 'low' ? 1_500 : 500;

    async function drainCheckpointWrites(initialCheckpoint: IWorkspaceCheckpoint) {
        let checkpoint: IWorkspaceCheckpoint | null = initialCheckpoint;
        let firstError: unknown;
        await waitForDesktopPlatformBridge({shouldWait: true});
        while (checkpoint && !disposed) {
            if (!options.enabled.value) {
                pendingLatest = null;
                return;
            }
            try {
                await getWindowTabsCapability().saveWorkspaceCheckpoint(checkpoint);
            } catch (error) {
                firstError ??= error;
            }
            checkpoint = pendingLatest;
            pendingLatest = null;
        }
        if (firstError !== undefined) {
            throw firstError instanceof Error
                ? firstError
                : new Error(String(firstError));
        }
    }

    function persistCheckpoint(checkpoint: IWorkspaceCheckpoint) {
        if (!options.enabled.value || disposed) {
            return;
        }
        if (inFlight) {
            pendingLatest = checkpoint;
            return;
        }
        inFlight = drainCheckpointWrites(checkpoint).finally(() => {
            inFlight = null;
            if (pendingLatest && !disposed && options.enabled.value) {
                const nextCheckpoint = pendingLatest;
                pendingLatest = null;
                persistCheckpoint(nextCheckpoint);
            }
        });
        guardAsync(inFlight, {
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
            persistCheckpoint(buildWorkspaceCheckpoint(options));
        }, debounceMs);
    }

    const stop = watch(
        // Watch a cheap change signature instead of the serialized checkpoint:
        // the full checkpoint is built only inside the debounced persist.
        () => options.enabled.value
            ? buildWorkspaceCheckpointChangeSignature(options).workspace
            : null,
        scheduleCheckpoint,
        {immediate: true},
    );

    onBeforeUnmount(() => {
        disposed = true;
        pendingLatest = null;
        stop();
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    });
};
