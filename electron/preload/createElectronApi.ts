import type {
    IpcRenderer,
    webUtils,
} from 'electron';
import type { ISettingsData } from '@contracts/shared';
import type { IElectronAPI } from '@contracts/electronApi';
import type {
    IMenuEventUnsubscribe,
    IRendererLogEntry,
} from '@contracts/electronApiCommon';
import type {
    IWindowTabTransferAck,
    IWindowTabTransferRequest,
} from '@contracts/windowTabs';
import { getDebugLogMessages } from '@electron/preload/debugLogBuffer';
import {createDocumentsPreloadClient} from '@electron/features/documents/preloadClient';
import { createDocumentsPreloadPageOpsClient } from '@electron/features/documents/preloadPageOpsClient';
import { createImageExportPreloadClient } from '@electron/features/image-export/preloadClient';
import {
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import {createOcrPreloadClient} from '@electron/features/ocr/preloadClient';
import {createSearchPreloadClient} from '@electron/features/search/preloadClient';
import {createDjvuPreloadClient} from '@electron/features/djvu/preloadClient';
import {
    createTypedIpcEventSubscriber,
    createTypedIpcInvoker,
} from '@electron/preload/ipcClient';
import { getErrorMessage } from '@electron/utils/error';
import {
    CORE_IPC_CHANNELS,
    CORE_IPC_EVENT_CHANNELS,
    CORE_IPC_SEND_CHANNELS,
    type ICoreEventMap,
    type ICoreInvokeMap,
} from '@electron/ipc/coreContract';

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
            error: getErrorMessage(error),
        });
        throw error;
    }
}

