import {
    BrowserWindow,
    ipcMain,
    shell,
    webContents,
} from 'electron';
import type { IIpcMainRegistrar } from '@contracts/ipc-main';
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

interface IRendererLogRateState {
    tokens: number;
    lastRefillAt: number;
    droppedLogs: number;
    lastDropNoticeAt: number;
}

const logger = createLogger('ipc');
const rendererLogger = createLogger('renderer-bridge', {broadcastToRenderers: false});
const STARTUP_TRACE_ENABLED = process.env.EVB_STARTUP_TRACE === '1';
const ALLOWED_EXTERNAL_PROTOCOLS = new Set([
    'http:',
    'https:',
    'mailto:',
]);
const RENDERER_LOG_MAX_SECTION_CHARS = (() => {
    const parsed = Number.parseInt(process.env.EVB_RENDERER_LOG_MAX_SECTION_CHARS ?? '128', 10);
    if (!Number.isFinite(parsed) || parsed < 16) {
        return 128;
    }
    return Math.min(parsed, 512);
})();
const RENDERER_LOG_MAX_MESSAGE_CHARS = (() => {
    const parsed = Number.parseInt(process.env.EVB_RENDERER_LOG_MAX_MESSAGE_CHARS ?? '2000', 10);
    if (!Number.isFinite(parsed) || parsed < 128) {
        return 2_000;
    }
    return Math.min(parsed, 16_000);
})();
const RENDERER_LOG_MAX_DATA_CHARS = (() => {
    const parsed = Number.parseInt(process.env.EVB_RENDERER_LOG_MAX_DATA_CHARS ?? '8000', 10);
    if (!Number.isFinite(parsed) || parsed < 256) {
        return 8_000;
    }
    return Math.min(parsed, 64_000);
})();
const RENDERER_LOG_SERIALIZE_MAX_DEPTH = (() => {
    const parsed = Number.parseInt(process.env.EVB_RENDERER_LOG_SERIALIZE_MAX_DEPTH ?? '4', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 4;
    }
    return Math.min(parsed, 8);
})();
const RENDERER_LOG_SERIALIZE_MAX_NODES = (() => {
    const parsed = Number.parseInt(process.env.EVB_RENDERER_LOG_SERIALIZE_MAX_NODES ?? '256', 10);
    if (!Number.isFinite(parsed) || parsed < 16) {
        return 256;
    }
    return Math.min(parsed, 8_192);
})();
const RENDERER_LOG_SERIALIZE_MAX_ARRAY_ITEMS = (() => {
    const parsed = Number.parseInt(process.env.EVB_RENDERER_LOG_SERIALIZE_MAX_ARRAY_ITEMS ?? '64', 10);
    if (!Number.isFinite(parsed) || parsed < 4) {
        return 64;
    }
    return Math.min(parsed, 1_024);
})();
const RENDERER_LOG_SERIALIZE_MAX_OBJECT_KEYS = (() => {
    const parsed = Number.parseInt(process.env.EVB_RENDERER_LOG_SERIALIZE_MAX_OBJECT_KEYS ?? '64', 10);
    if (!Number.isFinite(parsed) || parsed < 4) {
        return 64;
    }
    return Math.min(parsed, 2_048);
})();
const RENDERER_LOG_RATE_LIMIT_PER_SECOND = (() => {
    const parsed = Number.parseInt(process.env.EVB_RENDERER_LOG_RATE_LIMIT_PER_SECOND ?? '60', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 60;
    }
    return Math.min(parsed, 5_000);
})();
const RENDERER_LOG_RATE_LIMIT_BURST = (() => {
    const parsed = Number.parseInt(process.env.EVB_RENDERER_LOG_RATE_LIMIT_BURST ?? '120', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 120;
    }
    return Math.min(parsed, 10_000);
})();
const RENDERER_LOG_DROP_NOTICE_INTERVAL_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_RENDERER_LOG_DROP_NOTICE_INTERVAL_MS ?? '5000', 10);
    if (!Number.isFinite(parsed) || parsed < 250) {
        return 5_000;
    }
    return parsed;
})();
const rendererLogRateStateBySender = new Map<number, IRendererLogRateState>();

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

