import type { Ref } from 'vue';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { IWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import type { useEditorPanesManager } from '@app/modules/workspace-shell/composables/useEditorPanesManager';
import { useWorkspaceCrashCheckpoint } from '@app/modules/workspace-shell/checkpoint/useWorkspaceCrashCheckpoint';
import { useBrowserWorkspaceRecovery } from '@app/modules/workspace-shell/checkpoint/useBrowserWorkspaceRecovery';

interface IAppShellResilienceOptions {
    documentRecordsByTabId: Ref<Record<string, IWorkspaceDocumentRecord>>;
    editorPanesManager: ReturnType<typeof useEditorPanesManager>;
    enabled: Ref<boolean>;
    browserEnabled: Ref<boolean>;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
}

export const useAppShellResilience = (options: IAppShellResilienceOptions) => {
    useWorkspaceCrashCheckpoint({
        ...options.editorPanesManager,
        enabled: options.enabled,
        workspaceRefs: options.workspaceRefs,
        documentRecordsByTabId: options.documentRecordsByTabId,
    });
    useBrowserWorkspaceRecovery({
        ...options.editorPanesManager,
        enabled: options.browserEnabled,
        workspaceRefs: options.workspaceRefs,
        documentRecordsByTabId: options.documentRecordsByTabId,
    });
};
