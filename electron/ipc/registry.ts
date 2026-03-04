import {
    BrowserWindow,
    type IpcMain,
    ipcMain,
    shell,
} from 'electron';
import { assertNonEmptyString } from '@contracts/ipc-assertions';
import type { ISettingsData } from '@contracts/shared';
import type {
    IWindowTabTransferAck,
    IWindowTabTransferRequest,
    IWindowTabTargetWindow,
} from '@contracts/window-tabs';
import { te } from '@electron/i18n';
import {
    showTabContextMenu,
    updateRecentFilesMenu,
} from '@electron/menu';
import {
    acknowledgeWindowTabTransfer,
    requestWindowTabTransfer,
} from '@electron/window-tab-transfer';
import { getAllAppWindows } from '@electron/window';
import {registerDocumentsIpcAdapter} from '@electron/features/documents/ipc-adapter';
import {registerImageExportIpcAdapter} from '@electron/features/image-export/ipc-adapter';
import {registerOcrIpcAdapter} from '@electron/features/ocr/ipc-adapter';
import {registerSearchIpcAdapter} from '@electron/features/search/ipc-adapter';
import {registerDjvuIpcAdapter} from '@electron/features/djvu/ipc-adapter';
import {registerPageOpsIpcAdapter} from '@electron/features/page-ops/ipc-adapter';
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

interface IRendererLogEntry {
    level: 'debug' | 'info' | 'warn' | 'error';
    section: string;
    message: string;
    timestamp: string;
    data?: unknown;
}

const logger = createLogger('ipc');
const rendererLogger = createLogger('renderer-bridge', {broadcastToRenderers: false});
const STARTUP_TRACE_ENABLED = process.env.EVB_STARTUP_TRACE === '1';
const ALLOWED_EXTERNAL_PROTOCOLS = new Set([
    'http:',
    'https:',
    'mailto:',
]);

interface IIpcMainHandleRegistrar {handle: IpcMain['handle'];}

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
    const normalizedUrl = assertNonEmptyString(rawUrl, 'url');
    const parsed = new URL(normalizedUrl);
    if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
        throw new Error(`Unsupported external URL protocol: ${parsed.protocol}`);
    }
    return parsed.toString();
}

function stringifyRendererLogData(data: unknown) {
    if (data === undefined) {
        return '';
    }

    try {
        return ` data=${JSON.stringify(data)}`;
    } catch {
        return ` data=${String(data)}`;
    }
}

function handleRendererLog(event: Electron.IpcMainEvent, payload: IRendererLogEntry) {
    const section = typeof payload?.section === 'string' ? payload.section : 'unknown';
    const message = typeof payload?.message === 'string' ? payload.message : '<empty>';
    const level = typeof payload?.level === 'string' ? payload.level : 'info';
    const timestamp = typeof payload?.timestamp === 'string' ? payload.timestamp : new Date().toISOString();
    const webContentsId = event.sender.id;

    const baseMessage = `[renderer:${webContentsId}] [${timestamp}] [${section}] ${message}`
        + stringifyRendererLogData(payload?.data);

    if (level === 'debug') {
        rendererLogger.debug(baseMessage);
        return;
    }

    if (level === 'warn') {
        rendererLogger.warn(baseMessage);
        return;
    }

    if (level === 'error') {
        rendererLogger.error(baseMessage);
        return;
    }

    rendererLogger.info(baseMessage);
}

function getTrustedRendererOrigin() {
    try {
        return new URL(config.server.url).origin;
    } catch {
        return '';
    }
}

function isTrustedIpcInvokeSender(event: Electron.IpcMainInvokeEvent, channel: string) {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (!sourceWindow || sourceWindow.isDestroyed() || event.sender.isDestroyed()) {
        logger.warn(`[ipc] rejected ${channel}: missing or destroyed sender window`);
        return false;
    }

    const senderMainFrame = event.sender.mainFrame;
    if (event.senderFrame && senderMainFrame && event.senderFrame !== senderMainFrame) {
        logger.warn(`[ipc] rejected ${channel}: non-main frame sender`);
        return false;
    }

    const senderUrl = event.senderFrame?.url || event.sender.getURL();
    const trustedOrigin = getTrustedRendererOrigin();
    if (!trustedOrigin || !senderUrl) {
        logger.warn(`[ipc] rejected ${channel}: missing trusted origin or sender URL`);
        return false;
    }

    let senderOrigin: string;
    try {
        senderOrigin = new URL(senderUrl).origin;
    } catch {
        logger.warn(`[ipc] rejected ${channel}: invalid sender URL ${senderUrl}`);
        return false;
    }
    if (senderOrigin !== trustedOrigin) {
        logger.warn(
            `[ipc] rejected ${channel}: untrusted sender origin ${senderOrigin} (expected ${trustedOrigin})`,
        );
        return false;
    }

    return true;
}

function createValidatedIpcMainRegistrar(registrar: IIpcMainHandleRegistrar): IIpcMainHandleRegistrar {
    return {handle: (channel, handler) => {
        registrar.handle(channel, async (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => {
            if (!isTrustedIpcInvokeSender(event, channel)) {
                throw new Error('IPC sender is not trusted');
            }
            return (handler as (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown)(
                event,
                ...args,
            );
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

function registerCoreIpcHandlers() {
    const registrar = createValidatedIpcMainRegistrar(ipcMain);
    ipcMain.on('renderer:log', handleRendererLog);

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
}

export function registerIpcHandlers() {
    registerCoreIpcHandlers();
    const validatedRegistrar = createValidatedIpcMainRegistrar(ipcMain);
    registerDocumentsIpcAdapter(validatedRegistrar);
    registerImageExportIpcAdapter(validatedRegistrar);
    registerPageOpsIpcAdapter(validatedRegistrar);
    registerOcrIpcAdapter(validatedRegistrar);
    registerSearchIpcAdapter(validatedRegistrar);
    registerDjvuIpcAdapter(validatedRegistrar);
}