function clampString(value: unknown, maxChars: number, fallback = '') {
    if (typeof value !== 'string') {
        return fallback;
    }

    const trimmed = value.trim();
    if (trimmed.length <= maxChars) {
        return trimmed;
    }
    return `${trimmed.slice(0, maxChars)}…`;
}

interface IRendererLogSerializeState {
    remainingNodes: number;
    seen: WeakSet<object>;
}

function normalizeRendererLogData(
    value: unknown,
    depth: number,
    state: IRendererLogSerializeState,
): unknown {
    if (state.remainingNodes <= 0) {
        return '[Truncated]';
    }

    if (value === null || value === undefined) {
        return value ?? null;
    }

    const valueType = typeof value;
    if (valueType === 'string') {
        return clampString(value, RENDERER_LOG_MAX_DATA_CHARS);
    }
    if (valueType === 'number' || valueType === 'boolean') {
        return value;
    }
    if (valueType === 'bigint') {
        return `${value}n`;
    }
    if (valueType === 'symbol') {
        return String(value);
    }
    if (valueType === 'function') {
        const functionValue = value as { name?: unknown };
        const functionName = typeof functionValue.name === 'string'
            ? functionValue.name
            : '';
        return `[Function ${functionName || 'anonymous'}]`;
    }

    if (depth >= RENDERER_LOG_SERIALIZE_MAX_DEPTH) {
        return '[MaxDepth]';
    }

    if (value instanceof Date) {
        return value.toISOString();
    }
    if (value instanceof RegExp) {
        return String(value);
    }
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: clampString(value.stack, RENDERER_LOG_MAX_MESSAGE_CHARS),
        };
    }
    if (ArrayBuffer.isView(value)) {
        const typedArray = value;
        return `[${typedArray.constructor.name}(${typedArray.byteLength})]`;
    }
    if (value instanceof ArrayBuffer) {
        return `[ArrayBuffer(${value.byteLength})]`;
    }

    if (typeof value !== 'object') {
        return String(value);
    }

    if (state.seen.has(value)) {
        return '[Circular]';
    }
    state.seen.add(value);
    state.remainingNodes -= 1;

    try {
        if (Array.isArray(value)) {
            const normalizedItems = value
                .slice(0, RENDERER_LOG_SERIALIZE_MAX_ARRAY_ITEMS)
                .map(item => normalizeRendererLogData(item, depth + 1, state));
            if (value.length > RENDERER_LOG_SERIALIZE_MAX_ARRAY_ITEMS) {
                normalizedItems.push(`[+${value.length - RENDERER_LOG_SERIALIZE_MAX_ARRAY_ITEMS} more items]`);
            }
            return normalizedItems;
        }

        const normalizedObject: Record<string, unknown> = {};
        const entries = Object.entries(value as Record<string, unknown>);
        const maxKeys = Math.min(entries.length, RENDERER_LOG_SERIALIZE_MAX_OBJECT_KEYS);
        for (let index = 0; index < maxKeys; index += 1) {
            const entry = entries[index];
            if (!entry) {
                continue;
            }
            const [
                key,
                itemValue,
            ] = entry;
            normalizedObject[key] = normalizeRendererLogData(itemValue, depth + 1, state);
        }
        if (entries.length > RENDERER_LOG_SERIALIZE_MAX_OBJECT_KEYS) {
            normalizedObject.__truncatedKeys = entries.length - RENDERER_LOG_SERIALIZE_MAX_OBJECT_KEYS;
        }
        return normalizedObject;
    } finally {
        state.seen.delete(value);
    }
}

