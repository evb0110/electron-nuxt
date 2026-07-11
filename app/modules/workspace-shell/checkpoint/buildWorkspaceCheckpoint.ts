import type { Ref } from 'vue';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import type { IWorkspaceCheckpoint } from '@contracts/workspaceCheckpoint';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { IWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { buildAgentWorkspaceSnapshot } from '@app/modules/workspace-shell/agent/buildAgentWorkspaceSnapshot';

interface IBuildWorkspaceCheckpointOptions {
    panes: Ref<IEditorPaneState[]>;
    tabs: Ref<ITab[]>;
    layout: Ref<TEditorLayoutNode | null>;
    activePaneId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
    documentRecordsByTabId: Ref<Record<string, IWorkspaceDocumentRecord>>;
    getPaneByTabId(tabId: string): IEditorPaneState | null;
}

function readWorkspaceDocumentRefs(workspace: IWorkspaceExpose | null) {
    try {
        const snapshot = workspace?.getAutomationStateSnapshot();
        return {
            sourceRef: snapshot?.originalPath ?? null,
            workingCopyRef: snapshot?.workingCopyPath ?? null,
        };
    } catch {
        return {
            sourceRef: null,
            workingCopyRef: null,
        };
    }
}

export function buildWorkspaceCheckpoint(
    options: IBuildWorkspaceCheckpointOptions,
): IWorkspaceCheckpoint {
    const workspaceSnapshot = buildAgentWorkspaceSnapshot(options);
    const tabById = new Map(options.tabs.value.map(tab => [
        tab.id,
        tab,
    ]));

    return {
        version: 1,
        capturedAt: Date.now(),
        activePaneId: workspaceSnapshot.activePaneId,
        activeTabId: workspaceSnapshot.activeTabId,
        layout: workspaceSnapshot.layout,
        panes: workspaceSnapshot.panes.map(pane => ({
            paneId: pane.paneId,
            tabIds: [...pane.tabIds],
            activeTabId: pane.activeTabId,
        })),
        tabs: workspaceSnapshot.tabs.map((snapshot) => {
            const tab = tabById.get(snapshot.tabId);
            const workspace = options.workspaceRefs.value.get(snapshot.tabId) ?? null;
            const documentRefs = readWorkspaceDocumentRefs(workspace);
            const toolbar = options.documentRecordsByTabId.value[snapshot.tabId]?.toolbarSnapshot
                ?? (() => {
                    try {
                        return workspace?.getToolbarSnapshot() ?? null;
                    } catch {
                        return null;
                    }
                })();
            return {
                tabId: snapshot.tabId,
                paneId: snapshot.paneId,
                fileName: snapshot.fileName,
                sourceRef: documentRefs.sourceRef ?? tab?.originalPath ?? null,
                workingCopyRef: documentRefs.workingCopyRef,
                isDirty: snapshot.isDirty,
                isDjvu: snapshot.isDjvu,
                currentPage: toolbar?.hasPdf ? toolbar.currentPage : null,
                zoom: toolbar?.hasPdf ? toolbar.zoom : null,
                zoomMode: toolbar?.hasPdf ? toolbar.zoomMode : null,
                continuousScroll: toolbar?.hasPdf ? toolbar.continuousScroll : null,
                viewMode: toolbar?.hasPdf ? toolbar.viewMode : null,
            };
        }),
    };
}
