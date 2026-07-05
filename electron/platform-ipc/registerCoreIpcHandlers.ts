import {
    BrowserWindow,
    shell,
} from 'electron';
import {
    countBy,
    sortBy,
} from 'es-toolkit/array';
import { isRecord } from '@contracts/runtimeGuards';
import { sanitizeSettings } from '@contracts/settings';
import { sanitizeAllowedExternalUrl } from '@contracts/externalUrl';
import type {
    IWindowTabTransferAck,
    IWindowTabTargetWindow,
} from '@contracts/windowTabs';
import type { ISettingsData } from '@contracts/shared';
import { decodeWindowTabTransferRequest } from '@contracts/windowTabsValidation';
import { te } from '@electron/te';
import {
    showTabContextMenu,
    updateRecentFilesMenu,
} from '@electron/menu';
import {
    acknowledgeWindowTabTransfer,
    requestWindowTabTransfer,
} from '@electron/windowTabTransfer';
import { getAllRegisteredAppWindows } from '@electron/window/registry';
import type { IAgentService } from '@electron/features/agent/ports';
import {
    loadSettings,
    updateSettings,
} from '@electron/settings';
import {
    deferDownloadedUpdate,
    getUpdateStatus,
    installDownloadedUpdate,
    skipUpdateVersion,
    triggerManualUpdateCheck,
} from '@electron/updates';
import { createLogger } from '@electron/utils/createLogger';
import { registerRendererLogBridge } from '@electron/platform-ipc/rendererLogBridge';
import { isTrustedWebContentsSender } from '@electron/platform-ipc/trustedIpcSender';
import {
    createValidatedIpcMainEventRegistrar,
    createValidatedIpcMainRegistrar,
} from '@electron/platform-ipc/validatedIpcRegistrar';
import { CORE_IPC_ARGUMENT_VALIDATION_POLICY } from '@electron/platform-ipc/ipcInvokeArgumentValidationPolicy';
import {
    setHostZenModeForWindow,
    snapshotHostEnvironmentForWindow,
    snapshotHostZenModeForWindow,
} from '@electron/hostEnvironment';
import {
    CORE_IPC_CHANNELS,
    CORE_IPC_SEND_CHANNELS,
    type ICoreInvokeMap,
} from '@electron/platform-ipc/coreContract';

export interface ICoreIpcHandlerOptions {
    onRendererReady?: (event: Electron.IpcMainEvent) => void;
    claimPendingExternalOpenPaths?: (event: Electron.IpcMainInvokeEvent) => Promise<string[]>;
    acknowledgePendingExternalOpenPaths?: (event: Electron.IpcMainInvokeEvent, failedPaths: string[]) => void;
}

export interface ICoreIpcHandlerDependencies { agentService: Pick<IAgentService, 'shutdownAssistant'>; }

const logger = createLogger('ipc');
const STARTUP_TRACE_ENABLED = process.env.EVB_STARTUP_TRACE === '1';
const SHELL_OPEN_EXTERNAL_MIN_INTERVAL_MS = 1_000;
const shellOpenExternalLastOpenedAtBySender = new Map<number, number>();
const shellOpenExternalCleanupRegisteredBySender = new Set<number>();
const SETTINGS_SAVE_COALESCE_MS = 25;

const CORE_INVOKE_CHANNEL_SET = new Set<string>(Object.values(CORE_IPC_CHANNELS));
const CORE_RAW_EVENT_CHANNEL_SET = new Set<string>([
    CORE_IPC_CHANNELS.rendererReady,
    CORE_IPC_SEND_CHANNELS.rendererLog,
]);

interface IQueuedSettingsSave {
    pendingPatch: Record<string, unknown>;
    shutdownAssistant: () => Promise<void>;
    waiters: Array<{
        resolve: () => void;
        reject: (error: unknown) => void;
    }>;
    timer: ReturnType<typeof setTimeout> | null;
    flushing: boolean;
}

