import {
    app,
    BrowserWindow,
    ipcMain,
} from 'electron';
import { randomUUID } from 'node:crypto';
import type { IAppUpdateStatus } from '@contracts/electron-api';
import {
    dirname,
    extname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { uniq } from 'es-toolkit/array';
import { config } from '@electron/config';
import {
    registerIpcHandlers,
    clearAllWorkingCopies,
} from '@electron/ipc';
import {
    sendToWindow,
    setupMenu,
} from '@electron/menu';
import { initRecentFilesCache } from '@electron/recent-files';
import { stopServer } from '@electron/server';
import {
    createWindow,
    getAllAppWindows,
    getMainWindow,
    hasWindows,
} from '@electron/window';
import {
    markWindowTabTransferReady,
    markWindowTabTransferWindowClosed,
} from '@electron/window-tab-transfer';
import { promptSetDefaultViewer } from '@electron/default-viewer';
import { createLogger } from '@electron/utils/logger';
import { initializeUpdates } from '@electron/updates';

app.setName(app.isPackaged ? 'EVB Viewer' : 'EVB Viewer Dev');
if (process.platform === 'win32') {
    app.setAppUserModelId('com.evb.viewer');
}

// Explicitly set userData path to ensure it uses our app name
// This fixes a race condition where imports above may cache the default "Electron" path
const automationUserDataDir = process.env.EVB_AUTOMATION_USER_DATA_DIR?.trim();
if (automationUserDataDir) {
    app.setPath('userData', automationUserDataDir);
} else {
    app.setPath('userData', join(app.getPath('appData'), app.name));
}

const logger = createLogger('main');
let gracefulShutdownPromise: Promise<void> | null = null;
let isQuittingAfterCleanup = false;
let isFatalShutdownInProgress = false;
process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled promise rejection in main process: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});
process.on('uncaughtException', (error) => {
    logger.error(`Uncaught exception in main process: ${error.stack ?? error.message}`);
    if (isFatalShutdownInProgress) {
        return;
    }

    isFatalShutdownInProgress = true;
    void (async () => {
        try {
            await performShutdownCleanup();
        } finally {
            app.exit(1);
        }
    })();
});

