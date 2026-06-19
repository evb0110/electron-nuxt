import type {
    IpcRenderer,
    webUtils,
} from 'electron';
import { compact } from 'es-toolkit/array';
import type { IElectronAPI } from '@contracts/electronApi';
import type { TMenuEventUnsubscribe } from '@contracts/electronApiCommon';
import { sanitizeSettings } from '@contracts/settings';
import { getDebugLogMessages } from '@electron/preload/debugLogBuffer';
import {createDocumentsPreloadClient} from '@electron/features/documents/createDocumentsPreloadClient';
import { createDocumentsPreloadPageOpsClient } from '@electron/features/documents/createDocumentsPreloadPageOpsClient';
import { createImageExportPreloadClient } from '@electron/features/image-export/createImageExportPreloadClient';
import {
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import {createOcrPreloadClient} from '@electron/features/ocr/createOcrPreloadClient';
import {createSearchPreloadClient} from '@electron/features/search/createSearchPreloadClient';
import {createDjvuPreloadClient} from '@electron/features/djvu/createDjvuPreloadClient';
import {
    createDecodedIpcInvoker,
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
} from '@electron/platform-ipc/coreContract';

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

function readSystemMemoryInfo() {
    if (typeof process.getSystemMemoryInfo !== 'function') {
        return null;
    }

    const memoryInfo = process.getSystemMemoryInfo();
    const total = Number(memoryInfo.total);
    const free = Number(memoryInfo.free);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(free) || free < 0) {
        return null;
    }

    return {
        totalBytes: Math.round(total * 1024),
        freeBytes: Math.round(free * 1024),
    };
}