const settingsSaveQueuesBySender = new Map<number, IQueuedSettingsSave>();

function registerShellOpenExternalSenderCleanup(sender: Electron.WebContents) {
    const senderId = sender.id;
    if (shellOpenExternalCleanupRegisteredBySender.has(senderId)) {
        return;
    }

    shellOpenExternalCleanupRegisteredBySender.add(senderId);
    const cleanup = () => {
        shellOpenExternalLastOpenedAtBySender.delete(senderId);
        shellOpenExternalCleanupRegisteredBySender.delete(senderId);
        sender.removeListener('destroyed', cleanup);
        sender.removeListener('render-process-gone', cleanup);
    };
    sender.once('destroyed', cleanup);
    sender.once('render-process-gone', cleanup);
}

function assertShellOpenExternalRateLimit(sender: Electron.WebContents) {
    registerShellOpenExternalSenderCleanup(sender);
    const now = Date.now();
    const senderId = sender.id;
    const lastOpenedAt = shellOpenExternalLastOpenedAtBySender.get(senderId) ?? 0;
    if (now - lastOpenedAt < SHELL_OPEN_EXTERNAL_MIN_INTERVAL_MS) {
        throw new Error('External URL opens are being requested too frequently.');
    }
    shellOpenExternalLastOpenedAtBySender.set(senderId, now);
}

async function applySettingsSavePatch(
    settingsPayload: Record<string, unknown>,
    shutdownAssistant: () => Promise<void>,
) {
    let shouldShutdownAssistant = false;
    await updateSettings((currentSettings: ISettingsData) => {
        const incoming = sanitizeSettings({
            ...currentSettings,
            ...settingsPayload,
        });
        const {
            skippedUpdateVersion: _ignoredSkippedUpdateVersion,
            ...incomingWithoutSkippedUpdateVersion
        } = incoming;
        shouldShutdownAssistant = currentSettings.assistantPanelEnabled && !incoming.assistantPanelEnabled;
        return {
            ...incomingWithoutSkippedUpdateVersion,
            // This value is managed by updater flow; avoid stale renderer snapshots clobbering it.
            ...(currentSettings.skippedUpdateVersion === undefined
                ? {}
                : {skippedUpdateVersion: currentSettings.skippedUpdateVersion}),
            // This value is managed by the Codex MCP flow because it mutates external Codex config.
            agentMcpEnabled: currentSettings.agentMcpEnabled,
        };
    });
    if (shouldShutdownAssistant) {
        await shutdownAssistant();
    }
    updateRecentFilesMenu();
}

function scheduleSettingsSaveFlush(senderId: number, queue: IQueuedSettingsSave) {
    if (queue.timer || queue.flushing) {
        return;
    }

    queue.timer = setTimeout(() => {
        queue.timer = null;
        void flushSettingsSaveQueue(senderId, queue);
    }, SETTINGS_SAVE_COALESCE_MS);
}

async function flushSettingsSaveQueue(senderId: number, queue: IQueuedSettingsSave) {
    if (queue.flushing) {
        return;
    }

    queue.flushing = true;
    const settingsPayload = queue.pendingPatch;
    const waiters = queue.waiters;
    queue.pendingPatch = {};
    queue.waiters = [];

    try {
        await applySettingsSavePatch(settingsPayload, queue.shutdownAssistant);
        for (const waiter of waiters) {
            waiter.resolve();
        }
    } catch (error) {
        for (const waiter of waiters) {
            waiter.reject(error);
        }
    } finally {
        queue.flushing = false;
        if (queue.waiters.length > 0) {
            scheduleSettingsSaveFlush(senderId, queue);
        } else if (settingsSaveQueuesBySender.get(senderId) === queue) {
            settingsSaveQueuesBySender.delete(senderId);
        }
    }
}