if (process.platform === 'darwin' && config.automation.noFocus) {
    try {
        // Keep automation sessions from becoming the active foreground app on macOS.
        app.setActivationPolicy('accessory');
    } catch (error) {
        logger.warn(
            `Failed to switch activation policy for automation mode: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
}

const startupStartedAt = Date.now();
const startupSessionId = `${startupStartedAt}-${randomUUID()}`;
const STARTUP_TRACE_ENABLED = process.env.EVB_STARTUP_TRACE === '1';

function logStartupPhase(phase: string) {
    if (!STARTUP_TRACE_ENABLED) {
        return;
    }

    const now = Date.now();
    const elapsedMs = now - startupStartedAt;
    const message = `[startup] ${phase} (+${elapsedMs}ms)`;
    logger.info(message);
    console.info(`[${new Date(now).toISOString()}] [main] ${message}`, {
        startupSessionId,
        elapsedMs,
    });
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const devDockIconPath = join(__dirname, '..', 'resources', 'icon.png');
const aboutIconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : devDockIconPath;

const SUPPORTED_EXTENSIONS = new Set([
    '.pdf',
    '.djvu',
    '.djv',
    '.png',
    '.jpg',
    '.jpeg',
    '.tif',
    '.tiff',
    '.bmp',
    '.webp',
    '.gif',
]);
const pendingExternalOpenPaths: string[] = [];
const pendingExternalOpenPathSet = new Set<string>();
const readyWindowIds = new Set<number>();
let defaultViewerPromptShown = false;
let defaultViewerPromptTimer: NodeJS.Timeout | null = null;
let flushPendingFilesTimer: ReturnType<typeof setTimeout> | null = null;
let batchWindowStartTime: number | null = null;
let externalOpenBootstrapReady = false;
let ensureWindowForExternalOpenPromise: Promise<void> | null = null;
let hasHandledInitialExternalOpenDispatch = false;
const EXTERNAL_OPEN_BATCH_WINDOW_MS = 800;
const EXTERNAL_OPEN_MAX_BATCH_WAIT_MS = 10_000;
const EXTERNAL_OPEN_PENDING_MAX_PATHS = (() => {
    const parsed = Number.parseInt(process.env.EVB_EXTERNAL_OPEN_PENDING_MAX_PATHS ?? '256', 10);
    if (!Number.isFinite(parsed) || parsed < 8) {
        return 256;
    }
    return Math.min(parsed, 4_096);
})();

function isMainWindowRendererReady() {
    const mainWindow = getMainWindow();
    if (!mainWindow) {
        return false;
    }

    return readyWindowIds.has(mainWindow.id);
}

function isSupportedFile(filePath: string) {
    return SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function normalizeCommandLineArg(arg: string): string | null {
    let normalized = arg.trim();
    if (!normalized || normalized.startsWith('-')) {
        return null;
    }

    if (
        (normalized.startsWith('"') && normalized.endsWith('"'))
        || (normalized.startsWith('\'') && normalized.endsWith('\''))
    ) {
        normalized = normalized.slice(1, -1);
    }

    if (!normalized) {
        return null;
    }

    if (process.platform === 'win32' && normalized.startsWith('/')) {
        return null;
    }

    if (normalized.startsWith('file://')) {
        try {
            return fileURLToPath(normalized);
        } catch {
            return null;
        }
    }

    return normalized;
}

function collectSupportedPathsFromArgs(args: string[]): string[] {
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const normalized = normalizeCommandLineArg(args[i] ?? '');
        if (!normalized) {
            continue;
        }

        if (isSupportedFile(normalized)) {
            files.push(normalized);
            continue;
        }

        // Some shell verbs can emit unquoted multi-token paths (e.g., from %*).
        // Reconstruct path candidates by joining subsequent tokens with spaces.
        let candidate = normalized;
        for (let j = i + 1; j < args.length && j <= i + 7; j++) {
            const nextToken = normalizeCommandLineArg(args[j] ?? '');
            if (!nextToken) {
                break;
            }
            candidate = `${candidate} ${nextToken}`;
            if (isSupportedFile(candidate)) {
                files.push(candidate);
                i = j;
                break;
            }
        }
    }
    return files;
}

function queueOpenRequest(paths: string[]) {
    const normalizedPaths = uniq(paths
        .map(path => path.trim())
        .filter(path => path.length > 0));
    if (normalizedPaths.length === 0) {
        return;
    }

    let coalescedCount = 0;
    let droppedCount = 0;
    for (const normalizedPath of normalizedPaths) {
        if (pendingExternalOpenPathSet.has(normalizedPath)) {
            coalescedCount += 1;
            const existingIndex = pendingExternalOpenPaths.indexOf(normalizedPath);
            if (existingIndex >= 0) {
                pendingExternalOpenPaths.splice(existingIndex, 1);
            } else {
                pendingExternalOpenPathSet.delete(normalizedPath);
            }
        }

        pendingExternalOpenPaths.push(normalizedPath);
        pendingExternalOpenPathSet.add(normalizedPath);

        while (pendingExternalOpenPaths.length > EXTERNAL_OPEN_PENDING_MAX_PATHS) {
            const droppedPath = pendingExternalOpenPaths.shift();
            if (!droppedPath) {
                break;
            }
            pendingExternalOpenPathSet.delete(droppedPath);
            droppedCount += 1;
        }
    }

    if (coalescedCount > 0) {
        logger.debug(`Coalesced ${coalescedCount} duplicate external open path(s)`);
    }
    if (droppedCount > 0) {
        logger.warn(
            `External open queue exceeded cap (${EXTERNAL_OPEN_PENDING_MAX_PATHS}); dropped ${droppedCount} oldest path(s)`,
        );
    }
}

function collectMergedPendingPaths() {
    if (pendingExternalOpenPaths.length === 0) {
        return [];
    }
    const mergedPaths = pendingExternalOpenPaths.slice();
    pendingExternalOpenPaths.length = 0;
    pendingExternalOpenPathSet.clear();
    return mergedPaths;
}

function queueOpenRequestFromArgs(args: string[]) {
    const parsedPaths = collectSupportedPathsFromArgs(args);
    if (parsedPaths.length > 0) {
        logger.info(`Parsed external open paths (${parsedPaths.length}): ${parsedPaths.join(' | ')}`);
    }
    queueOpenRequest(parsedPaths);
}

function focusMainWindow() {
    const window = getMainWindow();
    if (!window) {
        return;
    }

    if (window.isMinimized()) {
        window.restore();
    }

    if (config.automation.noFocus) {
        return;
    }

    window.focus();
}

async function ensureMainWindowForExternalOpen() {
    await app.whenReady();

    if (!externalOpenBootstrapReady) {
        // Initial startup flow creates the first window after IPC/bootstrap wiring is ready.
        // Avoid creating windows earlier to prevent missing renderer-ready signals.
        return;
    }

    if (!hasWindows()) {
        logger.info('External open requested without active windows; creating main window');
        readyWindowIds.clear();
        await createWindow();
        logStartupPhase('Main window creation requested by external open');
    }

    focusMainWindow();
    scheduleFlushPendingFiles();
}

function requestMainWindowForExternalOpen() {
    if (ensureWindowForExternalOpenPromise) {
        return;
    }

    ensureWindowForExternalOpenPromise = (async () => {
        try {
            await ensureMainWindowForExternalOpen();
        } catch (error) {
            logger.error(`Failed to prepare window for external open: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            ensureWindowForExternalOpenPromise = null;
        }
    })();
}

