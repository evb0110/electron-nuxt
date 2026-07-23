import type { IDebugLogEntry } from '@contracts/electronApiCommon';
import type { TPaneDirection } from '@contracts/editorPanes';
import type {
    IWindowTabIncomingTransfer,
    IWindowTabTargetWindow,
    IWindowTabTransferAck,
    IWindowTabTransferRequest,
    IWindowTabTransferResult,
    TWindowTabsAction,
} from '@contracts/windowTabs';
import type { IWorkspaceCheckpoint } from '@contracts/workspaceCheckpoint';

export const CORE_IPC_CHANNELS = {
    windowCloseCurrent: 'window:closeCurrent',
    rendererReady: 'app:rendererReady',
    claimPendingExternalOpenPaths: 'app:claimPendingExternalOpenPaths',
    acknowledgePendingExternalOpenPaths: 'app:acknowledgePendingExternalOpenPaths',
    workspaceCheckpointSave: 'workspace:checkpointSave',
    workspaceCheckpointClaim: 'workspace:checkpointClaim',
    tabsTransfer: 'tabs:transfer',
    tabsTransferAck: 'tabs:transferAck',
    tabsListTargets: 'tabs:listTargets',
    tabsShowContextMenu: 'tabs:showContextMenu',
} as const;

export const CORE_IPC_EVENT_CHANNELS = {
    menuOpenSettings: 'menu:openSettings',
    menuCheckForUpdates: 'menu:checkForUpdates',
    tabsIncomingTransfer: 'tabs:incomingTransfer',
    menuWindowTabsAction: 'menu:windowTabsAction',
    menuNewTab: 'menu:newTab',
    menuCloseTab: 'menu:closeTab',
    menuSplitEditor: 'menu:splitEditor',
    menuFocusEditorPane: 'menu:focusEditorPane',
    menuMoveTabToPane: 'menu:moveTabToPane',
    menuCopyTabToPane: 'menu:copyTabToPane',
    debugLog: 'debug:log',
    shutdownSaveFlushRequest: 'shutdown:saveFlushRequest',
} as const;

export const CORE_IPC_SEND_CHANNELS = {
    rendererLog: 'renderer:log',
    shutdownSaveFlushResult: 'shutdown:saveFlushResult',
} as const;

type TNoIpcResult = Awaited<Promise<void>>;

export interface ICoreInvokeMap {
    [CORE_IPC_CHANNELS.windowCloseCurrent]: {
        args: [];
        result: boolean;
    };
    [CORE_IPC_CHANNELS.claimPendingExternalOpenPaths]: {
        args: [];
        result: string[];
    };
    [CORE_IPC_CHANNELS.acknowledgePendingExternalOpenPaths]: {
        args: [failedPaths: string[]];
        result: TNoIpcResult;
    };
    [CORE_IPC_CHANNELS.workspaceCheckpointSave]: {
        args: [checkpoint: IWorkspaceCheckpoint];
        result: TNoIpcResult;
    };
    [CORE_IPC_CHANNELS.workspaceCheckpointClaim]: {
        args: [];
        result: IWorkspaceCheckpoint | null;
    };
    [CORE_IPC_CHANNELS.tabsTransfer]: {
        args: [request: IWindowTabTransferRequest];
        result: IWindowTabTransferResult;
    };
    [CORE_IPC_CHANNELS.tabsTransferAck]: {
        args: [ack: IWindowTabTransferAck];
        result: boolean;
    };
    [CORE_IPC_CHANNELS.tabsListTargets]: {
        args: [];
        result: IWindowTabTargetWindow[];
    };
    [CORE_IPC_CHANNELS.tabsShowContextMenu]: {
        args: [tabId: string];
        result: TNoIpcResult;
    };
}

export interface ICoreEventMap {
    [CORE_IPC_EVENT_CHANNELS.menuOpenSettings]: undefined;
    [CORE_IPC_EVENT_CHANNELS.menuCheckForUpdates]: undefined;
    [CORE_IPC_EVENT_CHANNELS.tabsIncomingTransfer]: IWindowTabIncomingTransfer;
    [CORE_IPC_EVENT_CHANNELS.menuWindowTabsAction]: TWindowTabsAction;
    [CORE_IPC_EVENT_CHANNELS.menuNewTab]: undefined;
    [CORE_IPC_EVENT_CHANNELS.menuCloseTab]: undefined;
    [CORE_IPC_EVENT_CHANNELS.menuSplitEditor]: TPaneDirection;
    [CORE_IPC_EVENT_CHANNELS.menuFocusEditorPane]: TPaneDirection;
    [CORE_IPC_EVENT_CHANNELS.menuMoveTabToPane]: TPaneDirection;
    [CORE_IPC_EVENT_CHANNELS.menuCopyTabToPane]: TPaneDirection;
    [CORE_IPC_EVENT_CHANNELS.debugLog]: IDebugLogEntry;
    [CORE_IPC_EVENT_CHANNELS.shutdownSaveFlushRequest]: IShutdownSaveFlushRequest;
}

export interface IShutdownSaveFlushRequest { requestId: string; }

export interface IShutdownSaveFlushResult {
    requestId: string;
    dirtyWorkingCopyPaths?: string[];
    error?: string;
    flushedWorkingCopyPaths?: string[];
}
