import {
    BrowserWindow,
    ipcMain,
    shell,
} from 'electron';
import type { IIpcMainRegistrar } from '@contracts/ipcMain';
import type { ISettingsData } from '@contracts/shared';
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
import { DOCUMENTS_CHANNELS } from '@electron/features/documents/contract';
import { attachSerializedPdfPersistencePort } from '@electron/features/documents/main/serializedPdfPersistence';
import {registerImageExportIpcAdapter} from '@electron/features/image-export/ipcAdapter';
import {registerOcrIpcAdapter} from '@electron/features/ocr/ipcAdapter';
import {registerSearchIpcAdapter} from '@electron/features/search/ipcAdapter';
import {registerDjvuIpcAdapter} from '@electron/features/djvu/ipcAdapter';
import {registerPageOpsIpcAdapter} from '@electron/features/page-ops/ipcAdapter';
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
import { registerRendererLogBridge } from '@electron/ipc/rendererLogBridge';
import {
    setHostZenModeForWindow,
    snapshotHostEnvironmentForWindow,
    snapshotHostZenModeForWindow,
} from '@electron/hostEnvironment';

export { normalizeRendererLogEntry } from '@electron/ipc/rendererLogBridge';

const CORE_APP_CHANNELS = {
    rendererReady: 'app:rendererReady',
    claimPendingExternalOpenPaths: 'app:claimPendingExternalOpenPaths',
} as const;

interface ICoreIpcHandlerOptions {
    onRendererReady?: (event: Electron.IpcMainEvent) => void;
    claimPendingExternalOpenPaths?: (event: Electron.IpcMainInvokeEvent) => Promise<string[]>;
}

const logger = createLogger('ipc');
const STARTUP_TRACE_ENABLED = process.env.EVB_STARTUP_TRACE === '1';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
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
    const trustedOrigin = getTrustedRendererOrigin();
    if (!trustedOrigin || !rawSenderUrl) {
        logger.warn(`[ipc] rejected ${channel}: missing trusted origin or sender URL`);
        return false;
    }

    let parsedSenderUrl: URL;
    try {
        parsedSenderUrl = new URL(rawSenderUrl);
    } catch {
        logger.warn(`[ipc] rejected ${channel}: invalid sender URL ${rawSenderUrl}`);
        return false;
    }

    const trustedUrl = new URL(trustedOrigin);
    const senderTrusted = trustedUrl.protocol === 'evb-viewer:'
        ? parsedSenderUrl.protocol === trustedUrl.protocol && parsedSenderUrl.hostname === trustedUrl.hostname
        : parsedSenderUrl.origin === trustedUrl.origin;
    if (!senderTrusted) {
        logger.warn(
            `[ipc] rejected ${channel}: untrusted sender origin ${parsedSenderUrl.origin} (expected ${trustedOrigin})`,
        );
        return false;
    }

    return true;
}

function getTrustedRendererOrigin() {
    return config.renderer.trustedOrigin;
}

function isTrustedIpcInvokeSender(event: Electron.IpcMainInvokeEvent, channel: string) {
    return isTrustedWebContentsSender(event.sender, event.senderFrame, channel);
}

function createValidatedIpcMainRegistrar(registrar: IIpcMainRegistrar): IIpcMainRegistrar {
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
    const otherWindows = getAllAppWindows()
        .filter(window => window.id !== sourceWindowId)
        .sort((left, right) => left.id - right.id);

    const titleCountByLabel = new Map<string, number>();
    for (const window of otherWindows) {
        const title = (window.getTitle() || te('app.title')).trim() || te('app.title');
        titleCountByLabel.set(title, (titleCountByLabel.get(title) ?? 0) + 1);
    }

    return otherWindows.map((window) => {
        const title = (window.getTitle() || te('app.title')).trim() || te('app.title');
        const duplicateCount = titleCountByLabel.get(title) ?? 0;
        return {
            windowId: window.id,
            label: duplicateCount > 1 ? `${title} (${window.id})` : title,
        };
    });
}