function flushPendingFiles() {
    if (flushPendingFilesTimer) {
        clearTimeout(flushPendingFilesTimer);
        flushPendingFilesTimer = null;
    }
    batchWindowStartTime = null;

    if (!isMainWindowRendererReady()) {
        return;
    }

    const window = getMainWindow();
    if (!window) {
        return;
    }

    const paths = collectMergedPendingPaths();
    if (paths.length > 0) {
        logger.info(`Flushing ${paths.length} batched external open path(s)`);
        sendToWindow(window, 'menu:openExternalPaths', paths);
        logStartupPhase(`Dispatched external file open batch (${paths.length} path(s))`);
    }
}

function scheduleFlushPendingFiles() {
    if (!isMainWindowRendererReady()) {
        return;
    }

    if (!hasHandledInitialExternalOpenDispatch) {
        hasHandledInitialExternalOpenDispatch = true;
        flushPendingFiles();
        return;
    }

    const now = Date.now();
    if (batchWindowStartTime === null) {
        batchWindowStartTime = now;
    }

    if (now - batchWindowStartTime >= EXTERNAL_OPEN_MAX_BATCH_WAIT_MS) {
        flushPendingFiles();
        return;
    }

    if (flushPendingFilesTimer) {
        clearTimeout(flushPendingFilesTimer);
    }

    flushPendingFilesTimer = setTimeout(() => {
        flushPendingFiles();
    }, EXTERNAL_OPEN_BATCH_WINDOW_MS);
}

function maybePromptForDefaultViewer() {
    if (config.automation.noFocus) {
        return;
    }

    if (defaultViewerPromptShown) {
        return;
    }
    const window = getMainWindow();
    if (!window) {
        return;
    }
    defaultViewerPromptShown = true;
    defaultViewerPromptTimer = setTimeout(() => {
        defaultViewerPromptTimer = null;
        if (window.isDestroyed()) {
            return;
        }
        void promptSetDefaultViewer(window);
    }, 1_500);
}

async function performShutdownCleanup() {
    if (defaultViewerPromptTimer) {
        clearTimeout(defaultViewerPromptTimer);
        defaultViewerPromptTimer = null;
    }
    if (flushPendingFilesTimer) {
        clearTimeout(flushPendingFilesTimer);
        flushPendingFilesTimer = null;
    }
    batchWindowStartTime = null;

    clearAllWorkingCopies();
    await stopServer();
}

