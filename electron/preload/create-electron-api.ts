import type {
    IpcRenderer,
    IpcRendererEvent,
    webUtils,
} from 'electron';
import type { ISettingsData } from '@contracts/shared';
import type {
    IAppUpdateStatus,
    IElectronAPI,
    IMenuEventCallback,
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

function onNoArgEvent(ipcRenderer: IpcRenderer, channel: string, callback: IMenuEventCallback): IMenuEventUnsubscribe {
    const handler = (_event: IpcRendererEvent) => callback();
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

function onSingleArgEvent<T>(
    ipcRenderer: IpcRenderer,
    channel: string,
    callback: (arg: T) => void,
): IMenuEventUnsubscribe {
    const handler = (_event: IpcRendererEvent, arg: T) => callback(arg);
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
            get: () => invokeWithStartupTrace('settings:get', () => ipcRenderer.invoke('settings:get')),
            save: (settings: ISettingsData) => ipcRenderer.invoke('settings:save', settings),
            getDebugLogs: () => Promise.resolve(getDebugLogMessages()),
            rendererLog: (entry: IRendererLogEntry) => ipcRenderer.send('renderer:log', entry),
            onMenuOpenSettings: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
                onNoArgEvent(ipcRenderer, 'menu:openSettings', callback),
        },

        updates: {
            getState: () => ipcRenderer.invoke('updates:getState'),
            check: () => ipcRenderer.invoke('updates:check'),
            install: () => ipcRenderer.invoke('updates:install'),
            defer: () => ipcRenderer.invoke('updates:defer'),
            skipVersion: (version: string) => ipcRenderer.invoke('updates:skipVersion', version),
            onStatus: (callback: (status: IAppUpdateStatus) => void): IMenuEventUnsubscribe =>
                onSingleArgEvent(ipcRenderer, 'updates:status', callback),
            onMenuCheckForUpdates: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
                onNoArgEvent(ipcRenderer, 'menu:checkForUpdates', callback),
        },

        shell: {openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url)},

        windowTabs: {
            closeCurrentWindow: () => ipcRenderer.invoke('window:closeCurrent'),
            notifyRendererReady: () => {
                tracePreloadStartup('app:rendererReady dispatched');
                ipcRenderer.send('app:rendererReady');
            },
            transfer: (request: IWindowTabTransferRequest) => ipcRenderer.invoke('tabs:transfer', request),
            transferAck: (ack: IWindowTabTransferAck) => ipcRenderer.invoke('tabs:transferAck', ack),
            listTargetWindows: () => ipcRenderer.invoke('tabs:listTargets'),
            showContextMenu: (tabId: string) => ipcRenderer.invoke('tabs:showContextMenu', tabId),
            onIncomingTransfer: (callback: (transfer: IWindowTabIncomingTransfer) => void): IMenuEventUnsubscribe =>
                onSingleArgEvent(ipcRenderer, 'tabs:incomingTransfer', callback),
            onWindowAction: (callback: (action: TWindowTabsAction) => void): IMenuEventUnsubscribe =>
                onSingleArgEvent(ipcRenderer, 'menu:windowTabsAction', callback),
            onMenuNewTab: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
                onNoArgEvent(ipcRenderer, 'menu:newTab', callback),
            onMenuCloseTab: (callback: IMenuEventCallback): IMenuEventUnsubscribe =>
                onNoArgEvent(ipcRenderer, 'menu:closeTab', callback),
            onMenuSplitEditor: (callback: (direction: 'left' | 'right' | 'up' | 'down') => void): IMenuEventUnsubscribe =>
                onSingleArgEvent(ipcRenderer, 'menu:splitEditor', callback),
            onMenuFocusEditorGroup: (callback: (direction: 'left' | 'right' | 'up' | 'down') => void): IMenuEventUnsubscribe =>
                onSingleArgEvent(ipcRenderer, 'menu:focusEditorGroup', callback),
            onMenuMoveTabToGroup: (callback: (direction: 'left' | 'right' | 'up' | 'down') => void): IMenuEventUnsubscribe =>
                onSingleArgEvent(ipcRenderer, 'menu:moveTabToGroup', callback),
            onMenuCopyTabToGroup: (callback: (direction: 'left' | 'right' | 'up' | 'down') => void): IMenuEventUnsubscribe =>
                onSingleArgEvent(ipcRenderer, 'menu:copyTabToGroup', callback),
        },
    } satisfies IElectronAPI;

    return api;
}
