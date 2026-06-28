import type { IDebugLogEntry } from '@contracts/electronApiCommon';
import type {
    IHostEnvironmentSnapshot,
    IHostZenModeState,
} from '@contracts/electronApiHost';
import type { IAppUpdateStatus } from '@contracts/electronApiUpdates';
import type { TPaneDirection } from '@contracts/editorPanes';
import type { ISettingsData } from '@contracts/shared';
import type {
    IWindowTabIncomingTransfer,
    IWindowTabTargetWindow,
    IWindowTabTransferAck,
    IWindowTabTransferRequest,
    IWindowTabTransferResult,
    TWindowTabsAction,
} from '@contracts/windowTabs';

export const CORE_IPC_CHANNELS = {
    settingsGet: 'settings:get',
    settingsSave: 'settings:save',
    updatesGetState: 'updates:getState',
    updatesCheck: 'updates:check',
    updatesInstall: 'updates:install',
    updatesDefer: 'updates:defer',
    updatesSkipVersion: 'updates:skipVersion',
    shellOpenExternal: 'shell:openExternal',
    windowCloseCurrent: 'window:closeCurrent',
    rendererReady: 'app:rendererReady',
    claimPendingExternalOpenPaths: 'app:claimPendingExternalOpenPaths',
    acknowledgePendingExternalOpenPaths: 'app:acknowledgePendingExternalOpenPaths',
    tabsTransfer: 'tabs:transfer',
    tabsTransferAck: 'tabs:transferAck',
    tabsListTargets: 'tabs:listTargets',
    tabsShowContextMenu: 'tabs:showContextMenu',
    hostGetEnvironment: 'host:getEnvironment',
    hostGetZenModeState: 'host:getZenModeState',
    hostSetZenMode: 'host:setZenMode',
} as const;

export const CORE_IPC_EVENT_CHANNELS = {
    menuOpenSettings: 'menu:openSettings',
    updatesStatus: 'updates:status',
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
    hostEnvironmentChanged: 'host:environmentChanged',
    hostZenModeChanged: 'host:zenModeChanged',
} as const;

export const CORE_IPC_SEND_CHANNELS = {rendererLog: 'renderer:log'} as const;

type TNoIpcResult = Awaited<Promise<void>>;

export interface ICoreInvokeMap {
    [CORE_IPC_CHANNELS.settingsGet]: {
        args: [];
        result: ISettingsData;
    };
    [CORE_IPC_CHANNELS.settingsSave]: {
        args: [settings: Partial<ISettingsData>];
        result: TNoIpcResult;
    };
    [CORE_IPC_CHANNELS.updatesGetState]: {
        args: [];
        result: IAppUpdateStatus;
    };
    [CORE_IPC_CHANNELS.updatesCheck]: {
        args: [];
        result: {started: boolean};
    };
    [CORE_IPC_CHANNELS.updatesInstall]: {
        args: [];
        result: {started: boolean};
    };
    [CORE_IPC_CHANNELS.updatesDefer]: {
        args: [];
        result: TNoIpcResult;
    };
    [CORE_IPC_CHANNELS.updatesSkipVersion]: {
        args: [version: string];
        result: TNoIpcResult;
    };
    [CORE_IPC_CHANNELS.shellOpenExternal]: {
        args: [url: string];
        result: TNoIpcResult;
    };
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
    [CORE_IPC_CHANNELS.hostGetEnvironment]: {
        args: [];
        result: IHostEnvironmentSnapshot;
    };
    [CORE_IPC_CHANNELS.hostGetZenModeState]: {
        args: [];
        result: IHostZenModeState;
    };
    [CORE_IPC_CHANNELS.hostSetZenMode]: {
        args: [active: boolean];
        result: IHostZenModeState;
    };
}

export interface ICoreEventMap {
    [CORE_IPC_EVENT_CHANNELS.menuOpenSettings]: undefined;
    [CORE_IPC_EVENT_CHANNELS.updatesStatus]: IAppUpdateStatus;
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
    [CORE_IPC_EVENT_CHANNELS.hostEnvironmentChanged]: IHostEnvironmentSnapshot;
    [CORE_IPC_EVENT_CHANNELS.hostZenModeChanged]: IHostZenModeState;
}