function registerCoreIpcHandlers(options: ICoreIpcHandlerOptions = {}) {
    const registrar = createValidatedIpcMainRegistrar(ipcMain);
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
    ipcMain.on(CORE_APP_CHANNELS.rendererReady, (event) => {
        if (!isTrustedWebContentsSender(event.sender, event.senderFrame, CORE_APP_CHANNELS.rendererReady)) {
            return;
        }
        options.onRendererReady?.(event);
    });

    registrar.handle(CORE_APP_CHANNELS.claimPendingExternalOpenPaths, (event) =>
        options.claimPendingExternalOpenPaths?.(event) ?? [],
    );

    registrar.handle('tabs:transfer', async (event, request: unknown) => {
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

    registrar.handle('tabs:transferAck', (event, ack: unknown) => {
        if (!isValidTransferAck(ack)) {
            return false;
        }

        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) {
            return false;
        }

        return acknowledgeWindowTabTransfer(window.id, ack);
    });

    registrar.handle('tabs:listTargets', (event): IWindowTabTargetWindow[] => {
        const sourceWindow = BrowserWindow.fromWebContents(event.sender);
        if (!sourceWindow) {
            return [];
        }

        return buildTabTransferTargetLabels(sourceWindow.id);
    });

    registrar.handle('tabs:showContextMenu', (event, tabId: unknown) => {
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

    registrar.handle('window:closeCurrent', (event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window || window.isDestroyed()) {
            return false;
        }

        window.close();
        return true;
    });

    registrar.handle('settings:get', async () => {
        const startedAt = Date.now();
        const settings = await loadSettings();
        if (STARTUP_TRACE_ENABLED) {
            logger.info(`[startup] IPC settings:get resolved (+${Date.now() - startedAt}ms)`);
        }
        return settings;
    });

    registrar.handle('settings:save', async (_event, settingsPayload: unknown) => {
        if (!isRecord(settingsPayload)) {
            throw new Error('Invalid settings payload');
        }

        await updateSettings((currentSettings) => {
            const incoming = settingsPayload as Partial<ISettingsData>;
            return {
                ...currentSettings,
                ...incoming,
                // This value is managed by updater flow; avoid stale renderer snapshots clobbering it.
                skippedUpdateVersion: currentSettings.skippedUpdateVersion,
            };
        });
        updateRecentFilesMenu();
    });

    registrar.handle('updates:getState', () => getUpdateStatus());
    registrar.handle('updates:check', () => triggerManualUpdateCheck());
    registrar.handle('updates:install', () => installDownloadedUpdate());
    registrar.handle('updates:defer', () => deferDownloadedUpdate());
    registrar.handle('updates:skipVersion', (_event, version: unknown) => {
        const normalizedVersion = typeof version === 'string' ? version.trim() : '';
        return skipUpdateVersion(normalizedVersion);
    });

    registrar.handle('shell:openExternal', async (_event, url: unknown) => {
        const sanitizedUrl = sanitizeExternalUrl(url);
        await shell.openExternal(sanitizedUrl);
    });

    registrar.handle('host:getEnvironment', (event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        return snapshotHostEnvironmentForWindow(window);
    });

    registrar.handle('host:getZenModeState', (event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        return snapshotHostZenModeForWindow(window);
    });

    registrar.handle('host:setZenMode', (event, active: unknown) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        return setHostZenModeForWindow(window, active === true);
    });
}

export function registerIpcHandlers(options: ICoreIpcHandlerOptions = {}) {
    registerCoreIpcHandlers(options);
    const validatedRegistrar = createValidatedIpcMainRegistrar(ipcMain);
    registerDocumentsIpcAdapter(validatedRegistrar);
    registerImageExportIpcAdapter(validatedRegistrar);
    registerPageOpsIpcAdapter(validatedRegistrar);
    registerOcrIpcAdapter(validatedRegistrar);
    registerSearchIpcAdapter(validatedRegistrar);
    registerDjvuIpcAdapter(validatedRegistrar);
}
