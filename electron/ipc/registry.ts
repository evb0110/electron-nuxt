import {
    BrowserWindow,
    ipcMain,
    shell,
} from 'electron';
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
    saveSettings,
} from '@electron/settings';
import {
    deferDownloadedUpdate,
    getUpdateStatus,
    installDownloadedUpdate,
    skipUpdateVersion,
    triggerManualUpdateCheck,
} from '@electron/updates';
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
    ipcMain.on('renderer:log', handleRendererLog);

    ipcMain.handle('tabs:transfer', async (event, request: IWindowTabTransferRequest) => {
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

    ipcMain.handle('tabs:transferAck', (event, ack: IWindowTabTransferAck) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) {
            return false;
        }

        return acknowledgeWindowTabTransfer(window.id, ack);
    });

    ipcMain.handle('tabs:listTargets', (event): IWindowTabTargetWindow[] => {
        const sourceWindow = BrowserWindow.fromWebContents(event.sender);
        if (!sourceWindow) {
            return [];
        }

        return buildTabTransferTargetLabels(sourceWindow.id);
    });

    ipcMain.handle('tabs:showContextMenu', (event, tabId: string) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) {
            return;
        }

        showTabContextMenu(window, tabId);
    });

    ipcMain.handle('window:closeCurrent', (event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window || window.isDestroyed()) {
            return false;
        }

        window.close();
        return true;
    });

    ipcMain.handle('settings:get', async () => {
        const startedAt = Date.now();
        const settings = await loadSettings();
        if (STARTUP_TRACE_ENABLED) {
            logger.info(`[startup] IPC settings:get resolved (+${Date.now() - startedAt}ms)`);
        }
        return settings;
    });

    ipcMain.handle('settings:save', async (_event, settings: ISettingsData) => {
        await saveSettings(settings);
        updateRecentFilesMenu();
    });

    ipcMain.handle('updates:getState', () => getUpdateStatus());
    ipcMain.handle('updates:check', () => triggerManualUpdateCheck());
    ipcMain.handle('updates:install', () => installDownloadedUpdate());
    ipcMain.handle('updates:defer', () => deferDownloadedUpdate());
    ipcMain.handle('updates:skipVersion', (_event, version: string) => skipUpdateVersion(version));

    ipcMain.handle('shell:openExternal', async (_event, url: string) => {
        const parsed = new URL(url);
        if ([
            'http:',
            'https:',
            'mailto:',
        ].includes(parsed.protocol)) {
            await shell.openExternal(url);
        }
    });
}

export function registerIpcHandlers() {
    registerCoreIpcHandlers();
    registerDocumentsIpcAdapter(ipcMain);
    registerImageExportIpcAdapter(ipcMain);
    registerPageOpsIpcAdapter(ipcMain);
    registerOcrIpcAdapter(ipcMain);
    registerSearchIpcAdapter(ipcMain);
    registerDjvuIpcAdapter(ipcMain);
}
