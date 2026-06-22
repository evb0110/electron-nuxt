import {
    BrowserWindow,
    dialog,
    ipcMain,
    shell,
} from 'electron';
import {
    countBy,
    sortBy,
} from 'es-toolkit/array';
import type {
    IIpcInvokeSpec,
    IIpcMainRegistrar,
} from '@contracts/ipcMain';
import { isRecord } from '@contracts/runtimeGuards';
import { sanitizeSettings } from '@contracts/settings';
import { sanitizeAllowedExternalUrl } from '@contracts/externalUrl';
import type {
    IWindowTabTransferAck,
    IWindowTabTransferRequest,
    IWindowTabTargetWindow,
} from '@contracts/windowTabs';
import type {
    IAgentAssistantChatScope,
    IAgentAssistantLoginRequest,
    IAgentAssistantImageAttachment,
    IAgentAssistantSendMessageRequest,
    IAgentAssistantStateRequest,
    TAgentAssistantProviderId,
} from '@contracts/agent';
import { te } from '@electron/te';
import {
    showTabContextMenu,
    updateRecentFilesMenu,
} from '@electron/menu';
import {
    acknowledgeWindowTabTransfer,
    requestWindowTabTransfer,
} from '@electron/windowTabTransfer';
import {
    getAllRegisteredAppWindows,
    getWindowByIdFromRegistry,
} from '@electron/window/registry';
import {registerDocumentsIpcAdapter} from '@electron/features/documents/registerDocumentsIpcAdapter';
import {
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import { attachSerializedPdfPersistencePort } from '@electron/features/documents/public';
import {registerImageExportIpcAdapter} from '@electron/features/image-export/registerImageExportIpcAdapter';
import {
    IMAGE_EXPORT_CHANNELS,
    type IImageExportInvokeMap,
} from '@electron/features/image-export/contract';
import {registerOcrIpcAdapter} from '@electron/features/ocr/registerOcrIpcAdapter';
import {
    OCR_CHANNELS,
    type IOcrInvokeMap,
} from '@electron/features/ocr/contract';
import {registerSearchIpcAdapter} from '@electron/features/search/registerSearchIpcAdapter';
import {
    SEARCH_CHANNELS,
    type ISearchInvokeMap,
} from '@electron/features/search/contract';
import {registerDjvuIpcAdapter} from '@electron/features/djvu/registerDjvuIpcAdapter';
import {
    DJVU_CHANNELS,
    type IDjvuInvokeMap,
} from '@electron/features/djvu/contract';
import {registerPageOpsIpcAdapter} from '@electron/features/page-ops/registerPageOpsIpcAdapter';
import {
    PAGE_OPS_CHANNELS,
    type IPageOpsInvokeMap,
} from '@electron/features/page-ops/contract';
import {
    submitAgentCommandResponse,
    submitAgentWorkspaceSnapshotResponse,
} from '@electron/features/agent/workspaceBridge';
import {
    getAgentMcpIntegrationStatus,
    setAgentMcpIntegrationEnabled,
} from '@electron/features/agent/codexMcpIntegration';
import {
    cancelAgentAssistantLogin,
    getAgentAssistantState,
    installAgentAssistantCodex,
    interruptAgentAssistant,
    resetAgentAssistantChat,
    sendAgentAssistantMessage,
    startAgentAssistantLogin,
    shutdownAgentAssistant,
} from '@electron/features/agent/codexAssistant';
import {
    ASSISTANT_MAX_IMAGE_ATTACHMENTS,
    ASSISTANT_MAX_IMAGE_BYTES,
} from '@electron/features/agent/codexAssistantConfig';
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
import { config } from '@electron/config';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { isTrustedRendererUrl } from '@electron/security/isTrustedRendererUrl';
import { registerRendererLogBridge } from '@electron/platform-ipc/rendererLogBridge';
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

export { normalizeRendererLogEntry } from '@electron/platform-ipc/rendererLogBridge';

interface ICoreIpcHandlerOptions {
    onRendererReady?: (event: Electron.IpcMainEvent) => void;
    claimPendingExternalOpenPaths?: (event: Electron.IpcMainInvokeEvent) => Promise<string[]>;
    acknowledgePendingExternalOpenPaths?: (event: Electron.IpcMainInvokeEvent, failedPaths: string[]) => void;
}

const logger = createLogger('ipc');
const STARTUP_TRACE_ENABLED = process.env.EVB_STARTUP_TRACE === '1';
const SHELL_OPEN_EXTERNAL_MIN_INTERVAL_MS = 1_000;
const shellOpenExternalLastOpenedAtBySender = new Map<number, number>();
const shellOpenExternalCleanupRegisteredBySender = new Set<number>();
const SETTINGS_SAVE_COALESCE_MS = 25;
const registeredInvokeChannels = new Set<string>();
const registeredEventChannels = new Set<string>();

const CORE_INVOKE_CHANNEL_SET = new Set<string>(Object.values(CORE_IPC_CHANNELS));
const CORE_RAW_EVENT_CHANNEL_SET = new Set<string>([
    CORE_IPC_CHANNELS.rendererReady,
    CORE_IPC_SEND_CHANNELS.rendererLog,
    DOCUMENTS_CHANNELS.fileSavePdfDataPort,
]);
const DOCUMENTS_CHANNEL_SET = new Set<string>(Object.values(DOCUMENTS_CHANNELS));

function createChannelSet<T extends Record<string, string>>(channels: T) {
    return new Set<string>(Object.values(channels));
}

function assertKnownChannelRegistration(
    kind: 'invoke' | 'event',
    registeredChannels: Set<string>,
    channel: string,
    allowedChannels?: ReadonlySet<string>,
) {
    if (allowedChannels && !allowedChannels.has(channel)) {
        throw new Error(`Unknown ${kind} IPC channel registered: ${channel}`);
    }
    if (registeredChannels.has(channel)) {
        throw new Error(`Duplicate ${kind} IPC channel registration: ${channel}`);
    }
    registeredChannels.add(channel);
}

interface IQueuedSettingsSave {
    pendingPatch: Record<string, unknown>;
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

async function applySettingsSavePatch(settingsPayload: Record<string, unknown>) {
    let shouldShutdownAssistant = false;
    await updateSettings((currentSettings) => {
        const incoming = sanitizeSettings({
            ...currentSettings,
            ...settingsPayload,
        });
        shouldShutdownAssistant = currentSettings.assistantPanelEnabled && !incoming.assistantPanelEnabled;
        return {
            ...incoming,
            // This value is managed by updater flow; avoid stale renderer snapshots clobbering it.
            skippedUpdateVersion: currentSettings.skippedUpdateVersion,
            // This value is managed by the Codex MCP flow because it mutates external Codex config.
            agentMcpEnabled: currentSettings.agentMcpEnabled,
        };
    });
    if (shouldShutdownAssistant) {
        await shutdownAgentAssistant();
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
        await applySettingsSavePatch(settingsPayload);
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

function queueSettingsSave(senderId: number, settingsPayload: Record<string, unknown>) {
    let queue = settingsSaveQueuesBySender.get(senderId);
    if (!queue) {
        queue = {
            pendingPatch: {},
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

async function confirmAssistantCodexInstall(parentWindow: BrowserWindow | null) {
    const options = {
        type: 'warning',
        title: te('assistant.installCodex'),
        message: te('assistant.installDescription'),
        detail: 'EVB Viewer will download and run the official Codex installer.',
        buttons: [
            te('assistant.installCodex'),
            te('dialogs.agentMcp.cancel'),
        ],
        defaultId: 1,
        cancelId: 1,
    } satisfies Electron.MessageBoxOptions;
    const result = parentWindow
        ? await dialog.showMessageBox(parentWindow, options)
        : await dialog.showMessageBox(options);
    return result.response === 0;
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

function isValidTransferRequest(request: unknown): request is IWindowTabTransferRequest {
    if (!isRecord(request) || !isRecord(request.target)) {
        return false;
    }
    if (request.target.kind === 'new-window') {
        return true;
    }
    return request.target.kind === 'window' && typeof request.target.windowId === 'number' && Number.isFinite(request.target.windowId);
}

function isValidTransferAck(ack: unknown): ack is IWindowTabTransferAck {
    return isRecord(ack)
        && typeof ack.transferId === 'string'
        && ack.transferId.trim().length > 0
        && typeof ack.success === 'boolean'
        && (ack.error === undefined || typeof ack.error === 'string');
}

function isAgentAssistantLoginRequest(request: unknown): request is IAgentAssistantLoginRequest {
    return isRecord(request) && (request.mode === 'chatgpt' || request.mode === 'device-code');
}

function isAgentAssistantProviderId(provider: unknown): provider is TAgentAssistantProviderId {
    return provider === 'codex' || provider === 'claude';
}

function isOptionalAssistantSelection(request: Record<PropertyKey, unknown>) {
    return (
        (request.provider === undefined || isAgentAssistantProviderId(request.provider))
        && (request.model === undefined || typeof request.model === 'string')
        && (request.effort === undefined || typeof request.effort === 'string')
    );
}

function isAgentAssistantChatScope(scope: unknown): scope is IAgentAssistantChatScope {
    return isRecord(scope)
        && scope.kind === 'document'
        && typeof scope.key === 'string'
        && scope.key.trim().length > 0
        && (scope.title === null || typeof scope.title === 'string')
        && (scope.tabId === undefined || scope.tabId === null || typeof scope.tabId === 'string')
        && (scope.documentRef === undefined || scope.documentRef === null || typeof scope.documentRef === 'string');
}

function isAgentAssistantStateRequest(request: unknown): request is IAgentAssistantStateRequest {
    return request === undefined
        || request === null
        || (
            isRecord(request)
            && isOptionalAssistantSelection(request)
            && (
                request.scope === undefined
                || request.scope === null
                || isAgentAssistantChatScope(request.scope)
            )
        );
}

const ASSISTANT_MAX_IMAGE_DATA_URL_LENGTH = Math.ceil(ASSISTANT_MAX_IMAGE_BYTES / 3) * 4 + 128;
const ASSISTANT_IMAGE_DATA_URL_PREFIX_RE = /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[a-z0-9.+/-]+)*;base64,/iu;

function isAgentAssistantImageAttachment(attachment: unknown): attachment is IAgentAssistantImageAttachment {
    return isRecord(attachment)
        && attachment.type === 'image'
        && typeof attachment.id === 'string'
        && typeof attachment.name === 'string'
        && typeof attachment.mimeType === 'string'
        && attachment.mimeType.toLowerCase().startsWith('image/')
        && typeof attachment.sizeBytes === 'number'
        && Number.isFinite(attachment.sizeBytes)
        && attachment.sizeBytes > 0
        && attachment.sizeBytes <= ASSISTANT_MAX_IMAGE_BYTES
        && typeof attachment.dataUrl === 'string'
        && attachment.dataUrl.length <= ASSISTANT_MAX_IMAGE_DATA_URL_LENGTH
        && ASSISTANT_IMAGE_DATA_URL_PREFIX_RE.test(attachment.dataUrl);
}

function isAgentAssistantImageAttachmentList(attachments: unknown): attachments is IAgentAssistantImageAttachment[] {
    return Array.isArray(attachments)
        && attachments.length <= ASSISTANT_MAX_IMAGE_ATTACHMENTS
        && attachments.every(isAgentAssistantImageAttachment);
}

function isAgentAssistantSendMessageRequest(request: unknown): request is IAgentAssistantSendMessageRequest {
    return isRecord(request)
        && typeof request.text === 'string'
        && isOptionalAssistantSelection(request)
        && (
            request.scope === undefined
            || request.scope === null
            || isAgentAssistantChatScope(request.scope)
        )
        && (
            request.attachments === undefined
            || isAgentAssistantImageAttachmentList(request.attachments)
        );
}

function isTrustedWebContentsSender(
    sender: Electron.WebContents,
    senderFrame: Electron.WebFrameMain | null | undefined,
    channel: string,
) {
    const sourceWindow = BrowserWindow.fromWebContents(sender);
    if (!sourceWindow || sourceWindow.isDestroyed() || sender.isDestroyed()) {
        logger.warn(`[ipc] rejected ${channel}: missing or destroyed sender window`);
        return false;
    }
    const registeredWindow = getWindowByIdFromRegistry(sourceWindow.id);
    if (registeredWindow !== sourceWindow || registeredWindow.webContents !== sender) {
        logger.warn(`[ipc] rejected ${channel}: sender window is not registered`);
        return false;
    }

    const senderMainFrame = sender.mainFrame;
    if (senderFrame && senderMainFrame && senderFrame !== senderMainFrame) {
        logger.warn(`[ipc] rejected ${channel}: non-main frame sender`);
        return false;
    }

    const senderFrameUrl = senderFrame?.url;
    const rawSenderUrl = senderFrameUrl && senderFrameUrl.length > 0 ? senderFrameUrl : sender.getURL();
    const trustedUrl = getTrustedRendererUrl();
    if (!trustedUrl || !rawSenderUrl) {
        logger.warn(`[ipc] rejected ${channel}: missing trusted URL or sender URL`);
        return false;
    }

    if (!isTrustedRendererUrl(rawSenderUrl, trustedUrl)) {
        let senderDescription = rawSenderUrl;
        try {
            const parsedSenderUrl = new URL(rawSenderUrl);
            senderDescription = `${parsedSenderUrl.origin}${parsedSenderUrl.pathname}`;
        } catch {
            logger.warn(`[ipc] rejected ${channel}: invalid sender URL ${rawSenderUrl}`);
            return false;
        }

        logger.warn(
            `[ipc] rejected ${channel}: untrusted sender URL ${senderDescription} (expected ${trustedUrl})`,
        );
        return false;
    }

    return true;
}

function getTrustedRendererUrl() {
    return config.renderer.trustedUrl;
}

function isTrustedIpcInvokeSender(event: Electron.IpcMainInvokeEvent, channel: string) {
    return isTrustedWebContentsSender(event.sender, event.senderFrame, channel);
}

function createValidatedIpcMainRegistrar(
    registrar: IIpcMainRegistrar<never, Electron.IpcMainInvokeEvent>,
    options?: {allowedChannels?: ReadonlySet<string>;},
): IIpcMainRegistrar<never, Electron.IpcMainInvokeEvent>;
function createValidatedIpcMainRegistrar<
    TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec},
>(
    registrar: IIpcMainRegistrar<never, Electron.IpcMainInvokeEvent>,
    options?: {allowedChannels?: ReadonlySet<string>;},
): IIpcMainRegistrar<TMap, Electron.IpcMainInvokeEvent>;
function createValidatedIpcMainRegistrar(
    registrar: IIpcMainRegistrar<never, Electron.IpcMainInvokeEvent>,
    options: {allowedChannels?: ReadonlySet<string>;} = {},
): IIpcMainRegistrar<never, Electron.IpcMainInvokeEvent> {
    return {handle: <TArgs extends unknown[], TResult>(
        channel: string,
        handler: (
            event: Electron.IpcMainInvokeEvent,
            ...args: TArgs
        ) => TResult | Promise<TResult>,
    ) => {
        assertKnownChannelRegistration('invoke', registeredInvokeChannels, channel, options.allowedChannels);
        registrar.handle(channel, async (event, ...args: TArgs) => {
            if (!isTrustedIpcInvokeSender(event, channel)) {
                throw new Error('IPC sender is not trusted');
            }
            return handler(event, ...args);
        });
    }};
}

interface IValidatedIpcMainEventRegistrar {on: (
    channel: string,
    handler: (event: Electron.IpcMainEvent, ...args: unknown[]) => void,
) => void;}

function createValidatedIpcMainEventRegistrar(
    registrar: Pick<typeof ipcMain, 'on'>,
    options: {allowedChannels?: ReadonlySet<string>;} = {},
): IValidatedIpcMainEventRegistrar {
    return {on: (channel, handler) => {
        assertKnownChannelRegistration('event', registeredEventChannels, channel, options.allowedChannels);
        registrar.on(channel, (event, ...args: unknown[]) => {
            if (!isTrustedWebContentsSender(event.sender, event.senderFrame, channel)) {
                return;
            }
            handler(event, ...args);
        });
    }};
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

function registerCoreIpcHandlers(options: ICoreIpcHandlerOptions = {}) {
    const registrar = createValidatedIpcMainRegistrar<ICoreInvokeMap>(ipcMain, {allowedChannels: CORE_INVOKE_CHANNEL_SET});
    const eventRegistrar = createValidatedIpcMainEventRegistrar(ipcMain, {allowedChannels: CORE_RAW_EVENT_CHANNEL_SET});
    registerRendererLogBridge({
        isTrustedSender: isTrustedWebContentsSender,
        registerListener: (channel, handler) => {
            eventRegistrar.on(channel, (event, payload) => {
                handler(event, payload as Parameters<typeof handler>[1]);
            });
        },
    });
    eventRegistrar.on(DOCUMENTS_CHANNELS.fileSavePdfDataPort, (event, sessionId: unknown) => {
        try {
            attachSerializedPdfPersistencePort(event, sessionId);
        } catch (error) {
            logger.warn(`[ipc] rejected ${DOCUMENTS_CHANNELS.fileSavePdfDataPort}: ${getErrorMessage(error)}`);
        }
    });
    eventRegistrar.on(CORE_IPC_CHANNELS.rendererReady, (event) => {
        options.onRendererReady?.(event);
    });

    registrar.handle(CORE_IPC_CHANNELS.claimPendingExternalOpenPaths, (event) =>
        options.claimPendingExternalOpenPaths?.(event) ?? [],
    );

    registrar.handle(CORE_IPC_CHANNELS.acknowledgePendingExternalOpenPaths, (event, failedPaths: unknown) => {
        const normalizedFailedPaths = Array.isArray(failedPaths)
            ? failedPaths.filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
            : [];
        options.acknowledgePendingExternalOpenPaths?.(event, normalizedFailedPaths);
    });

    registrar.handle(CORE_IPC_CHANNELS.tabsTransfer, async (event, request: unknown) => {
        if (!isValidTransferRequest(request)) {
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
                targetWindowId: request.target.kind === 'window' ? request.target.windowId : -1,
                error: 'Source window is not available.',
            };
        }

        return requestWindowTabTransfer(sourceWindow.id, request);
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

        await queueSettingsSave(event.sender.id, settingsPayload);
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

    registrar.handle(CORE_IPC_CHANNELS.agentGetMcpIntegrationStatus, () =>
        getAgentMcpIntegrationStatus(),
    );

    registrar.handle(CORE_IPC_CHANNELS.agentSetMcpIntegrationEnabled, (event, enabled: unknown) => {
        if (typeof enabled !== 'boolean') {
            throw new Error('Invalid agent MCP enabled payload');
        }
        return setAgentMcpIntegrationEnabled(enabled, BrowserWindow.fromWebContents(event.sender));
    });

    registrar.handle(CORE_IPC_CHANNELS.agentGetAssistantState, (_event, request: unknown) => {
        if (!isAgentAssistantStateRequest(request)) {
            throw new Error('Invalid assistant state request payload');
        }
        return getAgentAssistantState(request);
    });

    registrar.handle(CORE_IPC_CHANNELS.agentInstallAssistantCodex, async (event) => {
        const confirmed = await confirmAssistantCodexInstall(BrowserWindow.fromWebContents(event.sender));
        if (!confirmed) {
            return {
                ok: false,
                state: await getAgentAssistantState(),
                error: 'Codex installation was cancelled.',
            };
        }
        return installAgentAssistantCodex();
    });

    registrar.handle(CORE_IPC_CHANNELS.agentStartAssistantLogin, (event, request: unknown) => {
        if (!isAgentAssistantLoginRequest(request)) {
            throw new Error('Invalid assistant login request payload');
        }
        return startAgentAssistantLogin(request, BrowserWindow.fromWebContents(event.sender));
    });

    registrar.handle(CORE_IPC_CHANNELS.agentCancelAssistantLogin, () =>
        cancelAgentAssistantLogin(),
    );

    registrar.handle(CORE_IPC_CHANNELS.agentSendAssistantMessage, (_event, request: unknown) => {
        if (!isAgentAssistantSendMessageRequest(request)) {
            throw new Error('Invalid assistant message payload');
        }
        return sendAgentAssistantMessage(request);
    });

    registrar.handle(CORE_IPC_CHANNELS.agentInterruptAssistant, (_event, request: unknown) => {
        if (!isAgentAssistantStateRequest(request)) {
            throw new Error('Invalid assistant interrupt request payload');
        }
        return interruptAgentAssistant(request);
    });

    registrar.handle(CORE_IPC_CHANNELS.agentResetAssistantChat, (_event, request: unknown) => {
        if (!isAgentAssistantStateRequest(request)) {
            throw new Error('Invalid assistant reset request payload');
        }
        return resetAgentAssistantChat(request);
    });

    registrar.handle(CORE_IPC_CHANNELS.agentSubmitWorkspaceSnapshot, (event, response: unknown) =>
        submitAgentWorkspaceSnapshotResponse(event, response),
    );

    registrar.handle(CORE_IPC_CHANNELS.agentSubmitCommandResponse, (event, response: unknown) =>
        submitAgentCommandResponse(event, response),
    );
}

export function registerIpcHandlers(options: ICoreIpcHandlerOptions = {}) {
    registerCoreIpcHandlers(options);
    registerDocumentsIpcAdapter(createValidatedIpcMainRegistrar<IDocumentsInvokeMap>(ipcMain, {allowedChannels: DOCUMENTS_CHANNEL_SET}));
    registerImageExportIpcAdapter(createValidatedIpcMainRegistrar<IImageExportInvokeMap>(ipcMain, {allowedChannels: createChannelSet(IMAGE_EXPORT_CHANNELS)}));
    registerPageOpsIpcAdapter(createValidatedIpcMainRegistrar<IPageOpsInvokeMap>(ipcMain, {allowedChannels: createChannelSet(PAGE_OPS_CHANNELS)}));
    registerOcrIpcAdapter(createValidatedIpcMainRegistrar<IOcrInvokeMap>(ipcMain, {allowedChannels: createChannelSet(OCR_CHANNELS)}));
    registerSearchIpcAdapter(createValidatedIpcMainRegistrar<ISearchInvokeMap>(ipcMain, {allowedChannels: createChannelSet(SEARCH_CHANNELS)}));
    registerDjvuIpcAdapter(createValidatedIpcMainRegistrar<IDjvuInvokeMap>(ipcMain, {allowedChannels: createChannelSet(DJVU_CHANNELS)}));
}