export function createElectronApi(ipcRenderer: IpcRenderer, electronWebUtils: typeof webUtils): IElectronAPI {
    const invokeCore = createTypedIpcInvoker<ICoreInvokeMap>(ipcRenderer);
    const invokeDocuments = createTypedIpcInvoker<IDocumentsInvokeMap>(ipcRenderer);
    const eventSubscriber = createTypedIpcEventSubscriber<ICoreEventMap>(ipcRenderer);
    const baseDocuments = createDocumentsPreloadClient(ipcRenderer);
    const pageOps = createDocumentsPreloadPageOpsClient(ipcRenderer);
    const imageExport = createImageExportPreloadClient(ipcRenderer);
    const pendingRendererFileOpenAllows = new Map<string, Promise<unknown>>();

    function allowRendererFileOpen(filePath: string) {
        const rendererFileOpenToken = globalThis.crypto.randomUUID();
        const allowPromise = invokeDocuments(
            DOCUMENTS_CHANNELS.registerRendererFileOpenToken,
            rendererFileOpenToken,
        )
            .then(() => invokeDocuments(DOCUMENTS_CHANNELS.allowRendererFileOpen, {
                filePath,
                token: rendererFileOpenToken,
            }))
            .finally(() => {
                pendingRendererFileOpenAllows.delete(filePath);
            });
        pendingRendererFileOpenAllows.set(filePath, allowPromise);
        return allowPromise;
    }

    const documents = {
        ...baseDocuments,
        openPdfDirect: async (path: string) => {
            const pendingAllow = pendingRendererFileOpenAllows.get(path);
            if (pendingAllow) {
                await pendingAllow;
            }
            return baseDocuments.openPdfDirect(path);
        },
        openPdfDirectBatch: async (paths: string[], requestId?: string) => {
            await Promise.all(paths.map(path => pendingRendererFileOpenAllows.get(path)).filter(Boolean));
            return baseDocuments.openPdfDirectBatch(paths, requestId);
        },
        recentFiles: {
            ...baseDocuments.recentFiles,
            get: () => invokeWithStartupTrace('recentFiles:get', () => baseDocuments.recentFiles.get()),
        },
        getPathForFile: (file: File) => {
            const filePath = electronWebUtils.getPathForFile(file);
            if (filePath) {
                void allowRendererFileOpen(filePath);
            }
            return filePath;
        },
    };

    const legacyDocuments = {
        ...documents,
        ...imageExport,
        pageOps,
    };

    const api = {
        documents: legacyDocuments,
        pageOps,
        imageExport,

        ocr: createOcrPreloadClient(ipcRenderer),

        search: createSearchPreloadClient(ipcRenderer),

        djvu: createDjvuPreloadClient(ipcRenderer),

        settings: {
            get: () => invokeWithStartupTrace('settings:get', () => invokeCore(CORE_IPC_CHANNELS.settingsGet)),
            save: (settings: Partial<ISettingsData>) => invokeCore(CORE_IPC_CHANNELS.settingsSave, settings),
            getDebugLogs: () => Promise.resolve(getDebugLogMessages()),
            onDebugLog: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onPayload(CORE_IPC_EVENT_CHANNELS.debugLog, callback),
            rendererLog: (entry: IRendererLogEntry) => ipcRenderer.send(CORE_IPC_SEND_CHANNELS.rendererLog, entry),
            onMenuOpenSettings: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onNoArg(CORE_IPC_EVENT_CHANNELS.menuOpenSettings, callback),
        },

        updates: {
            getState: () => invokeCore(CORE_IPC_CHANNELS.updatesGetState),
            check: () => invokeCore(CORE_IPC_CHANNELS.updatesCheck),
            install: () => invokeCore(CORE_IPC_CHANNELS.updatesInstall),
            defer: () => invokeCore(CORE_IPC_CHANNELS.updatesDefer),
            skipVersion: (version: string) => invokeCore(CORE_IPC_CHANNELS.updatesSkipVersion, version),
            onStatus: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onPayload(CORE_IPC_EVENT_CHANNELS.updatesStatus, callback),
            onMenuCheckForUpdates: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onNoArg(CORE_IPC_EVENT_CHANNELS.menuCheckForUpdates, callback),
        },

        shell: {openExternal: (url: string) => invokeCore(CORE_IPC_CHANNELS.shellOpenExternal, url)},

        host: {
            getEnvironment: () => invokeCore(CORE_IPC_CHANNELS.hostGetEnvironment),
            onEnvironmentChange: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onPayload(CORE_IPC_EVENT_CHANNELS.hostEnvironmentChanged, callback),
            getZenModeState: () => invokeCore(CORE_IPC_CHANNELS.hostGetZenModeState),
            setZenMode: (active: boolean) => invokeCore(CORE_IPC_CHANNELS.hostSetZenMode, active),
            onZenModeChange: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onPayload(CORE_IPC_EVENT_CHANNELS.hostZenModeChanged, callback),
        },

        windowTabs: {
            closeCurrentWindow: () => invokeCore(CORE_IPC_CHANNELS.windowCloseCurrent),
            notifyRendererReady: () => {
                tracePreloadStartup('app:rendererReady dispatched');
                ipcRenderer.send(CORE_IPC_CHANNELS.rendererReady);
            },
            claimPendingExternalOpenPaths: () => invokeWithStartupTrace(
                'app:claimPendingExternalOpenPaths',
                () => invokeCore(CORE_IPC_CHANNELS.claimPendingExternalOpenPaths),
            ),
            transfer: (request: IWindowTabTransferRequest) => invokeCore(CORE_IPC_CHANNELS.tabsTransfer, request),
            transferAck: (ack: IWindowTabTransferAck) => invokeCore(CORE_IPC_CHANNELS.tabsTransferAck, ack),
            listTargetWindows: () => invokeCore(CORE_IPC_CHANNELS.tabsListTargets),
            showContextMenu: (tabId: string) => invokeCore(CORE_IPC_CHANNELS.tabsShowContextMenu, tabId),
            onIncomingTransfer: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onPayload(CORE_IPC_EVENT_CHANNELS.tabsIncomingTransfer, callback),
            onWindowAction: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onPayload(CORE_IPC_EVENT_CHANNELS.menuWindowTabsAction, callback),
            onMenuNewTab: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onNoArg(CORE_IPC_EVENT_CHANNELS.menuNewTab, callback),
            onMenuCloseTab: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onNoArg(CORE_IPC_EVENT_CHANNELS.menuCloseTab, callback),
            onMenuSplitEditor: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onPayload(CORE_IPC_EVENT_CHANNELS.menuSplitEditor, callback),
            onMenuFocusEditorGroup: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onPayload(CORE_IPC_EVENT_CHANNELS.menuFocusEditorGroup, callback),
            onMenuMoveTabToGroup: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onPayload(CORE_IPC_EVENT_CHANNELS.menuMoveTabToGroup, callback),
            onMenuCopyTabToGroup: (callback): IMenuEventUnsubscribe =>
                eventSubscriber.onPayload(CORE_IPC_EVENT_CHANNELS.menuCopyTabToGroup, callback),
        },
    } satisfies IElectronAPI;

    return api;
}