function stringifyRendererLogData(data: unknown) {
    if (data === undefined) {
        return '';
    }

    let serialized: string;
    try {
        const normalized = normalizeRendererLogData(data, 0, {
            remainingNodes: RENDERER_LOG_SERIALIZE_MAX_NODES,
            seen: new WeakSet<object>(),
        });
        serialized = JSON.stringify(normalized);
    } catch {
        serialized = clampString(String(data), RENDERER_LOG_MAX_DATA_CHARS);
    }

    if (!serialized) {
        serialized = '';
    }

    if (serialized.length > RENDERER_LOG_MAX_DATA_CHARS) {
        const originalLength = serialized.length;
        serialized = `${serialized.slice(0, RENDERER_LOG_MAX_DATA_CHARS)}…(truncated ${originalLength - RENDERER_LOG_MAX_DATA_CHARS} chars)`;
    }
    return ` data=${serialized}`;
}

function consumeRendererLogRateToken(webContentsId: number) {
    const now = Date.now();
    const existingState = rendererLogRateStateBySender.get(webContentsId);
    const state: IRendererLogRateState = existingState ?? {
        tokens: RENDERER_LOG_RATE_LIMIT_BURST,
        lastRefillAt: now,
        droppedLogs: 0,
        lastDropNoticeAt: 0,
    };

    const elapsedMs = Math.max(0, now - state.lastRefillAt);
    const refill = (elapsedMs / 1_000) * RENDERER_LOG_RATE_LIMIT_PER_SECOND;
    state.tokens = Math.min(RENDERER_LOG_RATE_LIMIT_BURST, state.tokens + refill);
    state.lastRefillAt = now;

    if (state.tokens >= 1) {
        state.tokens -= 1;
        if (state.droppedLogs > 0 && now - state.lastDropNoticeAt >= RENDERER_LOG_DROP_NOTICE_INTERVAL_MS) {
            rendererLogger.warn(
                `[renderer:${webContentsId}] Dropped ${state.droppedLogs} renderer log message(s) due to rate limiting`,
            );
            state.droppedLogs = 0;
            state.lastDropNoticeAt = now;
        }
        rendererLogRateStateBySender.set(webContentsId, state);
        return true;
    }

    state.droppedLogs += 1;
    if (now - state.lastDropNoticeAt >= RENDERER_LOG_DROP_NOTICE_INTERVAL_MS) {
        rendererLogger.warn(
            `[renderer:${webContentsId}] Renderer log channel is rate-limited (limit ${RENDERER_LOG_RATE_LIMIT_PER_SECOND}/s, burst ${RENDERER_LOG_RATE_LIMIT_BURST})`,
        );
        state.lastDropNoticeAt = now;
    }
    rendererLogRateStateBySender.set(webContentsId, state);
    return false;
}

function pruneRendererLogRateState() {
    for (const senderId of rendererLogRateStateBySender.keys()) {
        const contents = webContents.fromId(senderId);
        if (!contents || contents.isDestroyed()) {
            rendererLogRateStateBySender.delete(senderId);
        }
    }
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

    const senderUrl = senderFrame?.url || sender.getURL();
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

function handleRendererLog(event: Electron.IpcMainEvent, payload: IRendererLogEntry) {
    const webContentsId = event.sender.id;
    if (!isTrustedWebContentsSender(event.sender, event.senderFrame, 'renderer:log')) {
        return;
    }
    if (!consumeRendererLogRateToken(webContentsId)) {
        return;
    }
    if (rendererLogRateStateBySender.size > 512) {
        pruneRendererLogRateState();
    }

    const section = clampString(payload?.section, RENDERER_LOG_MAX_SECTION_CHARS, 'unknown');
    const message = clampString(payload?.message, RENDERER_LOG_MAX_MESSAGE_CHARS, '<empty>');
    const level = typeof payload?.level === 'string' ? payload.level : 'info';
    const timestamp = clampString(payload?.timestamp, 128, new Date().toISOString());

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
