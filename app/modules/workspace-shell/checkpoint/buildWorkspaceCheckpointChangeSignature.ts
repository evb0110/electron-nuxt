import type { Ref } from 'vue';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { IWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';

interface IBuildWorkspaceCheckpointSignatureOptions {
    panes: Ref<IEditorPaneState[]>;
    tabs: Ref<ITab[]>;
    layout: Ref<TEditorLayoutNode | null>;
    activePaneId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    workspaceRefs: Ref<Map<string, IWorkspaceExpose>>;
    documentRecordsByTabId: Ref<Record<string, IWorkspaceDocumentRecord>>;
    getPaneByTabId(tabId: string): IEditorPaneState | null;
}

export interface IWorkspaceCheckpointChangeSignature {
    workspace: string;
    tabSignatures: Map<string, string>;
}

function buildTabSignature(
    tab: ITab,
    paneId: string | null,
    mounted: boolean,
    record: IWorkspaceDocumentRecord | undefined,
) {
    const toolbar = record?.toolbarSnapshot ?? null;
    const identity = record?.documentIdentity ?? null;
    return JSON.stringify([
        tab.id,
        paneId,
        tab.fileName,
        tab.originalPath,
        tab.isDirty,
        tab.isDjvu,
        mounted,
        record?.tab.fileName ?? null,
        record?.tab.originalPath ?? null,
        identity?.token ?? null,
        identity?.documentRef ?? null,
        identity?.contentRevision ?? null,
        identity?.authority ?? null,
        toolbar?.hasPdf ?? null,
        toolbar?.currentPage ?? null,
        toolbar?.zoom ?? null,
        toolbar?.zoomMode ?? null,
        toolbar?.continuousScroll ?? null,
        toolbar?.viewMode ?? null,
    ]);
}

// Distills every field the persisted checkpoint depends on into a cheap string
// (the document revision identity stands in for the automation-owned
// source/working-copy refs it derives from), so checkpoint watchers can detect
// changes without rebuilding and serializing the full checkpoint per reactive
// tick. The field lists here must track buildWorkspaceCheckpoint's inputs: a
// checkpoint-relevant field missing from the signature delays re-persistence
// until any other watched field changes.
export function buildWorkspaceCheckpointChangeSignature(
    options: IBuildWorkspaceCheckpointSignatureOptions,
): IWorkspaceCheckpointChangeSignature {
    const records = options.documentRecordsByTabId.value;
    const mountedWorkspaces = options.workspaceRefs.value;
    const tabSignatures = new Map(options.tabs.value.map(tab => [
        tab.id,
        buildTabSignature(
            tab,
            options.getPaneByTabId(tab.id)?.paneId ?? null,
            mountedWorkspaces.has(tab.id),
            records[tab.id],
        ),
    ]));
    const workspace = JSON.stringify([
        options.activePaneId.value,
        options.activeTabId.value,
        options.layout.value,
        options.panes.value.map(pane => [
            pane.paneId,
            pane.activeTabId,
            ...pane.tabIds,
        ]),
        [...tabSignatures.values()],
    ]);
    return {
        workspace,
        tabSignatures,
    };
}
