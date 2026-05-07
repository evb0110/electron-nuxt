import type {
    IpcRenderer,
    webUtils,
} from 'electron';
import type { ISettingsData } from '@contracts/shared';
import type {
    IAppUpdateStatus,
    IDebugLogEntry,
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
import {
    createTypedIpcEventSubscriber,
    createTypedIpcInvoker,
} from '@electron/preload/ipc-client';
import { getErrorMessage } from '@electron/utils/error';

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
    'app:claimPendingExternalOpenPaths': {
        args: [];
        result: string[];
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
    'debug:log': IDebugLogEntry;
}

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
            error: getErrorMessage(error),
        });
        throw error;
    }
}

export function createElectronApi(ipcRenderer: IpcRenderer, electronWebUtils: typeof webUtils): IElectronAPI {
    const invokeCore = createTypedIpcInvoker<ICoreInvokeMap>(ipcRenderer);
    const eventSubscriber = createTypedIpcEventSubscriber<ICoreEventMap>(ipcRenderer);
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
            get: () => invokeWithStartupTrace('settings:get', () => invokeCore('settings:get')),
            save: (settings: ISettingsData) => invokeCore('settings:save', settings),
            getDebugLogs: () => Promise.resolve(getDebugLogMessages()),
            onDebugLog: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onPayload('debug:log', callback),
            rendererLog: (entry: IRendererLogEntry) => ipcRenderer.send('renderer:log', entry),
            onMenuOpenSettings: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onNoArg('menu:openSettings', callback),
        },

        updates: {
            getState: () => invokeCore('updates:getState'),
            check: () => invokeCore('updates:check'),
            install: () => invokeCore('updates:install'),
            defer: () => invokeCore('updates:defer'),
            skipVersion: (version: string) => invokeCore('updates:skipVersion', version),
            onStatus: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onPayload('updates:status', callback),
            onMenuCheckForUpdates: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onNoArg('menu:checkForUpdates', callback),
        },

        shell: {openExternal: (url: string) => invokeCore('shell:openExternal', url)},

        windowTabs: {
            closeCurrentWindow: () => invokeCore('window:closeCurrent'),
            notifyRendererReady: () => {
                tracePreloadStartup('app:rendererReady dispatched');
                ipcRenderer.send('app:rendererReady');
            },
            claimPendingExternalOpenPaths: () => invokeWithStartupTrace(
                'app:claimPendingExternalOpenPaths',
                () => invokeCore('app:claimPendingExternalOpenPaths'),
            ),
            transfer: (request: IWindowTabTransferRequest) => invokeCore('tabs:transfer', request),
            transferAck: (ack: IWindowTabTransferAck) => invokeCore('tabs:transferAck', ack),
            listTargetWindows: () => invokeCore('tabs:listTargets'),
            showContextMenu: (tabId: string) => invokeCore('tabs:showContextMenu', tabId),
            onIncomingTransfer: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onPayload('tabs:incomingTransfer', callback),
            onWindowAction: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onPayload('menu:windowTabsAction', callback),
            onMenuNewTab: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onNoArg('menu:newTab', callback),
            onMenuCloseTab: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onNoArg('menu:closeTab', callback),
            onMenuSplitEditor: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onPayload('menu:splitEditor', callback),
            onMenuFocusEditorGroup: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onPayload('menu:focusEditorGroup', callback),
            onMenuMoveTabToGroup: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onPayload('menu:moveTabToGroup', callback),
            onMenuCopyTabToGroup: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onPayload('menu:copyTabToGroup', callback),
        },
    } satisfies IElectronAPI;

    return api;
}