function requestGracefulQuit() {
    if (isQuittingAfterCleanup) {
        return;
    }
    if (!gracefulShutdownPromise) {
        gracefulShutdownPromise = (async () => {
            try {
                await performShutdownCleanup();
            } catch (error) {
                logger.error(`Graceful shutdown cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        })();
    }

    void gracefulShutdownPromise.then(() => {
        if (isQuittingAfterCleanup) {
            return;
        }
        isQuittingAfterCleanup = true;
        app.quit();
    });
}

function broadcastUpdateStatus(status: IAppUpdateStatus) {
    for (const window of getAllAppWindows()) {
        sendToWindow(window, 'updates:status', status);
    }
}

const allowMultipleAutomationSessions = process.env.EVB_ALLOW_MULTI_AUTOMATION_SESSIONS === '1';

if (!allowMultipleAutomationSessions) {
    const singleInstanceLock = app.requestSingleInstanceLock();
    if (!singleInstanceLock) {
        app.quit();
        process.exit(0);
    }
} else {
    logger.info('Automation harness mode: bypassing single-instance lock to allow multiple sessions');
}

// macOS: open-file fires when a file is double-clicked while the app is running or launching.
// Must register before app.whenReady() because macOS sends it early during launch.
app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (!isSupportedFile(filePath)) {
        logger.warn(`Ignoring unsupported macOS open-file path: ${filePath}`);
        return;
    }
    queueOpenRequest([filePath]);
    requestMainWindowForExternalOpen();
});

// Windows/Linux: the OS passes the file path as a command-line argument
if (process.platform !== 'darwin') {
    queueOpenRequestFromArgs(process.argv.slice(1));
}

app.on('second-instance', (_event, commandLine) => {
    queueOpenRequestFromArgs(commandLine.slice(1));
    requestMainWindowForExternalOpen();
});

async function init() {
    logStartupPhase('Bootstrap init started');
    await app.whenReady();
    logStartupPhase('app.whenReady resolved');
    // In packaged builds, macOS uses the app bundle's .icns icon.
    // Only override in development where the host Electron binary has the default icon.
    if (process.platform === 'darwin' && !app.isPackaged) {
        try {
            app.dock?.setIcon(devDockIconPath);
        } catch (err) {
            logger.warn(`Failed to set dock icon: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    const appVersion = app.getVersion();
    app.setAboutPanelOptions({
        applicationName: 'EVB Viewer',
        applicationVersion: appVersion,
        version: appVersion.startsWith('0.') ? 'Beta' : undefined,
        copyright: 'Copyright \u00A9 2026 Eugene Barsky',
        iconPath: aboutIconPath,
        authors: ['Eugene Barsky'],
    });

    registerIpcHandlers();
    logStartupPhase('IPC handlers registered');

    ipcMain.on('app:rendererReady', (event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) {
            return;
        }

        readyWindowIds.add(window.id);
        markWindowTabTransferReady(window.id);

        scheduleFlushPendingFiles();
        if (window.id === getMainWindow()?.id) {
            logStartupPhase(`Main renderer signaled ready (windowId=${window.id})`);
            maybePromptForDefaultViewer();
        }
    });

    app.on('browser-window-created', (_event, window) => {
        const markNotReady = () => {
            readyWindowIds.delete(window.id);
        };

        window.webContents.on('did-start-loading', markNotReady);
        window.webContents.on('render-process-gone', markNotReady);

        window.on('closed', () => {
            markNotReady();
            markWindowTabTransferWindowClosed(window.id);
        });
    });

    app.on('window-all-closed', () => {
        if (!config.isMac) {
            app.quit();
        }
    });

    app.on('before-quit', (event) => {
        if (isQuittingAfterCleanup || isFatalShutdownInProgress) {
            return;
        }
        event.preventDefault();
        requestGracefulQuit();
    });

    app.on('activate', () => {
        if (config.automation.noFocus) {
            return;
        }

        if (!hasWindows()) {
            readyWindowIds.clear();
            void createWindow().catch((error) => {
                logger.error(`Failed to create window on activate: ${error instanceof Error ? error.message : String(error)}`);
            });
            return;
        }
        focusMainWindow();
        scheduleFlushPendingFiles();
    });

    externalOpenBootstrapReady = true;
    readyWindowIds.clear();
    logStartupPhase('Creating main window');
    await createWindow();
    logStartupPhase('Main window creation requested');

    if (config.automation.noFocus && process.platform === 'darwin') {
        try {
            if (app.dock) {
                app.dock.hide();
            }
        } catch (error) {
            logger.warn(`Failed to hide dock in automation mode: ${error instanceof Error ? error.message : String(error)}`);
        }
        app.hide();
    }

    void (async () => {
        try {
            initializeUpdates(broadcastUpdateStatus);
            logStartupPhase('Update service initialized');
        } catch (error) {
            logger.error(`Failed to initialize updates: ${error instanceof Error ? error.message : String(error)}`);
        }

        try {
            await initRecentFilesCache();
            logStartupPhase('Recent files cache initialized');
        } catch (error) {
            logger.error(`Failed to initialize recent files cache: ${error instanceof Error ? error.message : String(error)}`);
        }

        try {
            setupMenu();
            logStartupPhase('Application menu initialized');
        } catch (error) {
            logger.error(`Failed to initialize application menu: ${error instanceof Error ? error.message : String(error)}`);
        }
    })();
}

void init().catch((error) => {
    logger.error(`Application bootstrap failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    void (async () => {
        try {
            await performShutdownCleanup();
        } finally {
            app.exit(1);
        }
    })();
});