function queueSettingsSave(
    senderId: number,
    settingsPayload: Record<string, unknown>,
    shutdownAssistant: () => Promise<void>,
) {
    let queue = settingsSaveQueuesBySender.get(senderId);
    if (!queue) {
        queue = {
            pendingPatch: {},
            shutdownAssistant,
            waiters: [],
            timer: null,
            flushing: false,
        };
        settingsSaveQueuesBySender.set(senderId, queue);
    }

    queue.pendingPatch = {
        ...queue.pendingPatch,
        ...settingsPayload,
    };

    const savePromise = new Promise<void>((resolve, reject) => {
        queue.waiters.push({
            resolve,
            reject,
        });
    });
    scheduleSettingsSaveFlush(senderId, queue);
    return savePromise;
}

function getTargetWindowIdFromTransferRequest(request: unknown) {
    if (!isRecord(request) || !isRecord(request.target)) {
        return -1;
    }
    if (request.target.kind !== 'window') {
        return -1;
    }
    return typeof request.target.windowId === 'number' ? request.target.windowId : -1;
}

function isValidTransferAck(ack: unknown): ack is IWindowTabTransferAck {
    return isRecord(ack)
        && typeof ack.transferId === 'string'
        && ack.transferId.trim().length > 0
        && typeof ack.success === 'boolean'
        && (ack.error === undefined || typeof ack.error === 'string');
}

function buildTabTransferTargetLabels(sourceWindowId: number): IWindowTabTargetWindow[] {
    const otherWindows = sortBy(
        getAllRegisteredAppWindows().filter(window => window.id !== sourceWindowId),
        [window => window.id],
    );
    const titleCountByLabel = countBy(otherWindows, window => (window.getTitle() || te('app.title')).trim() || te('app.title'));

    return otherWindows.map((window) => {
        const title = (window.getTitle() || te('app.title')).trim() || te('app.title');
        const duplicateCount = titleCountByLabel[title] ?? 0;
        return {
            windowId: window.id,
            label: duplicateCount > 1 ? `${title} (${window.id})` : title,
        };
    });
}

