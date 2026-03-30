import {
    app,
    BrowserWindow,
    ipcMain,
    nativeImage,
} from 'electron';
import type { IAppUpdateStatus } from '@contracts/electron-api';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import {
    createExternalOpenManager,
    createMacOpenFileRouter,
} from '@electron/bootstrap/external-open';
import {
    createShutdownCoordinator,
    runShutdownSteps,
} from '@electron/bootstrap/shutdown';
import { createStartupTrace } from '@electron/bootstrap/startup-trace';
import { config } from '@electron/config';
import {
    registerIpcHandlers,
    clearAllWorkingCopies,
    cleanupStaleWorkingCopyDirectories,
} from '@electron/ipc';
import {
    sendToWindow,
    setupMenu,
} from '@electron/menu';
import { initRecentFilesCache } from '@electron/recent-files';
import { stopServer } from '@electron/server';
import { performDjvuViewingShutdownCleanup } from '@electron/features/djvu/main/viewing';
import { shutdownOcrJobManager } from '@electron/ocr/jobManager';
import {
    createWindow,
    getAllAppWindows,
    getMainWindow,
    hasWindows,
    markWindowRendererReady,
} from '@electron/window';
import {
    markWindowTabTransferReady,
    markWindowTabTransferWindowClosed,
} from '@electron/window-tab-transfer';
import { promptSetDefaultViewer } from '@electron/default-viewer';
import { createLogger } from '@electron/utils/logger';
import {
    initializeUpdates,
    shutdownUpdates,
} from '@electron/updates';

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
const macOpenFileRouter = createMacOpenFileRouter({ logger });
// Keep fatal shutdown opt-in for unhandled rejections: many promise failures are
// feature-local and should not crash the entire public app.
const FATAL_UNHANDLED_REJECTION_ENABLED = process.env.EVB_MAIN_FATAL_UNHANDLED_REJECTION === '1';
const startupTrace = createStartupTrace(logger);
const logStartupPhase = startupTrace.log;

// macOS can deliver open-file during very early cold-start launch, before the
// rest of the external-open pipeline is initialized.
app.on('open-file', (event, filePath) => {
    event.preventDefault();
    macOpenFileRouter.handleOpenFile(filePath);
});

function isIgnorableUnhandledRejection(reason: unknown) {
    if (!(reason instanceof Error)) {
        return false;
    }
    if (reason.name === 'AbortError') {
        return true;
    }

    const normalizedMessage = reason.message.toLowerCase();
    if (normalizedMessage.includes('aborted')) {
        return true;
    }
    if (normalizedMessage.includes('cancelled') || normalizedMessage.includes('canceled')) {
        return true;
    }
    return false;
}

