import {
    BrowserWindow,
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
import { te } from '@electron/i18n';
import {
    showTabContextMenu,
    updateRecentFilesMenu,
} from '@electron/menu';
import {
    acknowledgeWindowTabTransfer,
    requestWindowTabTransfer,
} from '@electron/windowTabTransfer';
import { getAllAppWindows } from '@electron/window';
import {registerDocumentsIpcAdapter} from '@electron/features/documents/ipcAdapter';
import {
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import { attachSerializedPdfPersistencePort } from '@electron/features/documents/public';
import {registerImageExportIpcAdapter} from '@electron/features/image-export/ipcAdapter';
import type { IImageExportInvokeMap } from '@electron/features/image-export/contract';
import {registerOcrIpcAdapter} from '@electron/features/ocr/ipcAdapter';
import type { IOcrInvokeMap } from '@electron/features/ocr/contract';
import {registerSearchIpcAdapter} from '@electron/features/search/ipcAdapter';
import type { ISearchInvokeMap } from '@electron/features/search/contract';
import {registerDjvuIpcAdapter} from '@electron/features/djvu/ipcAdapter';
import type { IDjvuInvokeMap } from '@electron/features/djvu/contract';
import {registerPageOpsIpcAdapter} from '@electron/features/page-ops/ipcAdapter';
import type { IPageOpsInvokeMap } from '@electron/features/page-ops/contract';
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
import { createLogger } from '@electron/utils/logger';
import { getErrorMessage } from '@electron/utils/error';
import { isTrustedRendererUrl } from '@electron/security/trustedRendererUrl';
import { registerRendererLogBridge } from '@electron/ipc/rendererLogBridge';
import {
    setHostZenModeForWindow,
    snapshotHostEnvironmentForWindow,
    snapshotHostZenModeForWindow,
} from '@electron/hostEnvironment';
import {
    CORE_IPC_CHANNELS,
    type ICoreInvokeMap,
} from '@electron/ipc/coreContract';

export { normalizeRendererLogEntry } from '@electron/ipc/rendererLogBridge';

interface ICoreIpcHandlerOptions {
    onRendererReady?: (event: Electron.IpcMainEvent) => void;
    claimPendingExternalOpenPaths?: (event: Electron.IpcMainInvokeEvent) => Promise<string[]>;
}

const logger = createLogger('ipc');
const STARTUP_TRACE_ENABLED = process.env.EVB_STARTUP_TRACE === '1';

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

function sanitizeExternalUrl(rawUrl: unknown) {
    return sanitizeAllowedExternalUrl(rawUrl);
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

    const senderMainFrame = sender.mainFrame;
    if (senderFrame && senderMainFrame && senderFrame !== senderMainFrame) {
        logger.warn(`[ipc] rejected ${channel}: non-main frame sender`);
        return false;
    }

    const rawSenderUrl = senderFrame?.url || sender.getURL();
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

function createValidatedIpcMainRegistrar(registrar: IIpcMainRegistrar<never, Electron.IpcMainInvokeEvent>): IIpcMainRegistrar<never, Electron.IpcMainInvokeEvent>;
function createValidatedIpcMainRegistrar<
    TMap extends {[TChannel in keyof TMap]: IIpcInvokeSpec},
>(registrar: IIpcMainRegistrar<never, Electron.IpcMainInvokeEvent>): IIpcMainRegistrar<TMap, Electron.IpcMainInvokeEvent>;
function createValidatedIpcMainRegistrar(
    registrar: IIpcMainRegistrar<never, Electron.IpcMainInvokeEvent>,
): IIpcMainRegistrar<never, Electron.IpcMainInvokeEvent> {
    return {handle: <TArgs extends unknown[], TResult>(
        channel: string,
        handler: (
            event: Electron.IpcMainInvokeEvent,
            ...args: TArgs
        ) => TResult | Promise<TResult>,
    ) => {
        registrar.handle(channel, async (event: Electron.IpcMainInvokeEvent, ...args: TArgs) => {
            if (!isTrustedIpcInvokeSender(event, channel)) {
                throw new Error('IPC sender is not trusted');
            }
            return handler(event, ...args);
        });
    }};
}

function buildTabTransferTargetLabels(sourceWindowId: number): IWindowTabTargetWindow[] {
    const otherWindows = sortBy(
        getAllAppWindows().filter(window => window.id !== sourceWindowId),
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
    const registrar = createValidatedIpcMainRegistrar<ICoreInvokeMap>(ipcMain);
    registerRendererLogBridge({isTrustedSender: isTrustedWebContentsSender});
    ipcMain.on(DOCUMENTS_CHANNELS.fileSavePdfDataPort, (event, sessionId: unknown) => {
        if (!isTrustedWebContentsSender(event.sender, event.senderFrame, DOCUMENTS_CHANNELS.fileSavePdfDataPort)) {
            return;
        }

        try {
            attachSerializedPdfPersistencePort(event, sessionId);
        } catch (error) {
            logger.warn(`[ipc] rejected ${DOCUMENTS_CHANNELS.fileSavePdfDataPort}: ${getErrorMessage(error)}`);
        }
    });
    ipcMain.on(CORE_IPC_CHANNELS.rendererReady, (event) => {
        if (!isTrustedWebContentsSender(event.sender, event.senderFrame, CORE_IPC_CHANNELS.rendererReady)) {
            return;
        }
        options.onRendererReady?.(event);
    });

    registrar.handle(CORE_IPC_CHANNELS.claimPendingExternalOpenPaths, (event) =>
        options.claimPendingExternalOpenPaths?.(event) ?? [],
    );

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

    registrar.handle(CORE_IPC_CHANNELS.settingsSave, async (_event, settingsPayload: unknown) => {
        if (!isRecord(settingsPayload)) {
            throw new Error('Invalid settings payload');
        }

        await updateSettings((currentSettings) => {
            const incoming = sanitizeSettings({
                ...currentSettings,
                ...settingsPayload,
            });
            return {
                ...incoming,
                // This value is managed by updater flow; avoid stale renderer snapshots clobbering it.
                skippedUpdateVersion: currentSettings.skippedUpdateVersion,
            };
        });
        updateRecentFilesMenu();
    });

    registrar.handle(CORE_IPC_CHANNELS.updatesGetState, () => getUpdateStatus());
    registrar.handle(CORE_IPC_CHANNELS.updatesCheck, () => triggerManualUpdateCheck());
    registrar.handle(CORE_IPC_CHANNELS.updatesInstall, () => installDownloadedUpdate());
    registrar.handle(CORE_IPC_CHANNELS.updatesDefer, () => deferDownloadedUpdate());
    registrar.handle(CORE_IPC_CHANNELS.updatesSkipVersion, (_event, version: unknown) => {
        const normalizedVersion = typeof version === 'string' ? version.trim() : '';
        return skipUpdateVersion(normalizedVersion);
    });

    registrar.handle(CORE_IPC_CHANNELS.shellOpenExternal, async (_event, url: unknown) => {
        const sanitizedUrl = sanitizeExternalUrl(url);
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

export function registerIpcHandlers(options: ICoreIpcHandlerOptions = {}) {
    registerCoreIpcHandlers(options);
    registerDocumentsIpcAdapter(createValidatedIpcMainRegistrar<IDocumentsInvokeMap>(ipcMain));
    registerImageExportIpcAdapter(createValidatedIpcMainRegistrar<IImageExportInvokeMap>(ipcMain));
    registerPageOpsIpcAdapter(createValidatedIpcMainRegistrar<IPageOpsInvokeMap>(ipcMain));
    registerOcrIpcAdapter(createValidatedIpcMainRegistrar<IOcrInvokeMap>(ipcMain));
    registerSearchIpcAdapter(createValidatedIpcMainRegistrar<ISearchInvokeMap>(ipcMain));
    registerDjvuIpcAdapter(createValidatedIpcMainRegistrar<IDjvuInvokeMap>(ipcMain));
}