export function createElectronApi(ipcRenderer: IpcRenderer, electronWebUtils: typeof webUtils): IElectronAPI {
    const invokeCore = createTypedIpcInvoker<ICoreInvokeMap>(ipcRenderer);
    const invokeCoreDecoded = createDecodedIpcInvoker<ICoreInvokeMap>(ipcRenderer);
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

    const openDocumentDirect = async (path: string) => {
        const pendingAllow = pendingRendererFileOpenAllows.get(path);
        if (pendingAllow) {
            await pendingAllow;
        }
        return baseDocuments.openDocumentDirect(path);
    };
    const openDocumentDirectBatch = async (paths: string[], requestId?: string) => {
        await Promise.all(compact(paths.map(path => pendingRendererFileOpenAllows.get(path))));
        return baseDocuments.openDocumentDirectBatch(paths, requestId);
    };

    const documents = {
        ...baseDocuments,
        openDocumentDirect,
        openPdfDirect: openDocumentDirect,
        openDocumentDirectBatch,
        openPdfDirectBatch: openDocumentDirectBatch,
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

    const api = {
        documents,
        pageOps,
        imageExport,

        ocr: createOcrPreloadClient(ipcRenderer),

        search: createSearchPreloadClient(ipcRenderer),

        djvu: createDjvuPreloadClient(ipcRenderer),

        settings: {
            get: () => invokeWithStartupTrace(
                'settings:get',
                () => invokeCoreDecoded(CORE_IPC_CHANNELS.settingsGet, sanitizeSettings),
            ),
            save: (settings) => invokeCore(CORE_IPC_CHANNELS.settingsSave, settings),
            getDebugLogs: () => Promise.resolve(getDebugLogMessages()),
            onDebugLog: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onPayload(CORE_IPC_EVENT_CHANNELS.debugLog, callback),
            rendererLog: (entry) => ipcRenderer.send(CORE_IPC_SEND_CHANNELS.rendererLog, entry),
            onMenuOpenSettings: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onNoArg(CORE_IPC_EVENT_CHANNELS.menuOpenSettings, callback),
        },

        system: { getMemoryInfo: readSystemMemoryInfo },

        updates: {
            getState: () => invokeCore(CORE_IPC_CHANNELS.updatesGetState),
            check: () => invokeCore(CORE_IPC_CHANNELS.updatesCheck),
            install: () => invokeCore(CORE_IPC_CHANNELS.updatesInstall),
            defer: () => invokeCore(CORE_IPC_CHANNELS.updatesDefer),
            skipVersion: (version) => invokeCore(CORE_IPC_CHANNELS.updatesSkipVersion, version),
            onStatus: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onPayload(CORE_IPC_EVENT_CHANNELS.updatesStatus, callback),
            onMenuCheckForUpdates: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onNoArg(CORE_IPC_EVENT_CHANNELS.menuCheckForUpdates, callback),
        },

        shell: {openExternal: (url) => invokeCore(CORE_IPC_CHANNELS.shellOpenExternal, url)},

        host: {
            getEnvironment: () => invokeCore(CORE_IPC_CHANNELS.hostGetEnvironment),
            onEnvironmentChange: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onPayload(CORE_IPC_EVENT_CHANNELS.hostEnvironmentChanged, callback),
            getZenModeState: () => invokeCore(CORE_IPC_CHANNELS.hostGetZenModeState),
            setZenMode: (active) => invokeCore(CORE_IPC_CHANNELS.hostSetZenMode, active),
            onZenModeChange: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onPayload(CORE_IPC_EVENT_CHANNELS.hostZenModeChanged, callback),
        },

        agent: {
            onWorkspaceSnapshotRequest: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onPayload(CORE_IPC_EVENT_CHANNELS.agentWorkspaceSnapshotRequest, callback),
            submitWorkspaceSnapshot: response =>
                invokeCore(CORE_IPC_CHANNELS.agentSubmitWorkspaceSnapshot, response),
            onCommandRequest: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onPayload(CORE_IPC_EVENT_CHANNELS.agentCommandRequest, callback),
            submitCommandResponse: response =>
                invokeCore(CORE_IPC_CHANNELS.agentSubmitCommandResponse, response),
            getMcpIntegrationStatus: () =>
                invokeCore(CORE_IPC_CHANNELS.agentGetMcpIntegrationStatus),
            setMcpIntegrationEnabled: enabled =>
                invokeCore(CORE_IPC_CHANNELS.agentSetMcpIntegrationEnabled, enabled),
            getAssistantState: request =>
                request === undefined
                    ? invokeCore(CORE_IPC_CHANNELS.agentGetAssistantState)
                    : invokeCore(CORE_IPC_CHANNELS.agentGetAssistantState, request),
            installAssistantCodex: () =>
                invokeCore(CORE_IPC_CHANNELS.agentInstallAssistantCodex),
            startAssistantLogin: request =>
                invokeCore(CORE_IPC_CHANNELS.agentStartAssistantLogin, request),
            cancelAssistantLogin: () =>
                invokeCore(CORE_IPC_CHANNELS.agentCancelAssistantLogin),
            sendAssistantMessage: request =>
                invokeCore(CORE_IPC_CHANNELS.agentSendAssistantMessage, request),
            interruptAssistant: request =>
                request === undefined
                    ? invokeCore(CORE_IPC_CHANNELS.agentInterruptAssistant)
                    : invokeCore(CORE_IPC_CHANNELS.agentInterruptAssistant, request),
            resetAssistantChat: request =>
                request === undefined
                    ? invokeCore(CORE_IPC_CHANNELS.agentResetAssistantChat)
                    : invokeCore(CORE_IPC_CHANNELS.agentResetAssistantChat, request),
            onAssistantEvent: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onPayload(CORE_IPC_EVENT_CHANNELS.agentAssistantEvent, callback),
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
            transfer: (request) => invokeCore(CORE_IPC_CHANNELS.tabsTransfer, request),
            transferAck: (ack) => invokeCore(CORE_IPC_CHANNELS.tabsTransferAck, ack),
            listTargetWindows: () => invokeCore(CORE_IPC_CHANNELS.tabsListTargets),
            showContextMenu: (tabId) => invokeCore(CORE_IPC_CHANNELS.tabsShowContextMenu, tabId),
            onIncomingTransfer: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onPayload(CORE_IPC_EVENT_CHANNELS.tabsIncomingTransfer, callback),
            onWindowAction: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onPayload(CORE_IPC_EVENT_CHANNELS.menuWindowTabsAction, callback),
            onMenuNewTab: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onNoArg(CORE_IPC_EVENT_CHANNELS.menuNewTab, callback),
            onMenuCloseTab: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onNoArg(CORE_IPC_EVENT_CHANNELS.menuCloseTab, callback),
            onMenuSplitEditor: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onPayload(CORE_IPC_EVENT_CHANNELS.menuSplitEditor, callback),
            onMenuFocusEditorPane: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onPayload(CORE_IPC_EVENT_CHANNELS.menuFocusEditorPane, callback),
            onMenuMoveTabToPane: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onPayload(CORE_IPC_EVENT_CHANNELS.menuMoveTabToPane, callback),
            onMenuCopyTabToPane: (callback): TMenuEventUnsubscribe =>
                eventSubscriber.onPayload(CORE_IPC_EVENT_CHANNELS.menuCopyTabToPane, callback),
        },
    } satisfies IElectronAPI;

    return api;
}