process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled promise rejection in main process: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
    if (!FATAL_UNHANDLED_REJECTION_ENABLED || isIgnorableUnhandledRejection(reason)) {
        return;
    }
    shutdownCoordinator.requestFatalShutdown('Unhandled promise rejection requires fatal shutdown');
});
process.on('uncaughtException', (error) => {
    shutdownCoordinator.requestFatalShutdown(`Uncaught exception in main process: ${error.stack ?? error.message}`);
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const devDockIconPath = join(__dirname, '..', 'resources', 'icon.png');
const aboutIconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : devDockIconPath;
const DEV_DOCK_BADGE_TEXT = 'DEV';

const readyWindowIds = new Set<number>();
let defaultViewerPromptShown = false;
let defaultViewerPromptTimer: NodeJS.Timeout | null = null;

function blendColorChannel(base: number, overlay: number, alpha: number) {
    return Math.round((base * (255 - alpha) + overlay * alpha) / 255);
}

function fillBitmapRect(
    bitmap: Uint8ClampedArray,
    width: number,
    height: number,
    startX: number,
    startY: number,
    rectWidth: number,
    rectHeight: number,
    color: {
        r: number;
        g: number;
        b: number;
        a: number;
    },
) {
    const boundedStartX = Math.max(startX, 0);
    const boundedStartY = Math.max(startY, 0);
    const endX = Math.min(boundedStartX + Math.max(rectWidth, 0), width);
    const endY = Math.min(boundedStartY + Math.max(rectHeight, 0), height);
    for (let y = boundedStartY; y < endY; y += 1) {
        for (let x = boundedStartX; x < endX; x += 1) {
            const offset = ((y * width) + x) * 4;
            const blue = bitmap[offset] ?? 0;
            const green = bitmap[offset + 1] ?? 0;
            const red = bitmap[offset + 2] ?? 0;
            const alpha = bitmap[offset + 3] ?? 0;
            bitmap[offset] = blendColorChannel(blue, color.b, color.a);
            bitmap[offset + 1] = blendColorChannel(green, color.g, color.a);
            bitmap[offset + 2] = blendColorChannel(red, color.r, color.a);
            bitmap[offset + 3] = Math.max(alpha, color.a);
        }
    }
}

function createDevDockIcon() {
    const baseIcon = nativeImage.createFromPath(devDockIconPath);
    if (baseIcon.isEmpty()) {
        return null;
    }

    const {
        width,
        height,
    } = baseIcon.getSize();
    if (width <= 0 || height <= 0) {
        return null;
    }

    const bitmap = new Uint8ClampedArray(baseIcon.toBitmap());
    const markerSize = Math.max(Math.floor(Math.min(width, height) * 0.28), 56);
    const inset = Math.max(Math.floor(markerSize * 0.12), 8);
    const borderWidth = Math.max(Math.floor(markerSize * 0.08), 4);
    const anchorX = width - markerSize - inset;
    const anchorY = inset;

    fillBitmapRect(bitmap, width, height, anchorX, anchorY, markerSize, markerSize, {
        r: 219,
        g: 39,
        b: 39,
        a: 255,
    });
    fillBitmapRect(
        bitmap,
        width,
        height,
        anchorX + borderWidth,
        anchorY + borderWidth,
        markerSize - (borderWidth * 2),
        markerSize - (borderWidth * 2),
        {
            r: 255,
            g: 255,
            b: 255,
            a: 255,
        },
    );
    fillBitmapRect(
        bitmap,
        width,
        height,
        anchorX + Math.floor(markerSize * 0.35),
        anchorY + Math.floor(markerSize * 0.18),
        borderWidth,
        Math.floor(markerSize * 0.64),
        {
            r: 219,
            g: 39,
            b: 39,
            a: 255,
        },
    );
    fillBitmapRect(
        bitmap,
        width,
        height,
        anchorX + Math.floor(markerSize * 0.18),
        anchorY + Math.floor(markerSize * 0.47),
        Math.floor(markerSize * 0.64),
        borderWidth,
        {
            r: 219,
            g: 39,
            b: 39,
            a: 255,
        },
    );

    return nativeImage.createFromBitmap(Buffer.from(bitmap), {
        width,
        height,
    });
}

function isMainWindowRendererReady() {
    const mainWindow = getMainWindow();
    if (!mainWindow) {
        return false;
    }

    return readyWindowIds.has(mainWindow.id);
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
const externalOpenManager = createExternalOpenManager({
    logger,
    noFocus: config.automation.noFocus,
    logStartupPhase,
    isMainWindowRendererReady,
    getMainWindow,
    hasWindows,
    createWindow: async () => {
        readyWindowIds.clear();
        await createWindow();
    },
    dispatchOpenPaths: (paths) => {
        const window = BrowserWindow.getFocusedWindow() ?? getMainWindow();
        if (!window) {
            return false;
        }

        return sendToWindow(window, 'menu:openExternalPaths', paths);
    },
});
macOpenFileRouter.attachExternalOpenManager(externalOpenManager);

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
    externalOpenManager.clearTimers();
    shutdownCoordinator.clearGracefulQuitForceTimer();

    await runShutdownSteps(logger, [
        {
            label: 'updates',
            run: () => shutdownUpdates(), 
        },
        {
            label: 'djvu-viewing',
            run: () => performDjvuViewingShutdownCleanup(), 
        },
        {
            label: 'ocr-job-manager',
            run: () => shutdownOcrJobManager(), 
        },
        {
            label: 'working-copies',
            run: () => clearAllWorkingCopies(), 
        },
        {
            label: 'runtime-server',
            run: () => stopServer(), 
        },
    ]);
}

const shutdownCoordinator = createShutdownCoordinator({
    app,
    logger,
    runCleanupSteps: performShutdownCleanup,
});

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

// Windows/Linux: the OS passes the file path as a command-line argument
if (process.platform !== 'darwin') {
    externalOpenManager.queueOpenRequestFromArgs(process.argv.slice(1));
}

app.on('second-instance', (_event, commandLine) => {
    externalOpenManager.queueOpenRequestFromArgs(commandLine.slice(1));
    externalOpenManager.requestMainWindowForExternalOpen();
});

async function init() {
    logStartupPhase('Bootstrap init started');
    await app.whenReady();
    logStartupPhase('app.whenReady resolved');
    if (config.automation.noFocus && process.platform === 'darwin') {
        try {
            app.dock?.hide();
        } catch (error) {
            logger.warn(`Failed to hide dock before window creation in automation mode: ${error instanceof Error ? error.message : String(error)}`);
        }
        app.hide();
    }
    // In packaged builds, macOS uses the app bundle's .icns icon.
    // Only override in development where the host Electron binary has the default icon.
    if (process.platform === 'darwin' && !app.isPackaged && !config.automation.noFocus) {
        try {
            const devDockIcon = createDevDockIcon();
            app.dock?.setIcon(devDockIcon ?? devDockIconPath);
            app.dock?.setBadge(DEV_DOCK_BADGE_TEXT);
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

    void cleanupStaleWorkingCopyDirectories()
        .then((result) => {
            if (result.removedDirectories > 0 || result.removedOcrDirectories > 0) {
                logger.info(
                    `Removed stale working-copy directories: work=${result.removedDirectories}, ocr=${result.removedOcrDirectories}`,
                );
            }
        })
        .catch((error) => {
            logger.warn(`Failed to cleanup stale working-copy directories: ${error instanceof Error ? error.message : String(error)}`);
        });

    ipcMain.on('app:rendererReady', (event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) {
            return;
        }

        markWindowRendererReady(window.id);
        readyWindowIds.add(window.id);
        markWindowTabTransferReady(window.id);

        externalOpenManager.scheduleFlushPendingFiles();
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
        if (shutdownCoordinator.isQuittingAfterCleanup() || shutdownCoordinator.isFatalShutdownInProgress()) {
            return;
        }
        event.preventDefault();
        shutdownCoordinator.requestGracefulQuit();
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
        externalOpenManager.scheduleFlushPendingFiles();
    });

    externalOpenManager.markBootstrapReady();
    readyWindowIds.clear();
    logStartupPhase('Creating main window');
    await createWindow({ waitForInitialRendererReady: true });
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
    shutdownCoordinator.requestFatalShutdown(`Application bootstrap failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
});
