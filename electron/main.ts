import {
    app,
    BrowserWindow,
} from 'electron';
import type { IAppUpdateStatus } from '@contracts/electronApiUpdates';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import {
    createExternalOpenManager,
    createMacOpenFileRouter,
} from '@electron/bootstrap/externalOpen';
import { runInitSequence } from '@electron/bootstrap/initSequence';
import {
    resolveExternalOpenDispatchWindow,
    shouldResetRendererReadyOnNavigation,
} from '@electron/bootstrap/rendererReady';
import {
    createShutdownCoordinator,
    runShutdownSteps,
} from '@electron/bootstrap/shutdown';
import { createStartupTrace } from '@electron/bootstrap/startupTrace';
import { config } from '@electron/config';
import {
    registerIpcHandlers,
    clearAllWorkingCopies,
    cleanupStaleWorkingCopyDirectories,
} from '@electron/ipc';
import { allowOpenPaths } from '@electron/ipc/openPathCapabilities';
import {
    attachHostEnvironmentToWindow,
    installHostEnvironmentDisplayWatcher,
} from '@electron/hostEnvironment';
import {
    sendToWindow,
    setupMenu,
} from '@electron/menu';
import { initRecentFilesCache } from '@electron/recentFiles';
import {
    performDjvuViewingShutdownCleanup,
    shutdownDjvuConversions,
} from '@electron/features/djvu/public';
import { shutdownOcrJobManager } from '@electron/ocr/jobManager';
import {
    createWindow,
    getAllAppWindows,
    getMainWindow,
    hasWindows,
} from '@electron/window';
import { markWindowRendererReady } from '@electron/window/rendererReady';
import {
    markWindowTabTransferReady,
    markWindowTabTransferWindowClosed,
} from '@electron/windowTabTransfer';
import { promptSetDefaultViewer } from '@electron/defaultViewer';
import { createLogger } from '@electron/utils/logger';
import { sweepStaleDefaultAppTempPdfs } from '@electron/features/documents/public';
import {
    initializeUpdates,
    shutdownUpdates,
} from '@electron/updates';
import { getErrorMessage } from '@electron/utils/error';
import {
    registerAppProtocolScheme,
    setupAppProtocolHandler,
} from '@electron/protocol';

app.setName(app.isPackaged ? 'EVB Viewer' : 'EVB Viewer Dev');
registerAppProtocolScheme();
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
let shutdownCoordinator: ReturnType<typeof createShutdownCoordinator> | null = null;

function requestFatalShutdown(reason: string) {
    if (!shutdownCoordinator) {
        logger.error(reason);
        app.exit(1);
        return;
    }
    shutdownCoordinator.requestFatalShutdown(reason);
}

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
    requestFatalShutdown('Unhandled promise rejection requires fatal shutdown');
});
process.on('uncaughtException', (error) => {
    requestFatalShutdown(`Uncaught exception in main process: ${error.stack ?? error.message}`);
});

if (process.platform === 'darwin' && config.automation.noFocus) {
    try {
        // Keep automation sessions from becoming the active foreground app on macOS.
        app.setActivationPolicy('accessory');
    } catch (error) {
        logger.warn(
            `Failed to switch activation policy for automation mode: ${
                getErrorMessage(error)
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
        const window = resolveExternalOpenDispatchWindow({
            mainWindow: getMainWindow(),
            focusedWindow: BrowserWindow.getFocusedWindow(),
        });
        if (!window) {
            return false;
        }

        allowOpenPaths(paths, window.webContents);
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
    shutdownCoordinator?.clearGracefulQuitForceTimer();

    await runShutdownSteps(logger, [
        {
            label: 'updates',
            run: () => shutdownUpdates(),
        },
        {
            label: 'djvu-conversions',
            run: () => shutdownDjvuConversions(),
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
    ]);
}

shutdownCoordinator = createShutdownCoordinator({
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

void runInitSequence({
    app,
    aboutIconPath,
    allowMultipleAutomationSessions,
    allowOpenPaths,
    attachHostEnvironmentToWindow,
    broadcastUpdateStatus,
    cleanupStaleWorkingCopyDirectories,
    createWindow,
    devDockBadgeText: DEV_DOCK_BADGE_TEXT,
    devDockIconPath,
    externalOpenManager,
    focusMainWindow,
    getMainWindow,
    getWindowFromWebContents: BrowserWindow.fromWebContents,
    hasWindows,
    initRecentFilesCache,
    initializeUpdates,
    installHostEnvironmentDisplayWatcher,
    logger,
    logStartupPhase,
    markWindowRendererReady,
    markWindowTabTransferReady,
    markWindowTabTransferWindowClosed,
    maybePromptForDefaultViewer,
    readyWindowIds,
    registerIpcHandlers,
    setupAppProtocolHandler,
    setupMenu,
    shouldResetRendererReadyOnNavigation,
    shutdownCoordinator,
    sweepStaleDefaultAppTempPdfs,
}).catch((error) => {
    requestFatalShutdown(`Application bootstrap failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
});