export function registerCoreIpcHandlers(
    ipcMain: Electron.IpcMain,
    options: ICoreIpcHandlerOptions,
    dependencies: ICoreIpcHandlerDependencies,
) {
    const registrar = createValidatedIpcMainRegistrar<ICoreInvokeMap>(ipcMain, {
        allowedChannels: CORE_INVOKE_CHANNEL_SET,
        argumentValidation: CORE_IPC_ARGUMENT_VALIDATION_POLICY,
    });
    const eventRegistrar = createValidatedIpcMainEventRegistrar(ipcMain, {allowedChannels: CORE_RAW_EVENT_CHANNEL_SET});
    registerRendererLogBridge({
        isTrustedSender: isTrustedWebContentsSender,
        registerListener: (channel, handler) => {
            eventRegistrar.on(channel, (event, payload) => {
                handler(event, payload as Parameters<typeof handler>[1]);
            });
        },
    });
    eventRegistrar.on(CORE_IPC_CHANNELS.rendererReady, (event) => {
        options.onRendererReady?.(event);
    });

    registrar.handle(CORE_IPC_CHANNELS.claimPendingExternalOpenPaths, (event) =>
        options.claimPendingExternalOpenPaths?.(event) ?? [],
    );

    registrar.handle(CORE_IPC_CHANNELS.acknowledgePendingExternalOpenPaths, (event, failedPaths: unknown) => {
        const normalizedFailedPaths = Array.isArray(failedPaths)
            ? (failedPaths as unknown[]).filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
            : [];
        options.acknowledgePendingExternalOpenPaths?.(event, normalizedFailedPaths);
    });

    registrar.handle(CORE_IPC_CHANNELS.tabsTransfer, async (event, request: unknown) => {
        const decodedRequest = decodeWindowTabTransferRequest(request);
        if (!decodedRequest) {
            return {
                transferId: '',
                success: false,
                targetWindowId: getTargetWindowIdFromTransferRequest(request),
                error: 'Invalid transfer request payload.',
            };
        }

        const sourceWindow = BrowserWindow.fromWebContents(event.sender);
        if (!sourceWindow) {
            return {
                transferId: '',
                success: false,
                targetWindowId: decodedRequest.target.kind === 'window' ? decodedRequest.target.windowId : -1,
                error: 'Source window is not available.',
            };
        }

        return requestWindowTabTransfer(sourceWindow.id, decodedRequest);
    });

    registrar.handle(CORE_IPC_CHANNELS.tabsTransferAck, (event, ack: unknown) => {
        if (!isValidTransferAck(ack)) {
            return false;
        }

        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) {
            return false;
        }

        return acknowledgeWindowTabTransfer(window.id, ack);
    });

    registrar.handle(CORE_IPC_CHANNELS.tabsListTargets, (event): IWindowTabTargetWindow[] => {
        const sourceWindow = BrowserWindow.fromWebContents(event.sender);
        if (!sourceWindow) {
            return [];
        }

        return buildTabTransferTargetLabels(sourceWindow.id);
    });

    registrar.handle(CORE_IPC_CHANNELS.tabsShowContextMenu, (event, tabId: unknown) => {
        const normalizedTabId = typeof tabId === 'string' ? tabId.trim() : '';
        if (!normalizedTabId) {
            return;
        }

        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) {
            return;
        }

        showTabContextMenu(window, normalizedTabId);
    });

    registrar.handle(CORE_IPC_CHANNELS.windowCloseCurrent, (event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window || window.isDestroyed()) {
            return false;
        }

        window.close();
        return true;
    });

    registrar.handle(CORE_IPC_CHANNELS.settingsGet, async () => {
        const startedAt = Date.now();
        const settings = await loadSettings();
        if (STARTUP_TRACE_ENABLED) {
            logger.info(`[startup] IPC settings:get resolved (+${Date.now() - startedAt}ms)`);
        }
        return settings;
    });

    registrar.handle(CORE_IPC_CHANNELS.settingsSave, async (event, settingsPayload: unknown) => {
        if (!isRecord(settingsPayload)) {
            throw new Error('Invalid settings payload');
        }

        await queueSettingsSave(event.sender.id, settingsPayload, dependencies.agentService.shutdownAssistant);
    });

    registrar.handle(CORE_IPC_CHANNELS.updatesGetState, () => getUpdateStatus());
    registrar.handle(CORE_IPC_CHANNELS.updatesCheck, () => triggerManualUpdateCheck());
    registrar.handle(CORE_IPC_CHANNELS.updatesInstall, () => installDownloadedUpdate());
    registrar.handle(CORE_IPC_CHANNELS.updatesDefer, () => deferDownloadedUpdate());
    registrar.handle(CORE_IPC_CHANNELS.updatesSkipVersion, (_event, version: unknown) => {
        const normalizedVersion = typeof version === 'string' ? version.trim() : '';
        return skipUpdateVersion(normalizedVersion);
    });

    registrar.handle(CORE_IPC_CHANNELS.shellOpenExternal, async (event, url: unknown) => {
        const sanitizedUrl = sanitizeAllowedExternalUrl(url);
        assertShellOpenExternalRateLimit(event.sender);
        await shell.openExternal(sanitizedUrl);
    });

    registrar.handle(CORE_IPC_CHANNELS.hostGetEnvironment, (event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        return snapshotHostEnvironmentForWindow(window);
    });

    registrar.handle(CORE_IPC_CHANNELS.hostGetZenModeState, (event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        return snapshotHostZenModeForWindow(window);
    });

    registrar.handle(CORE_IPC_CHANNELS.hostSetZenMode, (event, active: unknown) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        return setHostZenModeForWindow(window, active === true);
    });
}
