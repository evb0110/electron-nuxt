import type {
    IpcRenderer,
    IpcRendererEvent,
    webUtils,
} from 'electron';
import type { ISettingsData } from '@contracts/shared';
import type {
    IAppUpdateStatus,
    IElectronAPI,
    IMenuEventUnsubscribe,
    IRendererLogEntry,
} from '@contracts/electron-api';
import type {
    IWindowTabIncomingTransfer,
    IWindowTabTransferAck,
    IWindowTabTransferRequest,
    TWindowTabsAction,
} from '@contracts/window-tabs';
import { getDebugLogMessages } from '@electron/preload/debug-log-buffer';
import {createDocumentsPreloadClient} from '@electron/features/documents/preload-client';
import {createOcrPreloadClient} from '@electron/features/ocr/preload-client';
import {createSearchPreloadClient} from '@electron/features/search/preload-client';
import {createDjvuPreloadClient} from '@electron/features/djvu/preload-client';

const preloadStartupStart = Date.now();
const STARTUP_TRACE_ENABLED = process.env.EVB_STARTUP_TRACE === '1';

interface ICoreInvokeMap {
    'settings:get': {
        args: [];
        result: ISettingsData;
    };
    'settings:save': {
        args: [settings: ISettingsData];
        result: undefined;
    };
    'updates:getState': {
        args: [];
        result: IAppUpdateStatus;
    };
    'updates:check': {
        args: [];
        result: { started: boolean };
    };
    'updates:install': {
        args: [];
        result: { started: boolean };
    };
    'updates:defer': {
        args: [];
        result: undefined;
    };
    'updates:skipVersion': {
        args: [version: string];
        result: undefined;
    };
    'shell:openExternal': {
        args: [url: string];
        result: undefined;
    };
    'window:closeCurrent': {
        args: [];
        result: boolean;
    };
    'tabs:transfer': {
        args: [request: IWindowTabTransferRequest];
        result: Awaited<ReturnType<IElectronAPI['windowTabs']['transfer']>>;
    };
    'tabs:transferAck': {
        args: [ack: IWindowTabTransferAck];
        result: boolean;
    };
    'tabs:listTargets': {
        args: [];
        result: Awaited<ReturnType<IElectronAPI['windowTabs']['listTargetWindows']>>;
    };
    'tabs:showContextMenu': {
        args: [tabId: string];
        result: undefined;
    };
}

interface ICoreEventMap {
    'menu:openSettings': undefined;
    'updates:status': IAppUpdateStatus;
    'menu:checkForUpdates': undefined;
    'tabs:incomingTransfer': IWindowTabIncomingTransfer;
    'menu:windowTabsAction': TWindowTabsAction;
    'menu:newTab': undefined;
    'menu:closeTab': undefined;
    'menu:splitEditor': 'left' | 'right' | 'up' | 'down';
    'menu:focusEditorGroup': 'left' | 'right' | 'up' | 'down';
    'menu:moveTabToGroup': 'left' | 'right' | 'up' | 'down';
    'menu:copyTabToGroup': 'left' | 'right' | 'up' | 'down';
}

type TNoArgEventChannel = {
    [TChannel in keyof ICoreEventMap]: ICoreEventMap[TChannel] extends undefined ? TChannel : never;
}[keyof ICoreEventMap];

type TSingleArgEventChannel = Exclude<keyof ICoreEventMap, TNoArgEventChannel>;

function stringifyDetails(details?: Record<string, unknown>) {
    if (!details) {
        return '';
    }

    try {
        return ` details=${JSON.stringify(details)}`;
    } catch {
        return ' details=<unserializable>';
    }
}

function tracePreloadStartup(stage: string, details?: Record<string, unknown>) {
    if (!STARTUP_TRACE_ENABLED) {
        return;
    }

    const now = Date.now();
    const iso = new Date(now).toISOString();
    console.info(
        `[${iso}] [startup][preload] ${stage} (+${now - preloadStartupStart}ms from preload-api-init)`
        + stringifyDetails(details),
    );
}

async function invokeWithStartupTrace<T>(label: string, invoke: () => Promise<T>) {
    const startedAt = Date.now();
    tracePreloadStartup(`${label}:start`);
    try {
        const result = await invoke();
        tracePreloadStartup(`${label}:ok`, {durationMs: Date.now() - startedAt});
        return result;
    } catch (error) {
        tracePreloadStartup(`${label}:error`, {
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
}

function invokeCore<TChannel extends keyof ICoreInvokeMap>(
    ipcRenderer: IpcRenderer,
    channel: TChannel,
    ...args: ICoreInvokeMap[TChannel]['args']
): Promise<ICoreInvokeMap[TChannel]['result']> {
    return ipcRenderer.invoke(channel, ...args) as Promise<ICoreInvokeMap[TChannel]['result']>;
}

function onNoArgEvent(
    ipcRenderer: IpcRenderer,
    channel: TNoArgEventChannel,
    callback: () => void,
): IMenuEventUnsubscribe {
    const handler = (_event: IpcRendererEvent) => callback();
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

function onSingleArgEvent<TChannel extends TSingleArgEventChannel>(
    ipcRenderer: IpcRenderer,
    channel: TChannel,
    callback: (arg: ICoreEventMap[TChannel]) => void,
): IMenuEventUnsubscribe {
    const handler = (_event: IpcRendererEvent, arg: ICoreEventMap[TChannel]) => callback(arg);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

export function createElectronApi(ipcRenderer: IpcRenderer, electronWebUtils: typeof webUtils): IElectronAPI {
    const baseDocuments = createDocumentsPreloadClient(ipcRenderer);

    const api = {
        documents: {
            ...baseDocuments,
            recentFiles: {
                ...baseDocuments.recentFiles,
                get: () => invokeWithStartupTrace('recent-files:get', () => baseDocuments.recentFiles.get()),
            },
            getPathForFile: (file: File) => electronWebUtils.getPathForFile(file),
        },

        ocr: createOcrPreloadClient(ipcRenderer),

        search: createSearchPreloadClient(ipcRenderer),

        djvu: createDjvuPreloadClient(ipcRenderer),

        settings: {
            get: () => invokeWithStartupTrace('settings:get', () => invokeCore(ipcRenderer, 'settings:get')),
            save: (settings: ISettingsData) => invokeCore(ipcRenderer, 'settings:save', settings),
            getDebugLogs: () => Promise.resolve(getDebugLogMessages()),
            rendererLog: (entry: IRendererLogEntry) => ipcRenderer.send('renderer:log', entry),
            onMenuOpenSettings: (callback): IMenuEventUnsubscribe =>
                onNoArgEvent(ipcRenderer, 'menu:openSettings', callback),
        },

        updates: {
            getState: () => invokeCore(ipcRenderer, 'updates:getState'),
            check: () => invokeCore(ipcRenderer, 'updates:check'),
            install: () => invokeCore(ipcRenderer, 'updates:install'),
            defer: () => invokeCore(ipcRenderer, 'updates:defer'),
            skipVersion: (version: string) => invokeCore(ipcRenderer, 'updates:skipVersion', version),
            onStatus: (callback): IMenuEventUnsubscribe =>
                onSingleArgEvent(ipcRenderer, 'updates:status', callback),
            onMenuCheckForUpdates: (callback): IMenuEventUnsubscribe =>
                onNoArgEvent(ipcRenderer, 'menu:checkForUpdates', callback),
        },

        shell: {openExternal: (url: string) => invokeCore(ipcRenderer, 'shell:openExternal', url)},

        windowTabs: {
            closeCurrentWindow: () => invokeCore(ipcRenderer, 'window:closeCurrent'),
            notifyRendererReady: () => {
                tracePreloadStartup('app:rendererReady dispatched');
                ipcRenderer.send('app:rendererReady');
            },
            transfer: (request: IWindowTabTransferRequest) => invokeCore(ipcRenderer, 'tabs:transfer', request),
            transferAck: (ack: IWindowTabTransferAck) => invokeCore(ipcRenderer, 'tabs:transferAck', ack),
            listTargetWindows: () => invokeCore(ipcRenderer, 'tabs:listTargets'),
            showContextMenu: (tabId: string) => invokeCore(ipcRenderer, 'tabs:showContextMenu', tabId),
            onIncomingTransfer: (callback): IMenuEventUnsubscribe =>
                onSingleArgEvent(ipcRenderer, 'tabs:incomingTransfer', callback),
            onWindowAction: (callback): IMenuEventUnsubscribe =>
                onSingleArgEvent(ipcRenderer, 'menu:windowTabsAction', callback),
            onMenuNewTab: (callback): IMenuEventUnsubscribe =>
                onNoArgEvent(ipcRenderer, 'menu:newTab', callback),
            onMenuCloseTab: (callback): IMenuEventUnsubscribe =>
                onNoArgEvent(ipcRenderer, 'menu:closeTab', callback),
            onMenuSplitEditor: (callback): IMenuEventUnsubscribe =>
                onSingleArgEvent(ipcRenderer, 'menu:splitEditor', callback),
            onMenuFocusEditorGroup: (callback): IMenuEventUnsubscribe =>
                onSingleArgEvent(ipcRenderer, 'menu:focusEditorGroup', callback),
            onMenuMoveTabToGroup: (callback): IMenuEventUnsubscribe =>
                onSingleArgEvent(ipcRenderer, 'menu:moveTabToGroup', callback),
            onMenuCopyTabToGroup: (callback): IMenuEventUnsubscribe =>
                onSingleArgEvent(ipcRenderer, 'menu:copyTabToGroup', callback),
        },
    } satisfies IElectronAPI;

    return api;
}
